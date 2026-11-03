import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import type { Db } from './client.ts'
import { assets as assetsTable, userAssets } from './schema/index.ts'
import { getAssetWithDeck } from './assets.ts'
import { AssetError, copyAssetToDeck, createUserAsset, deleteUserAsset, getUserAsset, listUserAssets, storeDeckAsset, USER_ASSET_MAX_BYTES, USER_ASSET_MAX_COUNT } from './user-assets.ts'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

let db: Db | null = null
const userIds: string[] = []

/** An in-memory stand-in for StorageDriver: the same put, get and delete, keyed by string. */
function memoryStorage() {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    async put(key: string, data: Uint8Array) {
      objects.set(key, data)
    },
    async get(key: string) {
      return objects.get(key) ?? null
    },
    async delete(key: string) {
      objects.delete(key)
    },
  }
}

beforeAll(async () => {
  db = await connectOrNull()
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
})

describe('user image library (real Postgres)', () => {
  it('creates a library image, stores its bytes under library/<id>, and lists it newest first', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'lib-create')
    userIds.push(owner.id)
    const storage = memoryStorage()
    const first = await createUserAsset(db, storage, { ownerId: owner.id, name: '  Logo  ', mime: 'image/png', bytes: PNG })
    expect(first).toMatchObject({ name: 'Logo', mime: 'image/png', bytes: PNG.byteLength, width: 1, height: 1 })
    expect(storage.objects.get(`library/${first.id}`)).toEqual(PNG)
    const second = await createUserAsset(db, storage, { ownerId: owner.id, name: '', mime: 'image/png', bytes: PNG })
    expect(second.name).toBe('Untitled image')
    const listed = await listUserAssets(db, owner.id)
    expect(listed.map((a) => a.id)).toEqual([second.id, first.id])
    expect(listed[0]).not.toHaveProperty('storageKey')
  })

  it('a library image is only visible to its owner', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'lib-owner')
    const other = await makeUser(db, 'lib-other')
    userIds.push(owner.id, other.id)
    const storage = memoryStorage()
    const image = await createUserAsset(db, storage, { ownerId: owner.id, name: 'Mine', mime: 'image/png', bytes: PNG })
    expect(await getUserAsset(db, owner.id, image.id)).toMatchObject({ id: image.id, name: 'Mine' })
    expect(await getUserAsset(db, other.id, image.id)).toBeNull()
    expect(await getUserAsset(db, owner.id, 'not-a-uuid')).toBeNull()
    expect(await listUserAssets(db, other.id)).toEqual([])
  })

  it('copies a library image into a deck: the deck asset is readable with the right deckId', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'lib-copy')
    userIds.push(owner.id)
    const deckId = await makeDeck(db, owner.id, 'Copy target')
    const storage = memoryStorage()
    const image = await createUserAsset(db, storage, { ownerId: owner.id, name: 'Logo', mime: 'image/png', bytes: PNG })
    const copied = await copyAssetToDeck(db, storage, { source: { kind: 'library', ownerId: owner.id, id: image.id }, deckId, ownerId: owner.id })
    expect(copied.url).toBe(`/api/assets/${copied.id}`)
    expect(copied.id).not.toBe(image.id)
    const row = await getAssetWithDeck(db, copied.id)
    expect(row).toMatchObject({ id: copied.id, deckId, ownerId: owner.id, mime: 'image/png', bytes: PNG.byteLength })
    expect(storage.objects.get(copied.id)).toEqual(PNG)
  })

  it('another user cannot copy someone else’s library image (not found)', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'lib-src')
    const thief = await makeUser(db, 'lib-thief')
    userIds.push(owner.id, thief.id)
    const deckId = await makeDeck(db, thief.id, 'Thief deck')
    const storage = memoryStorage()
    const image = await createUserAsset(db, storage, { ownerId: owner.id, name: 'Private', mime: 'image/png', bytes: PNG })
    await expect(
      copyAssetToDeck(db, storage, { source: { kind: 'library', ownerId: thief.id, id: image.id }, deckId, ownerId: thief.id }),
    ).rejects.toMatchObject({ name: 'AssetError', code: 'not-found' })
  })

  it('copies a deck image into another deck', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'deck-copy')
    userIds.push(owner.id)
    const deckA = await makeDeck(db, owner.id, 'Deck A')
    const deckB = await makeDeck(db, owner.id, 'Deck B')
    const storage = memoryStorage()
    const original = await storeDeckAsset(db, storage, { deckId: deckA, ownerId: owner.id, mime: 'image/png', bytes: PNG })
    expect(original).toMatchObject({ width: 1, height: 1 })
    const copied = await copyAssetToDeck(db, storage, { source: { kind: 'deck', assetId: original.id }, deckId: deckB, ownerId: owner.id })
    expect((await getAssetWithDeck(db, copied.id))?.deckId).toBe(deckB)
    expect((await getAssetWithDeck(db, original.id))?.deckId).toBe(deckA)
  })

  it('refuses a non-image, mismatched bytes, an empty file, and a file over the library size cap', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'lib-refuse')
    userIds.push(owner.id)
    const storage = memoryStorage()
    const input = { ownerId: owner.id, name: 'x', mime: 'image/png', bytes: PNG }
    await expect(createUserAsset(db, storage, { ...input, mime: 'text/plain' })).rejects.toMatchObject({ code: 'type' })
    await expect(createUserAsset(db, storage, { ...input, bytes: new TextEncoder().encode('not a png') })).rejects.toMatchObject({ code: 'mismatch' })
    await expect(createUserAsset(db, storage, { ...input, bytes: new Uint8Array() })).rejects.toMatchObject({ code: 'empty' })
    const big = new Uint8Array(USER_ASSET_MAX_BYTES + 1)
    big.set(PNG.subarray(0, 8))
    const tooBig = createUserAsset(db, storage, { ...input, bytes: big })
    await expect(tooBig).rejects.toBeInstanceOf(AssetError)
    await expect(tooBig).rejects.toThrow('Images are limited to 5 MB')
    expect(storage.objects.size).toBe(0)
  })

  it('refuses the 201st library image with a clear message, and writes nothing', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'lib-full')
    userIds.push(owner.id)
    await db.insert(userAssets).values(
      Array.from({ length: USER_ASSET_MAX_COUNT }, (_, i) => ({
        ownerId: owner.id,
        name: `fill ${i}`,
        mime: 'image/png',
        bytes: PNG.byteLength,
        sha256: '0'.repeat(64),
        storageKey: `library/${randomUUID()}`,
      })),
    )
    const storage = memoryStorage()
    const attempt = createUserAsset(db, storage, { ownerId: owner.id, name: 'one too many', mime: 'image/png', bytes: PNG })
    await expect(attempt).rejects.toMatchObject({ code: 'limit' })
    await expect(attempt).rejects.toThrow(/library is full \(200 images\)/)
    expect(storage.objects.size).toBe(0)
  })

  it('removes the bytes when the row cannot be written, so no file is left without a row', async (ctx) => {
    if (!db) return ctx.skip()
    const storage = memoryStorage()
    // The owner does not exist, so the insert fails on the foreign key after the bytes are stored.
    await expect(createUserAsset(db, storage, { ownerId: `missing-${randomUUID()}`, name: 'Orphan', mime: 'image/png', bytes: PNG })).rejects.toThrow()
    expect(storage.objects.size).toBe(0)
  })

  it('deletes a library image and its bytes, only for the owner', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'lib-delete')
    const other = await makeUser(db, 'lib-delete-other')
    userIds.push(owner.id, other.id)
    const storage = memoryStorage()
    const image = await createUserAsset(db, storage, { ownerId: owner.id, name: 'Bin me', mime: 'image/png', bytes: PNG })
    expect(await deleteUserAsset(db, storage, other.id, image.id)).toBe(false)
    expect(await getUserAsset(db, owner.id, image.id)).not.toBeNull()
    expect(await deleteUserAsset(db, storage, owner.id, image.id)).toBe(true)
    expect(await getUserAsset(db, owner.id, image.id)).toBeNull()
    expect(storage.objects.has(`library/${image.id}`)).toBe(false)
  })

  it('a deck asset keeps its width and height in the row', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'deck-size')
    userIds.push(owner.id)
    const deckId = await makeDeck(db, owner.id, 'Sized')
    const storage = memoryStorage()
    const stored = await storeDeckAsset(db, storage, { deckId, ownerId: owner.id, mime: 'image/png', bytes: PNG })
    const [row] = await db.select().from(assetsTable).where(eq(assetsTable.id, stored.id))
    expect(row).toMatchObject({ width: 1, height: 1 })
    expect(stored.url).toBe(`/api/assets/${stored.id}`)
  })
})

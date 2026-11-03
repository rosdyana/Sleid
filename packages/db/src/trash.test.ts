import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import type { Db } from './client.ts'
import { insertAsset } from './assets.ts'
import { getDeckRole } from './deck-access.ts'
import { assets, decks, deckMembers, exportJobs } from './schema/index.ts'
import { listTrashedDecks, purgeDeck, restoreDeck, trashDeck } from './trash.ts'

let db: Db | null = null
const userIds: string[] = []
let ownerId = ''
let editorId = ''
let deckId = ''

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  const owner = await makeUser(db, 'trash-owner')
  const editor = await makeUser(db, 'trash-editor')
  userIds.push(owner.id, editor.id)
  ownerId = owner.id
  editorId = editor.id
  deckId = await makeDeck(db, owner.id, 'Trash test')
  await db.insert(deckMembers).values({ deckId, userId: editor.id, role: 'editor', via: 'invite' })
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
})

describe('deck trash (real Postgres)', () => {
  it('a non-owner editor cannot trash the deck', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await trashDeck(db, editorId, deckId)).toBe(false)
    expect(await getDeckRole(db, editorId, deckId)).toBe('editor')
  })

  it('the owner trashes the deck, and member queries no longer see it', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await trashDeck(db, ownerId, deckId)).toBe(true)
    expect(await getDeckRole(db, ownerId, deckId)).toBeNull()
    expect(await getDeckRole(db, editorId, deckId)).toBeNull()
  })

  it('trashing twice changes nothing', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await trashDeck(db, ownerId, deckId)).toBe(false)
  })

  it('a non-owner cannot restore the deck', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await restoreDeck(db, editorId, deckId)).toBe(false)
    expect(await getDeckRole(db, editorId, deckId)).toBeNull()
  })

  it('the owner restores the deck, and it is visible again', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await restoreDeck(db, ownerId, deckId)).toBe(true)
    expect(await getDeckRole(db, ownerId, deckId)).toBe('owner')
    expect(await getDeckRole(db, editorId, deckId)).toBe('editor')
  })

  it('restoring a deck that is not in the trash changes nothing', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await restoreDeck(db, ownerId, deckId)).toBe(false)
  })

  it('a stranger with no membership cannot trash or restore', async (ctx) => {
    if (!db) return ctx.skip()
    const stranger = await makeUser(db, 'trash-stranger')
    userIds.push(stranger.id)
    expect(await trashDeck(db, stranger.id, deckId)).toBe(false)
    expect(await restoreDeck(db, stranger.id, deckId)).toBe(false)
  })
})

describe('deck list and permanent delete (real Postgres)', () => {
  let ownerA = ''
  let editorB = ''
  let olderTrash = ''
  let newerTrash = ''
  let liveDeck = ''
  let purgeTarget = ''
  let purgeAssetId = ''

  beforeAll(async () => {
    if (!db) return
    const a = await makeUser(db, 'purge-owner')
    const b = await makeUser(db, 'purge-editor')
    userIds.push(a.id, b.id)
    ownerA = a.id
    editorB = b.id
    olderTrash = await makeDeck(db, ownerA, 'Older trashed')
    newerTrash = await makeDeck(db, ownerA, 'Newer trashed')
    liveDeck = await makeDeck(db, ownerA, 'Live deck')
    await db.update(decks).set({ deletedAt: new Date('2026-01-01T00:00:00Z') }).where(eq(decks.id, olderTrash))
    await db.update(decks).set({ deletedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(decks.id, newerTrash))
    // Trashed by the owner, with the editor as a member: the editor's own list must stay empty.
    const sharedTrash = await makeDeck(db, ownerA, 'Shared trashed')
    await db.insert(deckMembers).values({ deckId: sharedTrash, userId: editorB, role: 'editor', via: 'invite' })
    await db.update(decks).set({ deletedAt: new Date() }).where(eq(decks.id, sharedTrash))

    purgeTarget = await makeDeck(db, ownerA, 'Purge target')
    await db.insert(deckMembers).values({ deckId: purgeTarget, userId: editorB, role: 'editor', via: 'invite' })
    purgeAssetId = randomUUID()
    await insertAsset(db, { id: purgeAssetId, deckId: purgeTarget, ownerId: ownerA, mime: 'image/png', bytes: 10, sha256: 'abc' })
    // A finished export (file stored outside assets) and an unfinished one (no file yet).
    await db.insert(exportJobs).values({ deckId: purgeTarget, userId: ownerA, format: 'pdf', status: 'done', fileKey: `exports/${purgeTarget}/done.pdf` })
    await db.insert(exportJobs).values({ deckId: purgeTarget, userId: ownerA, format: 'pdf', status: 'queued' })
    await db.update(decks).set({ deletedAt: new Date() }).where(eq(decks.id, purgeTarget))
  })

  it('lists only the caller-owned trashed decks, newest deletion first', async (ctx) => {
    if (!db) return ctx.skip()
    const rows = await listTrashedDecks(db, ownerA)
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([olderTrash, newerTrash]))
    expect(rows.find((r) => r.id === liveDeck)).toBeUndefined()
    const older = rows.findIndex((r) => r.id === olderTrash)
    const newer = rows.findIndex((r) => r.id === newerTrash)
    expect(newer).toBeLessThan(older)
    expect(rows[newer]).toEqual({ id: newerTrash, title: 'Newer trashed', deletedAt: new Date('2026-02-01T00:00:00Z') })
  })

  it('an editor has no trash list of their own', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await listTrashedDecks(db, editorB)).toEqual([])
  })

  it('refuses to purge a live deck', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await purgeDeck(db, ownerA, liveDeck)).toEqual({ ok: false, reason: 'not-in-trash', assetIds: [], exportKeys: [] })
    const [row] = await db.select({ id: decks.id }).from(decks).where(eq(decks.id, liveDeck))
    expect(row?.id).toBe(liveDeck)
  })

  it('refuses to purge for a non-owner, and leaves the deck alone', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await purgeDeck(db, editorB, purgeTarget)).toEqual({ ok: false, reason: 'not-owner', assetIds: [], exportKeys: [] })
    const [row] = await db.select({ id: decks.id }).from(decks).where(eq(decks.id, purgeTarget))
    expect(row?.id).toBe(purgeTarget)
  })

  it('purges a trashed deck: removes the deck, its members, asset and export rows, and returns the stored files', async (ctx) => {
    if (!db) return ctx.skip()
    expect(await purgeDeck(db, ownerA, purgeTarget)).toEqual({ ok: true, assetIds: [purgeAssetId], exportKeys: [`exports/${purgeTarget}/done.pdf`] })
    expect(await db.select({ id: exportJobs.id }).from(exportJobs).where(eq(exportJobs.deckId, purgeTarget))).toEqual([])
    expect(await db.select({ id: decks.id }).from(decks).where(eq(decks.id, purgeTarget))).toEqual([])
    expect(await db.select({ userId: deckMembers.userId }).from(deckMembers).where(eq(deckMembers.deckId, purgeTarget))).toEqual([])
    expect(await db.select({ id: assets.id }).from(assets).where(eq(assets.deckId, purgeTarget))).toEqual([])
    // The owner's membership went with the deck, so a second purge is refused as not-owner.
    expect(await purgeDeck(db, ownerA, purgeTarget)).toEqual({ ok: false, reason: 'not-owner', assetIds: [], exportKeys: [] })
  })
})

// createImportedDeck against real Postgres: a failed transaction must not leave stored images behind.
// Skips with a message when the database is unreachable.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDeck, type Deck } from '@sleid/model'
import { connectOrNull, makeUser, removeUsers } from '@sleid/db/testing'
import { eq } from 'drizzle-orm'
import { createImportedDeck, storeDataImages } from './import-deck.ts'
import { assets as assetsTable } from './schema/index.ts'
import type { Db } from './client.ts'

// A 1 x 1 transparent PNG.
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let db: Db | null = null
const userIds: string[] = []

beforeAll(async () => {
  db = await connectOrNull()
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
})

/** A one-slide deck whose background is the PNG above, so the import has an image to store. */
function deckWithImage(): Deck {
  const deck = createDeck('Image deck')
  const slide = deck.slides[0]!
  return { ...deck, slides: [{ ...slide, background: { type: 'image', value: PNG_DATA_URL } }] }
}

describe('createImportedDeck (real Postgres)', () => {
  it('stores the image and keeps it when the deck is created', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'import-deck-ok')
    userIds.push(owner.id)
    const stored = new Map<string, Uint8Array>()
    const created = await createImportedDeck(db, {
      userId: owner.id,
      deck: deckWithImage(),
      storeAsset: async (id, bytes) => void stored.set(id, bytes),
      deleteAsset: async (id) => void stored.delete(id),
    })
    expect(created.droppedImages).toBe(0)
    expect(stored.size).toBe(1)
    const rows = await db.select().from(assetsTable).where(eq(assetsTable.deckId, created.id))
    expect(rows).toHaveLength(1)
    expect(stored.has(rows[0]!.id)).toBe(true)
  })

  it('deletes the stored images again when the transaction fails', async (ctx) => {
    if (!db) return ctx.skip()
    // No user row with this id, so the deck insert breaks the foreign key and the transaction rolls back.
    const missingUser = `missing-${randomUUID()}`
    const stored = new Map<string, Uint8Array>()
    const deleted: string[] = []
    await expect(
      createImportedDeck(db, {
        userId: missingUser,
        deck: deckWithImage(),
        storeAsset: async (id, bytes) => void stored.set(id, bytes),
        deleteAsset: async (id) => {
          deleted.push(id)
          stored.delete(id)
        },
      }),
    ).rejects.toThrow()
    expect(deleted).toHaveLength(1)
    expect(stored.size).toBe(0)
    const rows = await db.select().from(assetsTable).where(eq(assetsTable.ownerId, missingUser))
    expect(rows).toHaveLength(0)
  })
})

const SVG_SHAPE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'
const SVG_SCRIPT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
const dataUrl = (mime: string, text: string) => `data:${mime};base64,${Buffer.from(text).toString('base64')}`

/** A one-slide deck whose background is the given data URL. */
function deckWithBackground(src: string): Deck {
  const deck = createDeck('Background deck')
  const slide = deck.slides[0]!
  return { ...deck, slides: [{ ...slide, background: { type: 'image', value: src } }] }
}

describe('storeDataImages (no database)', () => {
  it('keeps an SVG data URL, stores it as image/svg+xml and points the slide at the asset', async () => {
    const stored: Array<{ id: string; mime: string }> = []
    const moved = await storeDataImages(deckWithBackground(dataUrl('image/svg+xml', SVG_SHAPE)), 'deck-1', 'user-1', async (id, _bytes, mime) => {
      stored.push({ id, mime })
    })
    expect(moved.dropped).toBe(0)
    expect(moved.rows).toHaveLength(1)
    expect(moved.rows[0]).toMatchObject({ deckId: 'deck-1', ownerId: 'user-1', mime: 'image/svg+xml' })
    expect(stored).toEqual([{ id: moved.rows[0]!.id, mime: 'image/svg+xml' }])
    expect(moved.slides[0]!.background).toMatchObject({ type: 'image', value: `/api/assets/${moved.rows[0]!.id}` })
  })

  it('drops an SVG with script and counts it, without storing anything', async () => {
    const stored: string[] = []
    const moved = await storeDataImages(deckWithBackground(dataUrl('image/svg+xml', SVG_SCRIPT)), 'deck-1', 'user-1', async (id) => {
      stored.push(id)
    })
    expect(moved.dropped).toBe(1)
    expect(moved.rows).toHaveLength(0)
    expect(stored).toHaveLength(0)
    expect(moved.slides[0]!.background).toBeUndefined()
  })

  it('drops a PNG data URL whose bytes are not a PNG', async () => {
    const moved = await storeDataImages(deckWithBackground(dataUrl('image/png', 'not a png')), 'deck-1', 'user-1', async () => undefined)
    expect(moved.dropped).toBe(1)
    expect(moved.rows).toHaveLength(0)
  })
})

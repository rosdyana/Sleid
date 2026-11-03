// createImportedDeck against real Postgres: a failed transaction must not leave stored images behind.
// Skips with a message when the database is unreachable.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDeck, type Deck } from '@sleid/model'
import { connectOrNull, makeUser, removeUsers } from '@sleid/db/testing'
import { eq } from 'drizzle-orm'
import { createImportedDeck } from './import-deck.ts'
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

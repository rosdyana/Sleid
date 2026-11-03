import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { findPublishedDeck, getPublishState, setPublished } from './publish.ts'
import { decks } from './schema/index.ts'
import { eq } from 'drizzle-orm'
import type { Db } from './client.ts'

let db: Db | null = null
const userIds: string[] = []
let deckId = ''

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  const owner = await makeUser(db, 'publish-owner')
  userIds.push(owner.id)
  deckId = await makeDeck(db, owner.id, 'Publish test')
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
})

describe('publish to web (real Postgres)', () => {
  it('publishing issues a token; republishing keeps it; unpublishing clears it', async (ctx) => {
    if (!db) return ctx.skip()
    expect((await getPublishState(db, deckId))!.published).toBe(false)
    const first = await setPublished(db, deckId, { published: true })
    expect(first.published).toBe(true)
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const again = await setPublished(db, deckId, { published: true })
    expect(again.token).toBe(first.token)

    expect(await findPublishedDeck(db, first.token!)).toEqual({ deckId, indexable: false })
    const off = await setPublished(db, deckId, { published: false })
    expect(off.token).toBeNull()
    expect(await findPublishedDeck(db, first.token!)).toBeNull()

    const on = await setPublished(db, deckId, { published: true })
    expect(on.token).not.toBe(first.token)
  })

  it('indexing is opt-in and stored with the deck', async (ctx) => {
    if (!db) return ctx.skip()
    const state = await setPublished(db, deckId, { published: true, indexable: true })
    expect(state.indexable).toBe(true)
    const token = state.token!
    expect(await findPublishedDeck(db, token)).toEqual({ deckId, indexable: true })
    await setPublished(db, deckId, { published: true, indexable: false })
    expect((await findPublishedDeck(db, token))?.indexable).toBe(false)
  })

  it('a deleted deck is not reachable by its token, and short or unknown tokens find nothing', async (ctx) => {
    if (!db) return ctx.skip()
    const { token } = await setPublished(db, deckId, { published: true })
    await db.update(decks).set({ deletedAt: new Date() }).where(eq(decks.id, deckId))
    expect(await findPublishedDeck(db, token!)).toBeNull()
    await db.update(decks).set({ deletedAt: null }).where(eq(decks.id, deckId))
    expect(await findPublishedDeck(db, 'short')).toBeNull()
    expect(await findPublishedDeck(db, 'x'.repeat(40))).toBeNull()
  })
})

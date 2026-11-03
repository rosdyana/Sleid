import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createDeck, deckToYDoc, type Deck } from '@sleid/model'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { deckSnapshots } from './schema/index.ts'
import { readDeck } from './deck-read.ts'
import type { Db } from './client.ts'

let db: Db | null = null
const userIds: string[] = []
let deckId = ''

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  const owner = await makeUser(db, 'read-owner')
  userIds.push(owner.id)
  deckId = await makeDeck(db, owner.id, 'Saved title')
  const saved: Deck = { ...createDeck('Saved title'), id: deckId }
  await db.insert(deckSnapshots).values({ deckId, ydoc: Buffer.from(Y.encodeStateAsUpdate(deckToYDoc(saved))) })
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
})

describe('readDeck', () => {
  it('reads the live deck when the collab service answers', async (ctx) => {
    if (!db) return ctx.skip()
    const live: Deck = { ...createDeck('Live title'), id: deckId }
    const seen: string[] = []
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url), String((init?.headers as Record<string, string>)['x-sleid-internal']))
      return Response.json(live)
    }) as typeof fetch
    const result = await readDeck(db, deckId, { live: { baseUrl: 'http://collab.test/', secret: 's3cret', fetch: fetchStub } })
    expect(result.source).toBe('live')
    expect(result.deck.title).toBe('Live title')
    expect(seen).toEqual([`http://collab.test/internal/decks/${deckId}/json`, 's3cret'])
  })

  it('falls back to the saved state when the collab service is down, and says why', async (ctx) => {
    if (!db) return ctx.skip()
    const reasons: unknown[] = []
    const down = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await readDeck(db, deckId, {
      live: { baseUrl: 'http://127.0.0.1:9', secret: 'x', fetch: down },
      onFallback: (reason) => reasons.push(reason),
    })
    expect(result.source).toBe('database')
    expect(result.deck.title).toBe('Saved title')
    expect(String(reasons[0])).toContain('ECONNREFUSED')
  })

  it('treats a non-200 from the collab service as down', async (ctx) => {
    if (!db) return ctx.skip()
    const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    const result = await readDeck(db, deckId, { live: { baseUrl: 'http://collab.test', secret: 'x', fetch: notFound } })
    expect(result.source).toBe('database')
  })
})

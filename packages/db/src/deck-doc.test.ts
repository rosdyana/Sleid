// Real Postgres (compose 127.0.0.1:5433). Skips with a message when unreachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyOps, yDocToDeck } from '@sleid/model'
import { count, eq } from 'drizzle-orm'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { appendDeckUpdate, copyDeck, COMPACT_THRESHOLD, loadDeckState } from './deck-doc.ts'
import { deckSnapshots, deckUpdates, decks } from './schema/index.ts'
import type { Db } from './client.ts'

let db: Db | null = null
let userIds: string[] = []
let deckId = ''
let ownerId = ''

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  const owner = await makeUser(db, 'doc-owner')
  ownerId = owner.id
  userIds = [owner.id]
  deckId = await makeDeck(db, owner.id, 'Doc test')
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
})

async function counts(id: string) {
  const [snap] = await db!.select({ n: count() }).from(deckSnapshots).where(eq(deckSnapshots.deckId, id))
  const [upd] = await db!.select({ n: count() }).from(deckUpdates).where(eq(deckUpdates.deckId, id))
  return { snapshots: Number(snap?.n ?? 0), updates: Number(upd?.n ?? 0) }
}

describe('deck-doc persistence (real Postgres)', () => {
  it('creates the first snapshot from the deck row, then returns the same state', async (ctx) => {
    if (!db) return ctx.skip()
    const first = await loadDeckState(db, deckId)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, first)
    expect(yDocToDeck(doc)).toMatchObject({ id: deckId, title: 'Doc test' })
    expect(await counts(deckId)).toEqual({ snapshots: 1, updates: 0 })

    const second = await loadDeckState(db, deckId)
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true)
    expect(await counts(deckId)).toEqual({ snapshots: 1, updates: 0 })
  })

  it('appends updates, keeps decks.title in step, and merges them on load', async (ctx) => {
    if (!db) return ctx.skip()
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await loadDeckState(db, deckId))
    const updates: Uint8Array[] = []
    doc.on('update', (u: Uint8Array) => updates.push(u))
    const slideId = yDocToDeck(doc).slides[0]!.id
    applyOps(doc, [{ op: 'setTitle', title: 'Renamed' }, { op: 'setNotes', slideId, notes: 'hello' }], 'local')
    applyOps(doc, [{ op: 'addSlide', layout: 'blank', slide: { id: 'extra' } }], 'local')

    for (const u of updates) await appendDeckUpdate(db, deckId, u, yDocToDeck(doc).title)
    expect(await counts(deckId)).toEqual({ snapshots: 1, updates: 2 })

    const [row] = await db.select({ title: decks.title }).from(decks).where(eq(decks.id, deckId))
    expect(row?.title).toBe('Renamed')

    const loaded = new Y.Doc()
    Y.applyUpdate(loaded, await loadDeckState(db, deckId))
    expect(yDocToDeck(loaded)).toEqual(yDocToDeck(doc))
  })

  it('compacts once the log passes the threshold: one new snapshot, no update rows left', async (ctx) => {
    if (!db) return ctx.skip()
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await loadDeckState(db, deckId))
    const slideId = yDocToDeck(doc).slides[0]!.id
    const updates: Uint8Array[] = []
    doc.on('update', (u: Uint8Array) => updates.push(u))
    // Start from 2 updates already in the log, then push one more than the threshold allows.
    for (let i = 0; i < COMPACT_THRESHOLD + 1 - 2; i++) {
      applyOps(doc, [{ op: 'setNotes', slideId, notes: `n${i}` }], 'local')
    }
    const before = await counts(deckId)
    const toPush = updates.slice(0, COMPACT_THRESHOLD + 1 - before.updates)
    for (const u of toPush) await appendDeckUpdate(db, deckId, u, 'Renamed')

    expect(await counts(deckId)).toEqual({ snapshots: before.snapshots + 1, updates: 0 })
    const loaded = new Y.Doc()
    Y.applyUpdate(loaded, await loadDeckState(db, deckId))
    expect(yDocToDeck(loaded).slides[0]!.notes).toBe(`n${COMPACT_THRESHOLD - 2}`)
  }, 120_000)

  it('copyDeck makes a new deck with the same slides and its own id', async (ctx) => {
    if (!db) return ctx.skip()
    const copy = await copyDeck(db, ownerId, deckId)
    expect(copy.id).not.toBe(deckId)
    const source = new Y.Doc()
    Y.applyUpdate(source, await loadDeckState(db, deckId))
    const copied = new Y.Doc()
    Y.applyUpdate(copied, await loadDeckState(db, copy.id))
    expect(yDocToDeck(copied).id).toBe(copy.id)
    expect(yDocToDeck(copied).title).toMatch(/^Copy of /)
    expect(yDocToDeck(copied).slides.map((s) => s.id)).toEqual(yDocToDeck(source).slides.map((s) => s.id))
  })
})

// Runs against the local compose Postgres (DATABASE_URL, default 127.0.0.1:5433).
// If the database cannot be reached, every case is skipped with a message.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

process.env.DATABASE_URL ??= 'postgres://sleid:sleid@127.0.0.1:5433/sleid'

type Db = typeof import('~/db/client').db
let db: Db
let reachable = false
let userId = ''
let deckId = ''

beforeAll(async () => {
  try {
    const client = await import('~/db/client')
    db = client.db
    const { sql } = await import('drizzle-orm')
    await db.execute(sql`select 1`)
    reachable = true
  } catch (err) {
    console.warn(`[deck-doc.server.test] skipped: database not reachable (${err instanceof Error ? err.message : err})`)
  }
})

async function fixtures() {
  const schema = await import('~/db/schema')
  userId = `test-${randomUUID()}`
  await db.insert(schema.user).values({ id: userId, name: 'Doc Test', email: `${userId}@example.com` })
  const [deck] = await db
    .insert(schema.decks)
    .values({ ownerId: userId, title: 'Doc test' })
    .returning({ id: schema.decks.id })
  deckId = deck!.id
  await db.insert(schema.deckMembers).values({ deckId, userId, role: 'owner' })
  return schema
}

afterAll(async () => {
  if (!reachable) return
  const schema = await import('~/db/schema')
  const { eq } = await import('drizzle-orm')
  await db.delete(schema.user).where(eq(schema.user.id, userId)) // cascades to decks, members, snapshots, updates
})

async function counts(id: string) {
  const { count, eq } = await import('drizzle-orm')
  const schema = await import('~/db/schema')
  const [snap] = await db.select({ n: count() }).from(schema.deckSnapshots).where(eq(schema.deckSnapshots.deckId, id))
  const [upd] = await db.select({ n: count() }).from(schema.deckUpdates).where(eq(schema.deckUpdates.deckId, id))
  return { snapshots: Number(snap?.n ?? 0), updates: Number(upd?.n ?? 0) }
}

describe('deck-doc.server (real Postgres)', () => {
  it('creates the first snapshot from the deck row, then returns the same state', async (ctx) => {
    if (!reachable) return ctx.skip()
    await fixtures()
    const { loadDeckState } = await import('~/lib/deck-doc.server')
    const { yDocToDeck } = await import('@sleid/model')

    const first = await loadDeckState(deckId)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, first)
    expect(yDocToDeck(doc)).toMatchObject({ id: deckId, title: 'Doc test' })
    expect(await counts(deckId)).toEqual({ snapshots: 1, updates: 0 })

    const second = await loadDeckState(deckId)
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true)
    expect(await counts(deckId)).toEqual({ snapshots: 1, updates: 0 })
  })

  it('appends updates, keeps decks.title in step, and merges them on load', async (ctx) => {
    if (!reachable) return ctx.skip()
    const { loadDeckState, appendDeckUpdate } = await import('~/lib/deck-doc.server')
    const { applyOps, yDocToDeck } = await import('@sleid/model')
    const schema = await import('~/db/schema')
    const { eq } = await import('drizzle-orm')

    const doc = new Y.Doc()
    Y.applyUpdate(doc, await loadDeckState(deckId))
    const updates: Uint8Array[] = []
    doc.on('update', (u: Uint8Array) => updates.push(u))
    const slideId = yDocToDeck(doc).slides[0]!.id
    applyOps(doc, [{ op: 'setTitle', title: 'Renamed' }, { op: 'setNotes', slideId, notes: 'hello' }], 'local')
    applyOps(doc, [{ op: 'addSlide', layout: 'blank', slide: { id: 'extra' } }], 'local')

    for (const u of updates) await appendDeckUpdate(deckId, u, yDocToDeck(doc).title)
    expect(await counts(deckId)).toEqual({ snapshots: 1, updates: 2 })

    const [row] = await db.select({ title: schema.decks.title }).from(schema.decks).where(eq(schema.decks.id, deckId))
    expect(row?.title).toBe('Renamed')

    const loaded = new Y.Doc()
    Y.applyUpdate(loaded, await loadDeckState(deckId))
    expect(yDocToDeck(loaded)).toEqual(yDocToDeck(doc))
  })

  it('compacts once the log passes the threshold: one new snapshot, no update rows left', async (ctx) => {
    if (!reachable) return ctx.skip()
    const { loadDeckState, appendDeckUpdate, COMPACT_THRESHOLD } = await import('~/lib/deck-doc.server')
    const { applyOps, yDocToDeck } = await import('@sleid/model')

    const doc = new Y.Doc()
    Y.applyUpdate(doc, await loadDeckState(deckId))
    const slideId = yDocToDeck(doc).slides[0]!.id
    const updates: Uint8Array[] = []
    doc.on('update', (u: Uint8Array) => updates.push(u))
    // Start from 2 updates already in the log, then push one more than the threshold allows.
    for (let i = 0; i < COMPACT_THRESHOLD + 1 - 2; i++) {
      applyOps(doc, [{ op: 'setNotes', slideId, notes: `n${i}` }], 'local')
    }
    const before = await counts(deckId)
    const toPush = updates.slice(0, COMPACT_THRESHOLD + 1 - before.updates)
    for (const u of toPush) await appendDeckUpdate(deckId, u, 'Renamed')

    expect(await counts(deckId)).toEqual({ snapshots: before.snapshots + 1, updates: 0 })
    const loaded = new Y.Doc()
    Y.applyUpdate(loaded, await loadDeckState(deckId))
    expect(yDocToDeck(loaded).slides[0]!.notes).toBe(`n${COMPACT_THRESHOLD - 2}`)
  }, 120_000)

  it('copyDeck makes a new deck with the same slides and its own id', async (ctx) => {
    if (!reachable) return ctx.skip()
    const { copyDeck, loadDeckState } = await import('~/lib/deck-doc.server')
    const { yDocToDeck } = await import('@sleid/model')

    const copy = await copyDeck(userId, deckId)
    expect(copy.id).not.toBe(deckId)
    const source = new Y.Doc()
    Y.applyUpdate(source, await loadDeckState(deckId))
    const copied = new Y.Doc()
    Y.applyUpdate(copied, await loadDeckState(copy.id))
    expect(yDocToDeck(copied).id).toBe(copy.id)
    expect(yDocToDeck(copied).title).toMatch(/^Copy of /)
    expect(yDocToDeck(copied).slides.map((s) => s.id)).toEqual(yDocToDeck(source).slides.map((s) => s.id))
  })
})

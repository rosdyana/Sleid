// Server-side deck document storage. Single-user for now (M1b). M2 swaps in
// Hocuspocus over the same tables.
//
// State of a deck = latest deck_snapshots row + every deck_updates row after it.
// Snapshots and updates are both Yjs updates, so Y.mergeUpdates folds them.
//
// Concurrency:
//   - Reads (loadDeckState) run in one REPEATABLE READ transaction, so a
//     compaction that commits mid-read cannot make the snapshot and the update
//     list disagree.
//   - Appends and compaction both update the decks row first. That row lock
//     serialises writers for one deck, so compaction sees every committed
//     update and nothing can be appended between its read and its delete.
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { createDeck, deckToYDoc, yDocToDeck } from '@sleid/model'
import { and, asc, count, desc, eq, isNull, lte } from 'drizzle-orm'
import { db } from '~/db/client'
import { decks, deckMembers, deckSnapshots, deckUpdates } from '~/db/schema'

/** Compact when the update log grows past this many rows. */
export const COMPACT_THRESHOLD = 200
/** Largest update a client may push, in bytes (before base64). */
export const MAX_UPDATE_BYTES = 2 * 1024 * 1024

type Db = typeof db
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Latest snapshot merged with every remaining update, or null when the deck has no snapshot yet. */
async function readStateTx(tx: Tx, deckId: string): Promise<Uint8Array | null> {
  const [snapshot] = await tx
    .select({ ydoc: deckSnapshots.ydoc })
    .from(deckSnapshots)
    .where(eq(deckSnapshots.deckId, deckId))
    .orderBy(desc(deckSnapshots.createdAt), desc(deckSnapshots.id))
    .limit(1)
  if (!snapshot) return null
  const updates = await tx
    .select({ update: deckUpdates.update })
    .from(deckUpdates)
    .where(eq(deckUpdates.deckId, deckId))
    .orderBy(asc(deckUpdates.id))
  return Y.mergeUpdates([snapshot.ydoc, ...updates.map((row) => row.update)])
}

/**
 * Current Yjs state of a deck. A deck with no snapshot yet gets one made from
 * its decks row (title), so the first open of a new deck creates its document.
 * The caller must already have checked the deck role.
 */
export async function loadDeckState(deckId: string): Promise<Uint8Array> {
  const existing = await db.transaction((tx) => readStateTx(tx, deckId), { isolationLevel: 'repeatable read' })
  if (existing) return existing

  return db.transaction(async (tx) => {
    // Lock the deck row so two first opens cannot both create a snapshot.
    const [deck] = await tx
      .select({ title: decks.title })
      .from(decks)
      .where(and(eq(decks.id, deckId), isNull(decks.deletedAt)))
      .limit(1)
      .for('update')
    if (!deck) throw new Error('Deck not found')

    const again = await readStateTx(tx, deckId)
    if (again) return again

    const state = Y.encodeStateAsUpdate(deckToYDoc({ ...createDeck(deck.title), id: deckId }))
    await tx.insert(deckSnapshots).values({ deckId, ydoc: Buffer.from(state) })
    return state
  })
}

/** Writes a new snapshot of everything and deletes the updates it folds in. Caller holds the deck row lock. */
async function compactTx(tx: Tx, deckId: string): Promise<void> {
  const [snapshot] = await tx
    .select({ ydoc: deckSnapshots.ydoc })
    .from(deckSnapshots)
    .where(eq(deckSnapshots.deckId, deckId))
    .orderBy(desc(deckSnapshots.createdAt), desc(deckSnapshots.id))
    .limit(1)
  if (!snapshot) throw new Error('deck has no snapshot to compact onto')
  const updates = await tx
    .select({ id: deckUpdates.id, update: deckUpdates.update })
    .from(deckUpdates)
    .where(eq(deckUpdates.deckId, deckId))
    .orderBy(asc(deckUpdates.id))
  const lastId = updates.at(-1)?.id
  if (lastId === undefined) return

  const merged = Y.mergeUpdates([snapshot.ydoc, ...updates.map((row) => row.update)])
  await tx.insert(deckSnapshots).values({ deckId, ydoc: Buffer.from(merged) })
  await tx.delete(deckUpdates).where(and(eq(deckUpdates.deckId, deckId), lte(deckUpdates.id, lastId)))
}

/**
 * Appends one update, keeps decks.title in step with the document title, and
 * compacts when the log is over COMPACT_THRESHOLD rows.
 */
export async function appendDeckUpdate(deckId: string, update: Uint8Array, title: string): Promise<{ compacted: boolean }> {
  return db.transaction(async (tx) => {
    const touched = await tx
      .update(decks)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(decks.id, deckId), isNull(decks.deletedAt)))
      .returning({ id: decks.id })
    if (touched.length === 0) throw new Error('Deck not found')

    await tx.insert(deckUpdates).values({ deckId, update: Buffer.from(update) })
    const [row] = await tx.select({ n: count() }).from(deckUpdates).where(eq(deckUpdates.deckId, deckId))
    if (Number(row?.n ?? 0) > COMPACT_THRESHOLD) {
      await compactTx(tx, deckId)
      return { compacted: true }
    }
    return { compacted: false }
  })
}

/** Copies a deck's current state into a new deck owned by `userId`. The caller must be able to view the source. */
export async function copyDeck(userId: string, sourceId: string): Promise<{ id: string }> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await loadDeckState(sourceId))
  const source = yDocToDeck(doc)

  const id = randomUUID()
  const title = `Copy of ${source.title}`.slice(0, 200)
  const state = Y.encodeStateAsUpdate(deckToYDoc({ ...source, id, title }))
  await db.transaction(async (tx) => {
    await tx.insert(decks).values({ id, ownerId: userId, title })
    await tx.insert(deckMembers).values({ deckId: id, userId, role: 'owner' })
    await tx.insert(deckSnapshots).values({ deckId: id, ydoc: Buffer.from(state), createdBy: userId })
  })
  return { id }
}

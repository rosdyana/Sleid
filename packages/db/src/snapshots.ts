// Version snapshots: writing checkpoints, naming versions, listing and reading them, and the retention policy.
//
// Every snapshot is a complete Yjs state of the deck at its time, so any one of them can be loaded on its own,
// and the newest one is what a load starts from (see deck-doc.ts). Retention therefore only has to answer one
// question: which snapshots are still worth keeping as history?
//
//   named       kept forever (a name is set, which includes "Before restore")
//   auto        all from the last 24 hours; then the newest per clock hour for 7 days; then the newest per day for 90 days
//   internal    first-open and compaction states: only the newest is kept (loads need it, history does not)
//
// The newest snapshot of any kind is always kept.
import * as Y from 'yjs'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { yDocToDeck, type Deck } from '@sleid/model'
import type { Db } from './client.ts'
import { decks, deckSnapshots, user } from './schema/index.ts'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
export const AUTO_ALL_MS = 24 * HOUR_MS
export const AUTO_HOURLY_MS = 7 * DAY_MS
export const AUTO_DAILY_MS = 90 * DAY_MS
export const BEFORE_RESTORE_NAME = 'Before restore'
/** Most recent editors recorded on an auto checkpoint. */
export const EDITORS_KEPT = 5

export type SnapshotKind = 'auto' | 'named' | 'internal'

export interface SnapshotMeta {
  id: string
  kind: SnapshotKind
  name: string | null
  createdAt: Date
}

/** Newest first, then by id, so ties have one order everywhere. */
function newestFirst<T extends { createdAt: Date; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** The ids of the snapshots the retention policy keeps. Pure: `now` is passed in. */
export function snapshotsToKeep(rows: readonly SnapshotMeta[], now: Date): Set<string> {
  const keep = new Set<string>()
  const ordered = newestFirst(rows)
  if (ordered[0]) keep.add(ordered[0].id)

  const hourly = new Set<number>()
  const daily = new Set<number>()
  const nowMs = now.getTime()
  for (const row of ordered) {
    if (row.name !== null || row.kind === 'named') {
      keep.add(row.id)
      continue
    }
    if (row.kind !== 'auto') continue
    const age = nowMs - row.createdAt.getTime()
    if (age <= AUTO_ALL_MS) keep.add(row.id)
    else if (age <= AUTO_HOURLY_MS) {
      const bucket = Math.floor(row.createdAt.getTime() / HOUR_MS)
      if (!hourly.has(bucket)) {
        hourly.add(bucket)
        keep.add(row.id)
      }
    } else if (age <= AUTO_DAILY_MS) {
      const bucket = Math.floor(row.createdAt.getTime() / DAY_MS)
      if (!daily.has(bucket)) {
        daily.add(bucket)
        keep.add(row.id)
      }
    }
  }
  return keep
}

export interface WriteSnapshotOptions {
  kind: SnapshotKind
  name?: string | null
  createdBy?: string | null
  editors?: readonly string[]
}

/**
 * Writes a snapshot of `state` for the deck. Takes the deck row lock first, so it cannot interleave with an
 * update append or a compaction. The state must be a complete Yjs state (or an update that applies to an empty doc).
 */
export async function writeSnapshot(db: Db, deckId: string, state: Uint8Array, options: WriteSnapshotOptions): Promise<{ id: string; createdAt: Date }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: decks.id }).from(decks).where(eq(decks.id, deckId)).for('update')
    if (!locked) throw new Error('Deck not found')
    const [row] = await tx
      .insert(deckSnapshots)
      .values({
        deckId,
        ydoc: Buffer.from(state),
        kind: options.kind,
        name: options.name ?? null,
        createdBy: options.createdBy ?? null,
        editors: [...new Set(options.editors ?? [])].slice(0, EDITORS_KEPT),
      })
      .returning({ id: deckSnapshots.id, createdAt: deckSnapshots.createdAt })
    if (!row) throw new Error('could not write the snapshot')
    return row
  })
}

export interface VersionEntry {
  id: string
  kind: 'auto' | 'named'
  name: string | null
  createdAt: string
  createdBy: { id: string; name: string; image: string | null } | null
  editors: Array<{ id: string; name: string; image: string | null }>
}

/** Named versions and auto checkpoints, newest first. Internal states are not history and are not listed. */
export async function listVersions(db: Db, deckId: string, limit = 500): Promise<VersionEntry[]> {
  const rows = await db
    .select({
      id: deckSnapshots.id,
      kind: deckSnapshots.kind,
      name: deckSnapshots.name,
      createdAt: deckSnapshots.createdAt,
      createdBy: deckSnapshots.createdBy,
      editors: deckSnapshots.editors,
    })
    .from(deckSnapshots)
    .where(and(eq(deckSnapshots.deckId, deckId), inArray(deckSnapshots.kind, ['auto', 'named'])))
    .orderBy(desc(deckSnapshots.createdAt), desc(deckSnapshots.id))
    .limit(limit)

  const ids = new Set<string>()
  for (const row of rows) {
    if (row.createdBy) ids.add(row.createdBy)
    for (const e of row.editors) ids.add(e)
  }
  const people = ids.size
    ? await db.select({ id: user.id, name: user.name, image: user.image }).from(user).where(inArray(user.id, [...ids]))
    : []
  const byId = new Map(people.map((p) => [p.id, p]))
  const person = (id: string) => {
    const p = byId.get(id)
    return p ? { id: p.id, name: p.name, image: p.image ?? null } : null
  }

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as 'auto' | 'named',
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ? person(row.createdBy) : null,
    editors: row.editors.map(person).filter((p): p is NonNullable<ReturnType<typeof person>> => p !== null),
  }))
}

/** One version's deck, read from its snapshot. Null when the version is not in this deck's history. */
export async function readVersion(db: Db, deckId: string, versionId: string): Promise<{ id: string; kind: 'auto' | 'named'; name: string | null; createdAt: Date; deck: Deck } | null> {
  const [row] = await db
    .select({ id: deckSnapshots.id, kind: deckSnapshots.kind, name: deckSnapshots.name, createdAt: deckSnapshots.createdAt, ydoc: deckSnapshots.ydoc })
    .from(deckSnapshots)
    .where(and(eq(deckSnapshots.id, versionId), eq(deckSnapshots.deckId, deckId), inArray(deckSnapshots.kind, ['auto', 'named'])))
    .limit(1)
  if (!row) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, row.ydoc)
  return { id: row.id, kind: row.kind as 'auto' | 'named', name: row.name, createdAt: row.createdAt, deck: yDocToDeck(doc) }
}

/**
 * Applies the retention policy to one deck. Serialised with the deck row lock. Returns how many rows it deleted.
 * Deleting never touches the newest snapshot, so a load always has a starting point.
 */
export async function pruneDeckSnapshots(db: Db, deckId: string, now: Date = new Date()): Promise<{ deleted: number }> {
  return db.transaction(async (tx) => {
    await tx.select({ id: decks.id }).from(decks).where(eq(decks.id, deckId)).for('update')
    const rows = await tx
      .select({ id: deckSnapshots.id, kind: deckSnapshots.kind, name: deckSnapshots.name, createdAt: deckSnapshots.createdAt })
      .from(deckSnapshots)
      .where(eq(deckSnapshots.deckId, deckId))
      .orderBy(asc(deckSnapshots.createdAt))
    const keep = snapshotsToKeep(rows.map((r) => ({ ...r, kind: r.kind as SnapshotKind })), now)
    const drop = rows.filter((r) => !keep.has(r.id)).map((r) => r.id)
    if (drop.length > 0) await tx.delete(deckSnapshots).where(inArray(deckSnapshots.id, drop))
    return { deleted: drop.length }
  })
}

/** Runs pruneDeckSnapshots for every deck that has snapshots. Used by the worker's daily job. */
export async function pruneAllSnapshots(db: Db, now: Date = new Date()): Promise<{ decks: number; deleted: number }> {
  const ids = await db.execute<{ deck_id: string }>(sql`select distinct deck_id from deck_snapshots`)
  let deleted = 0
  for (const row of ids) {
    deleted += (await pruneDeckSnapshots(db, row.deck_id, now)).deleted
  }
  return { decks: ids.length, deleted }
}

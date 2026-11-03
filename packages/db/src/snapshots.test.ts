import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createDeck, deckToYDoc } from '@sleid/model'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { snapshotsToKeep, type SnapshotMeta, writeSnapshot, listVersions, readVersion, pruneDeckSnapshots, BEFORE_RESTORE_NAME } from './snapshots.ts'
import { deckSnapshots } from './schema/index.ts'
import type { Db } from './client.ts'
import { eq } from 'drizzle-orm'

const NOW = new Date('2026-11-03T12:00:00.000Z')
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function at(id: string, ageMs: number, kind: SnapshotMeta['kind'] = 'auto', name: string | null = null): SnapshotMeta {
  return { id, kind, name, createdAt: new Date(NOW.getTime() - ageMs) }
}

describe('snapshot retention policy (pure)', () => {
  it('keeps every auto checkpoint from the last 24 hours', () => {
    const rows = Array.from({ length: 30 }, (_, i) => at(`a${i}`, i * 10 * MIN))
    const keep = snapshotsToKeep(rows, NOW)
    expect(rows.filter((r) => r.createdAt.getTime() >= NOW.getTime() - 24 * HOUR).every((r) => keep.has(r.id))).toBe(true)
  })

  it('keeps one auto checkpoint per clock hour between 1 and 7 days old', () => {
    const hourStart = Math.floor((NOW.getTime() - 3 * DAY) / HOUR) * HOUR
    const rows: SnapshotMeta[] = [
      { id: 'old-1', kind: 'auto', name: null, createdAt: new Date(hourStart + 5 * MIN) },
      { id: 'old-2', kind: 'auto', name: null, createdAt: new Date(hourStart + 20 * MIN) },
      { id: 'old-3', kind: 'auto', name: null, createdAt: new Date(hourStart + 50 * MIN) },
      { id: 'next-hour', kind: 'auto', name: null, createdAt: new Date(hourStart + 65 * MIN) },
    ]
    const keep = snapshotsToKeep([...rows, at('recent', 1 * MIN)], NOW)
    // the newest checkpoint in that hour (old-3) is kept, the two earlier ones in the hour are not
    expect(keep.has('old-3')).toBe(true)
    expect(keep.has('old-1')).toBe(false)
    expect(keep.has('old-2')).toBe(false)
    expect(keep.has('next-hour')).toBe(true)
  })

  it('keeps one auto checkpoint per UTC day between 7 and 90 days old, and drops older ones', () => {
    const dayStart = Math.floor((NOW.getTime() - 30 * DAY) / DAY) * DAY
    const rows: SnapshotMeta[] = [
      { id: 'd-early', kind: 'auto', name: null, createdAt: new Date(dayStart + 1 * HOUR) },
      { id: 'd-late', kind: 'auto', name: null, createdAt: new Date(dayStart + 20 * HOUR) },
      { id: 'too-old', kind: 'auto', name: null, createdAt: new Date(NOW.getTime() - 91 * DAY) },
    ]
    const keep = snapshotsToKeep([...rows, at('recent', 1 * MIN)], NOW)
    expect(keep.has('d-late')).toBe(true)
    expect(keep.has('d-early')).toBe(false)
    expect(keep.has('too-old')).toBe(false)
  })

  it('keeps named versions and "Before restore" forever, whatever their age', () => {
    const rows = [at('named-old', 400 * DAY, 'named', 'v1'), at('restore-old', 200 * DAY, 'auto', BEFORE_RESTORE_NAME), at('auto-old', 200 * DAY)]
    const keep = snapshotsToKeep([...rows, at('recent', MIN)], NOW)
    expect(keep.has('named-old')).toBe(true)
    expect(keep.has('restore-old')).toBe(true)
    expect(keep.has('auto-old')).toBe(false)
  })

  it('keeps only the newest internal state, and always keeps the newest snapshot of any kind', () => {
    const rows = [at('int-1', 3 * HOUR, 'internal'), at('int-2', 2 * HOUR, 'internal'), at('int-3', 1 * HOUR, 'internal')]
    expect([...snapshotsToKeep(rows, NOW)]).toEqual(['int-3'])
    expect([...snapshotsToKeep([], NOW)]).toEqual([])
  })
})

let db: Db | null = null
const users: string[] = []

beforeAll(async () => {
  db = await connectOrNull()
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, users)
  await db.$client.end({ timeout: 1 })
})

function stateOf(title: string): Uint8Array {
  return Y.encodeStateAsUpdate(deckToYDoc(createDeck(title)))
}

describe('snapshots in Postgres', () => {
  it('writes named and auto snapshots with editors, and lists them without internal states', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'snap-owner')
    const other = await makeUser(db, 'snap-other')
    users.push(owner.id, other.id)
    const deckId = await makeDeck(db, owner.id, 'Snapshots')
    await writeSnapshot(db, deckId, stateOf('internal'), { kind: 'internal' })
    const named = await writeSnapshot(db, deckId, stateOf('v1'), { kind: 'named', name: 'v1', createdBy: owner.id, editors: [owner.id, other.id] })
    await writeSnapshot(db, deckId, stateOf('auto'), { kind: 'auto', createdBy: other.id, editors: [other.id, owner.id, other.id] })

    const versions = await listVersions(db, deckId)
    expect(versions.map((v) => v.kind)).toEqual(['auto', 'named'])
    expect(versions[0]!.editors.map((e) => e.name)).toEqual(['snap-other', 'snap-owner'])
    expect(versions[1]).toMatchObject({ id: named.id, name: 'v1', createdBy: { id: owner.id } })

    const read = await readVersion(db, deckId, named.id)
    expect(read?.deck.title).toBe('v1')
    expect(await readVersion(db, '00000000-0000-4000-8000-000000000000', named.id)).toBeNull()
  })

  it('prunes internal states to the newest, keeps named versions, and never leaves the deck without its newest snapshot', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'prune-owner')
    users.push(owner.id)
    const deckId = await makeDeck(db, owner.id, 'Prune')
    // Old internal states and an old auto checkpoint, all far older than the 90-day limit.
    const old = new Date(Date.now() - 200 * DAY)
    const [a, b] = await db
      .insert(deckSnapshots)
      .values([
        { deckId, ydoc: Buffer.from(stateOf('a')), kind: 'internal', createdAt: old },
        { deckId, ydoc: Buffer.from(stateOf('b')), kind: 'auto', createdAt: old },
      ])
      .returning({ id: deckSnapshots.id })
    const named = await writeSnapshot(db, deckId, stateOf('named'), { kind: 'named', name: 'keep me' })
    const newest = await writeSnapshot(db, deckId, stateOf('newest'), { kind: 'internal' })

    const result = await pruneDeckSnapshots(db, deckId, new Date())
    expect(result.deleted).toBe(2)
    const left = (await db.select({ id: deckSnapshots.id }).from(deckSnapshots).where(eq(deckSnapshots.deckId, deckId))).map((r) => r.id).sort()
    expect(left).toEqual([named.id, newest.id].sort())
    expect(a!.id).not.toBe(b!.id)
  })
})

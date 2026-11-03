import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { pruneDeckSnapshots, writeSnapshot, type Db } from '@sleid/db'
import { startSnapshotRetention } from './retention.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

describe('snapshot retention job', () => {
  it('runs after the first delay, then on each interval, and stops cleanly', async () => {
    const logs: string[] = []
    const logger = { info: (m: string) => void logs.push(m), warn: () => {}, error: (m: string) => void logs.push(`error ${m}`) }
    const job = startSnapshotRetention({
      db: {} as never,
      logger,
      intervalMs: 80,
      firstRunMs: 30,
      pruneSnapshots: async () => ({ decks: 0, deleted: 0 }),
      pruneSessions: async () => 0,
    })
    await sleep(20)
    expect(logs.filter((l) => l.includes('version retention:'))).toHaveLength(0)
    await sleep(200)
    const runsBeforeStop = logs.filter((l) => l.includes('version retention:')).length
    expect(runsBeforeStop).toBeGreaterThanOrEqual(2)
    await job.stop()
    await sleep(200)
    expect(logs.filter((l) => l.includes('version retention:')).length).toBe(runsBeforeStop)
  })

  it('prunes an old internal state of a real deck', { timeout: 60_000 }, async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'retain-owner')
    users.push(owner.id)
    const deckId = await makeDeck(db, owner.id, 'Retain')
    // Pruning never decodes snapshot bytes, so placeholder bytes are enough here.
    await writeSnapshot(db, deckId, new Uint8Array([0]), { kind: 'internal' })
    await writeSnapshot(db, deckId, new Uint8Array([0]), { kind: 'internal' })
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    // Only this deck is pruned here: the local database holds many decks from other runs, and the test is about one.
    const job = startSnapshotRetention({
      db,
      logger,
      firstRunMs: 10 * 60_000,
      intervalMs: 10 * 60_000,
      pruneSnapshots: async (database, now) => {
        const one = await pruneDeckSnapshots(database, deckId, now)
        return { decks: 1, deleted: one.deleted }
      },
      pruneSessions: async () => 0,
    })
    const result = await job.runNow()
    expect(result.deleted).toBeGreaterThanOrEqual(1)
    const left = await db.$client.unsafe<{ n: number }[]>(`select count(*)::int as n from deck_snapshots where deck_id = $1`, [deckId])
    expect(left[0]?.n).toBe(1)
    await job.stop()
  })
})

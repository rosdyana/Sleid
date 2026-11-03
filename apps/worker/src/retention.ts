// Daily retention job. Applies the snapshot retention policy (see packages/db/src/snapshots.ts) to every deck that
// has snapshots, and removes phone-remote session rows that can no longer be used. Runs once shortly after start, then every 24 hours. Each deck is pruned under its own
// row lock, so it cannot interleave with an update or a checkpoint.
import { pruneAllSnapshots, pruneRemoteSessions, type Db } from '@sleid/db'
import type { Logger } from './logger.ts'

export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
export const RETENTION_FIRST_RUN_MS = 60 * 1000

export interface RetentionOptions {
  db: Db
  logger: Logger
  intervalMs?: number
  firstRunMs?: number
  now?: () => Date
  /** Replaces the real prune steps (tests only). */
  pruneSnapshots?: (db: Db, now: Date) => Promise<{ decks: number; deleted: number }>
  pruneSessions?: (db: Db, before: Date) => Promise<number>
}

export function startSnapshotRetention(options: RetentionOptions): { stop(): Promise<void>; runNow(): Promise<{ decks: number; deleted: number }> } {
  const intervalMs = options.intervalMs ?? RETENTION_INTERVAL_MS
  const now = options.now ?? (() => new Date())
  const pruneSnapshots = options.pruneSnapshots ?? pruneAllSnapshots
  const pruneSessions = options.pruneSessions ?? pruneRemoteSessions
  let running: Promise<unknown> | null = null
  let stopped = false

  async function runNow() {
    const started = Date.now()
    const result = await pruneSnapshots(options.db, now())
    // Phone-remote sessions older than a day can never be used again (their tokens last 30 minutes).
    const sessions = await pruneSessions(options.db, new Date(now().getTime() - 24 * 60 * 60 * 1000))
    options.logger.info(
      `[worker] version retention: ${result.deleted} snapshots pruned across ${result.decks} decks, ${sessions} remote sessions removed, in ${Date.now() - started} ms`,
    )
    return result
  }

  function tick() {
    if (stopped) return
    running = runNow()
      .catch((err: unknown) => options.logger.error('[worker] version retention failed', err))
      .finally(() => {
        running = null
      })
  }

  const first = setTimeout(tick, options.firstRunMs ?? RETENTION_FIRST_RUN_MS)
  const timer = setInterval(tick, intervalMs)

  return {
    runNow,
    async stop() {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
      await running
    },
  }
}

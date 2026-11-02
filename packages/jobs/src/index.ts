// Job queue (pg-boss on the same Postgres). The web app sends export jobs; the worker receives them.
import { PgBoss, type Job } from 'pg-boss'
import { ExportJobPayloadSchema, type ExportJobPayload } from '@sleid/db/export-spec'

export const EXPORT_QUEUE = 'export-deck'

export interface JobQueue {
  /** Creates pg-boss's schema if needed and the queues this app uses. Safe to call from several processes. */
  start(): Promise<void>
  stop(): Promise<void>
  enqueueExport(payload: ExportJobPayload): Promise<string | null>
  /** Runs `handler` for each export job, `concurrency` at a time. The handler should not throw: failures belong in the exports row. */
  workExports(concurrency: number, handler: (payload: ExportJobPayload, jobId: string) => Promise<void>): Promise<string>
}

/**
 * `queueName` is for tests only: a separate queue keeps a running dev worker from taking a test's jobs.
 * The app always uses EXPORT_QUEUE.
 */
export function createJobQueue(connectionString: string, options: { maxConnections?: number; queueName?: string } = {}): JobQueue {
  const boss = new PgBoss({ connectionString, max: options.maxConnections ?? 4 })
  const queueName = options.queueName ?? EXPORT_QUEUE
  let started = false

  return {
    async start() {
      if (started) return
      await boss.start()
      await boss.createQueue(queueName, { retryLimit: 0, expireInSeconds: 60 * 60 })
      started = true
    },
    async stop() {
      if (!started) return
      started = false
      await boss.stop({ graceful: true, timeout: 10_000 })
    },
    async enqueueExport(payload) {
      const data = ExportJobPayloadSchema.parse(payload)
      return boss.send(queueName, data, { retryLimit: 0, expireInSeconds: 60 * 60 })
    },
    async workExports(concurrency, handler) {
      return boss.work(queueName, { localConcurrency: concurrency }, async (jobs: Job<unknown>[]) => {
        for (const job of jobs) {
          const payload = ExportJobPayloadSchema.parse(job.data)
          await handler(payload, job.id)
        }
      })
    },
  }
}

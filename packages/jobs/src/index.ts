// Job queue (pg-boss on the same Postgres). The web app sends jobs; the worker receives them.
import { PgBoss, type Job } from 'pg-boss'
import { ExportJobPayloadSchema, type ExportJobPayload } from '@sleid/db/export-spec'
import { z } from 'zod'

export const EXPORT_QUEUE = 'export-deck'
export const IMPORT_QUEUE = 'import-deck'
/** M9: renders the PNG thumbnail of a user template. The row holds the template; the worker writes the file and the key. */
export const TEMPLATE_THUMBNAIL_QUEUE = 'template-thumbnail'
export const TemplateThumbnailPayloadSchema = z.object({ templateId: z.uuid() })
export type TemplateThumbnailPayload = z.infer<typeof TemplateThumbnailPayloadSchema>
/** A queued import. The row in import_jobs holds the file location and the result. */
export const ImportJobPayloadSchema = z.object({ importId: z.uuid() })
export type ImportJobPayload = z.infer<typeof ImportJobPayloadSchema>
/** Wizard queues. One per job kind, so each can have its own concurrency. */
export const WIZARD_QUEUES = {
  research: 'wizard-research',
  ingest: 'wizard-ingest',
  generate: 'wizard-generate',
} as const
export type WizardJobKind = keyof typeof WIZARD_QUEUES

/** `retry` on a generate job: write the run's placeholder slides again (not the whole outline). */
export const WizardJobPayloadSchema = z.object({ runId: z.uuid(), sourceId: z.uuid().optional(), retry: z.boolean().optional() })
export type WizardJobPayload = z.infer<typeof WizardJobPayloadSchema>

export interface JobQueue {
  /** Creates pg-boss's schema if needed and the queues this app uses. Safe to call from several processes. */
  start(): Promise<void>
  stop(): Promise<void>
  enqueueExport(payload: ExportJobPayload): Promise<string | null>
  enqueueImport(payload: ImportJobPayload): Promise<string | null>
  enqueueTemplateThumbnail(payload: TemplateThumbnailPayload): Promise<string | null>
  /** Runs `handler` for each thumbnail job. Failures are logged by the handler, not thrown. */
  workTemplateThumbnails(concurrency: number, handler: (payload: TemplateThumbnailPayload, jobId: string) => Promise<void>): Promise<string>
  /** Runs `handler` for each import job, `concurrency` at a time. Failures belong in the import_jobs row. */
  workImports(concurrency: number, handler: (payload: ImportJobPayload, jobId: string) => Promise<void>): Promise<string>
  /** Runs `handler` for each export job, `concurrency` at a time. The handler should not throw: failures belong in the exports row. */
  workExports(concurrency: number, handler: (payload: ExportJobPayload, jobId: string) => Promise<void>): Promise<string>
  enqueueWizard(kind: WizardJobKind, payload: WizardJobPayload): Promise<string | null>
  /** Runs `handler` for each wizard job of one kind. Failures belong in the wizard rows, not in a thrown error. */
  workWizard(kind: WizardJobKind, concurrency: number, handler: (payload: WizardJobPayload, jobId: string) => Promise<void>): Promise<string>
}

/**
 * `queueName` is for tests only: a separate queue keeps a running dev worker from taking a test's jobs.
 * `prefix` does the same for the wizard queues. The app always uses the defaults.
 */
export function createJobQueue(connectionString: string, options: { maxConnections?: number; queueName?: string; importQueueName?: string; prefix?: string } = {}): JobQueue {
  const boss = new PgBoss({ connectionString, max: options.maxConnections ?? 4 })
  const queueName = options.queueName ?? EXPORT_QUEUE
  const importQueue = options.importQueueName ?? IMPORT_QUEUE
  const prefix = options.prefix ?? ''
  const wizardName = (kind: WizardJobKind) => `${prefix}${WIZARD_QUEUES[kind]}`
  let started = false

  return {
    async start() {
      if (started) return
      await boss.start()
      await boss.createQueue(queueName, { retryLimit: 0, expireInSeconds: 60 * 60 })
      await boss.createQueue(importQueue, { retryLimit: 0, expireInSeconds: 60 * 60 })
      await boss.createQueue(TEMPLATE_THUMBNAIL_QUEUE, { retryLimit: 0, expireInSeconds: 60 * 60 })
      for (const kind of Object.keys(WIZARD_QUEUES) as WizardJobKind[]) {
        await boss.createQueue(wizardName(kind), { retryLimit: 0, expireInSeconds: 60 * 60 })
      }
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
    async enqueueImport(payload) {
      const data = ImportJobPayloadSchema.parse(payload)
      return boss.send(importQueue, data, { retryLimit: 0, expireInSeconds: 60 * 60 })
    },
    async workImports(concurrency, handler) {
      return boss.work(importQueue, { localConcurrency: concurrency }, async (jobs: Job<unknown>[]) => {
        for (const job of jobs) {
          const payload = ImportJobPayloadSchema.parse(job.data)
          await handler(payload, job.id)
        }
      })
    },
    async enqueueTemplateThumbnail(payload) {
      const data = TemplateThumbnailPayloadSchema.parse(payload)
      return boss.send(TEMPLATE_THUMBNAIL_QUEUE, data, { retryLimit: 0, expireInSeconds: 60 * 60 })
    },
    async workTemplateThumbnails(concurrency, handler) {
      return boss.work(TEMPLATE_THUMBNAIL_QUEUE, { localConcurrency: concurrency }, async (jobs: Job<unknown>[]) => {
        for (const job of jobs) {
          const payload = TemplateThumbnailPayloadSchema.parse(job.data)
          await handler(payload, job.id)
        }
      })
    },
    async enqueueWizard(kind, payload) {
      const data = WizardJobPayloadSchema.parse(payload)
      return boss.send(wizardName(kind), data, { retryLimit: 0, expireInSeconds: 60 * 60 })
    },
    async workWizard(kind, concurrency, handler) {
      return boss.work(wizardName(kind), { localConcurrency: concurrency }, async (jobs: Job<unknown>[]) => {
        for (const job of jobs) {
          const payload = WizardJobPayloadSchema.parse(job.data)
          await handler(payload, job.id)
        }
      })
    },
  }
}

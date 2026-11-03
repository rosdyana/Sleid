// Connects the wizard queues to the wizard handlers. The export service is started separately (service.ts).
import type { JobQueue } from '@sleid/jobs'
import type { StorageDriver } from '@sleid/storage'
import type { SearchProvider } from '@sleid/research'
import type { Logger } from '../logger.ts'
import { runGenerate, runIngest, runResearch, type WizardEnv } from './jobs.ts'
import { resolveWizardProvider } from './provider.ts'
import type { WizardCollab } from './collab.ts'
import type { Db } from '@sleid/db'

export interface WizardServiceOptions {
  db: Db
  queue: JobQueue
  uploads: StorageDriver
  collab: WizardCollab
  search: SearchProvider | null
  env: NodeJS.ProcessEnv
  logger: Logger
  ingestConcurrency?: number
}

export async function startWizardService(options: WizardServiceOptions): Promise<{ stop(): Promise<void> }> {
  const env: WizardEnv = {
    db: options.db,
    uploads: options.uploads,
    collab: options.collab,
    search: options.search,
    resolveProvider: (userId, providerId) => resolveWizardProvider(options.db, options.env, userId, providerId),
    enqueueIngest: async (runId, sourceId) => {
      await options.queue.enqueueWizard('ingest', { runId, sourceId })
    },
    logger: options.logger,
  }
  await options.queue.start()
  // Research and generation run one at a time per worker: a run's slides must come in order.
  await options.queue.workWizard('research', 1, async (payload) => runResearch(env, payload.runId))
  await options.queue.workWizard('ingest', options.ingestConcurrency ?? 3, async (payload) => {
    if (payload.sourceId) await runIngest(env, payload.sourceId)
  })
  await options.queue.workWizard('generate', 1, async (payload) => runGenerate(env, payload.runId))
  options.logger.info('[worker] listening for wizard jobs (research, ingest, generate)')
  return {
    async stop() {
      // The queue is stopped by the export service's stop().
    },
  }
}

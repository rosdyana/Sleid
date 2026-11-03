import type { JobQueue } from '@sleid/jobs'
import type { Db } from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'
import type { Logger } from '../logger.ts'
import { runImport } from './runner.ts'

export interface ImportServiceOptions {
  db: Db
  queue: JobQueue
  uploads: StorageDriver
  assets: StorageDriver
  concurrency: number
  logger: Logger
}

/** Connects the import queue to the import runner. The queue itself is stopped by the export service's stop(). */
export async function startImportService(options: ImportServiceOptions): Promise<{ stop(): Promise<void> }> {
  const env = { db: options.db, uploads: options.uploads, assets: options.assets, logger: options.logger }
  await options.queue.start()
  await options.queue.workImports(options.concurrency, async (payload) => {
    await runImport(env, payload.importId)
  })
  return {
    async stop() {
      // Nothing to close here: the queue is stopped by the export service's stop().
    },
  }
}

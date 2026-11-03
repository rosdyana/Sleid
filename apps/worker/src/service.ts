import type { JobQueue } from '@sleid/jobs'
import type { Db, LiveDeckSource } from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'
import type { BrowserPool } from './browser.ts'
import { runExport } from './runner.ts'
import { renderTemplateThumbnail } from './thumbnail.ts'
import type { Logger } from './logger.ts'

export interface ExportServiceOptions {
  db: Db
  queue: JobQueue
  assets: StorageDriver
  exports: StorageDriver
  browser: BrowserPool
  live?: LiveDeckSource
  concurrency: number
  tmpRoot?: string
  logger: Logger
}

/** Connects the queue to the export runner. Returns a stop function that waits for running jobs to finish. */
export async function startExportService(options: ExportServiceOptions): Promise<{ stop(): Promise<void> }> {
  const env = {
    db: options.db,
    assets: options.assets,
    exports: options.exports,
    browser: options.browser,
    live: options.live,
    tmpRoot: options.tmpRoot,
    logger: options.logger,
  }
  await options.queue.start()
  await options.queue.workExports(options.concurrency, async (payload) => {
    await runExport(env, payload.exportId)
  })
  // Template thumbnails (M9). One at a time: each one starts a page in the shared browser.
  await options.queue.workTemplateThumbnails(1, async (payload) => {
    try {
      await renderTemplateThumbnail(env, payload.templateId)
    } catch (err) {
      options.logger.error(`template thumbnail ${payload.templateId} failed`, err)
    }
  })
  return {
    async stop() {
      await options.queue.stop()
      await options.browser.close()
    },
  }
}

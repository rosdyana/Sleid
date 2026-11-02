// Export worker: pg-boss consumer that turns export rows into files (PDF, PNG/JPG, PPTX, HTML zip, Markdown, JSON).
import { createDb } from '@sleid/db'
import { createJobQueue } from '@sleid/jobs'
import { assetStorageFromEnv, exportStorageFromEnv } from '@sleid/storage'
import { loadWorkerConfig } from './config.ts'
import { createBrowserPool } from './browser.ts'
import { consoleLogger } from './logger.ts'
import { startExportService } from './service.ts'

const config = loadWorkerConfig()
const db = createDb(config.databaseUrl, { max: 6 })
const queue = createJobQueue(config.databaseUrl)
const browser = createBrowserPool(config.chromePath)

if (!config.live) consoleLogger.warn('COLLAB_INTERNAL_SECRET is not set: decks are read from the database, which can miss the last ~2 seconds of edits')

const service = await startExportService({
  db,
  queue,
  assets: assetStorageFromEnv(),
  exports: exportStorageFromEnv(),
  browser,
  live: config.live,
  concurrency: config.concurrency,
  tmpRoot: config.tmpRoot,
  logger: consoleLogger,
})
consoleLogger.info(`[worker] listening for export jobs (concurrency ${config.concurrency})`)

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await service.stop()
  await db.$client.end({ timeout: 2 })
  process.exit(0)
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

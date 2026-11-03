// Export worker: pg-boss consumer that turns export rows into files (PDF, PNG/JPG, PPTX, HTML zip, Markdown, JSON).
import { createDb } from '@sleid/db'
import { createJobQueue } from '@sleid/jobs'
import { assetStorageFromEnv, exportStorageFromEnv } from '@sleid/storage'
import { loadWorkerConfig } from './config.ts'
import { createBrowserPool } from './browser.ts'
import { consoleLogger } from './logger.ts'
import { startExportService } from './service.ts'
import { startWizardService } from './wizard/service.ts'
import { startSnapshotRetention } from './retention.ts'
import { createWizardCollab } from './wizard/collab.ts'
import { createSearchProvider, researchFromEnv } from '@sleid/research'

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

// Wizard jobs need the collab service (slides land in the live deck). Without its secret they cannot run.
const researchConfig = (() => {
  try {
    return researchFromEnv(process.env)
  } catch (err) {
    consoleLogger.warn(`[worker] research is off: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
})()
const wizardService = config.live
  ? await startWizardService({
      db,
      queue,
      uploads: assetStorageFromEnv(),
      collab: createWizardCollab({ baseUrl: config.live.baseUrl, secret: config.live.secret }),
      search: researchConfig ? createSearchProvider(researchConfig) : null,
      env: process.env,
      logger: consoleLogger,
    })
  : null
if (!config.live) consoleLogger.warn('COLLAB_INTERNAL_SECRET is not set: the wizard cannot generate decks (it needs the collab service)')

const retention = startSnapshotRetention({ db, logger: consoleLogger })

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await retention.stop()
  await service.stop()
  await wizardService?.stop()
  await db.$client.end({ timeout: 2 })
  process.exit(0)
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

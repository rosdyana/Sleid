import { markExportDone, markExportFailed, markExportRunning, getExportJob, readDeck, type LiveDeckSource } from '@sleid/db'
import { produceExport, type ExportEnv } from './formats.ts'
import type { Logger } from './logger.ts'
import type { StorageDriver } from '@sleid/storage'
import type { ExportFormat } from '@sleid/db'

export interface RunnerEnv extends ExportEnv {
  exports: StorageDriver
  live?: LiveDeckSource
  logger: Logger
}

/**
 * Runs one export job end to end. Never throws for an export problem: the failure goes to the
 * exports row, where the editor can show it. Only infrastructure errors (the database) propagate.
 */
export async function runExport(env: RunnerEnv, exportId: string): Promise<void> {
  const row = await getExportJob(env.db, exportId)
  if (!row) {
    env.logger.warn(`export ${exportId} not found; nothing to do`)
    return
  }
  if (row.status === 'done' || row.status === 'failed') return

  await markExportRunning(env.db, exportId)
  try {
    const { deck, source } = await readDeck(env.db, row.deckId, {
      live: env.live,
      onFallback: (reason) => env.logger.warn('collab service unavailable; exporting the persisted deck', reason),
    })
    env.logger.info(`export ${exportId}: ${row.format} from ${source} state`)
    const produced = await produceExport(env, deck, row.format as ExportFormat, row.options)
    await env.exports.put(exportId, produced.bytes)
    await markExportDone(env.db, exportId, {
      fileKey: exportId,
      fileName: produced.fileName,
      contentType: produced.contentType,
      bytes: produced.bytes.byteLength,
    })
    env.logger.info(`export ${exportId}: done (${produced.bytes.byteLength} bytes)`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    env.logger.error(`export ${exportId} failed: ${message}`)
    await markExportFailed(env.db, exportId, friendly(message))
  }
}

/** The message the editor shows. Stack traces and paths stay in the log. */
function friendly(message: string): string {
  if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(message)) {
    return 'The export browser is not available. Set CHROME_PATH or run `pnpm exec playwright install chromium`.'
  }
  if (/Timeout/i.test(message)) return 'The export took too long and was stopped.'
  if (/Deck not found/i.test(message)) return 'The deck no longer exists.'
  return message.split('\n')[0]!.slice(0, 300)
}


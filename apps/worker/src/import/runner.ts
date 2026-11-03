import { createImportedDeck, getImportJob, markImportDone, markImportFailed, markImportRunning, type Db, type ImportFormat } from '@sleid/db'
import { DeckImportError, jsonToDeck, type Deck } from '@sleid/model'
import { PptxImportError, pptxToDeck } from '@sleid/pptx'
import { markdownToDeck } from '@sleid/render'
import type { StorageDriver } from '@sleid/storage'
import type { Logger } from '../logger.ts'

export interface ImportRunnerEnv {
  db: Db
  /** Where the uploaded source files are kept until the import is done (the asset root, under import/). */
  uploads: StorageDriver
  /** Where the images kept from the import go. */
  assets: StorageDriver
  logger: Logger
}

/** A problem with the import that is safe to show as it is. */
class ImportProblem extends Error {}

const GENERIC = 'The file could not be imported. Check that it is a valid file of the chosen type and try again.'

/**
 * Runs one import job end to end. Never throws for a problem with the file: the failure goes to the import_jobs row,
 * where the user sees it. Only infrastructure errors (the database) propagate. The source upload is deleted in every
 * case once the job has been handled.
 */
export async function runImport(env: ImportRunnerEnv, importId: string): Promise<void> {
  const row = await getImportJob(env.db, importId)
  if (!row) {
    env.logger.warn(`import ${importId} not found; nothing to do`)
    return
  }
  if (row.status === 'done' || row.status === 'failed') return

  await markImportRunning(env.db, importId)
  try {
    const bytes = row.sourceKey ? await env.uploads.get(row.sourceKey) : null
    if (!bytes) throw new ImportProblem('The uploaded file is missing. Upload it again.')
    const converted = await convert(row.format as ImportFormat, bytes)
    const deck: Deck = row.title ? { ...converted.deck, title: row.title.slice(0, 200) } : converted.deck
    const created = await createImportedDeck(env.db, {
      userId: row.userId,
      deck,
      storeAsset: (id, data) => env.assets.put(id, data),
      deleteAsset: (id) => env.assets.delete(id),
    })
    const warnings = [...converted.warnings]
    if (created.droppedImages > 0) {
      warnings.push(`${created.droppedImages} image(s) could not be kept, because they were too large or not a supported type. They were left out.`)
    }
    await markImportDone(env.db, importId, { deckId: created.id, warnings })
    env.logger.info(`import ${importId}: ${row.format} made deck ${created.id} (${warnings.length} warning(s))`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    env.logger.error(`import ${importId} failed: ${message}`)
    await markImportFailed(env.db, importId, userMessage(err))
  } finally {
    if (row.sourceKey) {
      await env.uploads.delete(row.sourceKey).catch((err: unknown) => env.logger.warn(`could not delete the upload of import ${importId}`, err))
    }
  }
}

/** The deck for the file, with the converter's warnings. Each converter throws a message that is safe to show. */
async function convert(format: ImportFormat, bytes: Uint8Array): Promise<{ deck: Deck; warnings: string[] }> {
  if (format === 'pptx') return pptxToDeck(bytes)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (format === 'markdown') return { deck: markdownToDeck(text), warnings: [] }
  return { deck: jsonToDeck(text), warnings: [] }
}

/** The message the user sees. Converter messages are written for users; anything else gets the generic text. */
function userMessage(err: unknown): string {
  if (err instanceof PptxImportError || err instanceof DeckImportError || err instanceof ImportProblem) return err.message.slice(0, 300)
  return GENERIC
}

// Template thumbnails (M9). The worker renders the first slide of a user template as a PNG, with the same export
// producer as a PNG export (produceExport), and stores it under `template-thumbs/<templateId>.png` in the asset store.
import { randomUUID } from 'node:crypto'
import { getTemplateRow, setTemplateThumbnail, type Db } from '@sleid/db'
import { DeckSchema } from '@sleid/model'
import type { StorageDriver } from '@sleid/storage'
import type { BrowserPool } from './browser.ts'
import { produceExport, type ExportEnv } from './formats.ts'
import type { Logger } from './logger.ts'

export interface ThumbnailEnv {
  db: Db
  assets: StorageDriver
  browser: BrowserPool
  logger: Logger
  tmpRoot?: string
}

export function thumbnailKey(templateId: string): string {
  return `template-thumbs/${templateId}.png`
}

/** Renders and stores the thumbnail of one template. A missing template is not an error (it may have been deleted). */
export async function renderTemplateThumbnail(env: ThumbnailEnv, templateId: string): Promise<boolean> {
  const row = await getTemplateRow(env.db, templateId)
  if (!row) return false
  const deck = DeckSchema.parse(row.deck)
  const first = deck.slides[0]
  if (!first) return false
  // The export validates the deck id as a UUID. The id has no effect on the picture.
  const exportEnv: ExportEnv = { db: env.db, assets: env.assets, browser: env.browser, logger: env.logger, ...(env.tmpRoot ? { tmpRoot: env.tmpRoot } : {}) }
  const shot = await produceExport(exportEnv, { ...deck, id: randomUUID() }, 'png', { scale: 0.5, slideId: first.id })
  const key = thumbnailKey(templateId)
  await env.assets.put(key, shot.bytes)
  await setTemplateThumbnail(env.db, templateId, key)
  return true
}

import { randomUUID } from 'node:crypto'
import { getTemplateRow, setTemplateThumbnail, templateThumbnailKey, type Db } from '@sleid/db'
import { BUILT_IN_TEMPLATES, builtInTemplateDeck, DeckSchema, type Deck } from '@sleid/model'
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

/** The storage key of a template's thumbnail (the same rule the web app reads by). */
export const thumbnailKey = templateThumbnailKey

/** The first slide of a deck as a PNG (half size). Null for a deck with no slides. */
async function firstSlidePng(env: ThumbnailEnv, deck: Deck): Promise<Uint8Array | null> {
  const first = deck.slides[0]
  if (!first) return null
  const exportEnv: ExportEnv = { db: env.db, assets: env.assets, browser: env.browser, logger: env.logger, ...(env.tmpRoot ? { tmpRoot: env.tmpRoot } : {}) }
  const shot = await produceExport(exportEnv, { ...deck, id: randomUUID() }, 'png', { scale: 0.5, slideId: first.id })
  return shot.bytes
}

/**
 * Renders and stores the thumbnail of one user template, then records its key on the row. A missing template is not an
 * error (it may have been deleted in the meantime). Queued by the web app when a template is saved.
 */
export async function renderTemplateThumbnail(env: ThumbnailEnv, templateId: string): Promise<boolean> {
  const row = await getTemplateRow(env.db, templateId)
  if (!row) return false
  const bytes = await firstSlidePng(env, DeckSchema.parse(row.deck))
  if (!bytes) return false
  const key = thumbnailKey(templateId)
  await env.assets.put(key, bytes)
  await setTemplateThumbnail(env.db, templateId, key)
  return true
}

/**
 * Renders the thumbnails of the built-in templates that do not have one in storage yet. Run once when the worker
 * starts (in the background), so the gallery has them without a request ever waiting for Chrome. Returns how many
 * were made. A template whose render fails is logged and skipped.
 */
export async function renderMissingBuiltInThumbnails(env: ThumbnailEnv): Promise<number> {
  let made = 0
  for (const info of BUILT_IN_TEMPLATES) {
    const key = thumbnailKey(info.id)
    if (await env.assets.get(key)) continue
    const deck = builtInTemplateDeck(info.id)
    if (!deck) continue
    try {
      const bytes = await firstSlidePng(env, deck)
      if (!bytes) continue
      await env.assets.put(key, bytes)
      made++
    } catch (err) {
      env.logger.error(`built-in template thumbnail ${info.id} failed`, err)
    }
  }
  return made
}

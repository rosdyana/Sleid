// Integration: a saved template's thumbnail job, through pg-boss, the export service and real Chrome. The job is
// enqueued the way the web app enqueues it on save, and the worker must write the PNG and record its key on the row.
// Skips (with a message) when no browser can start, and on a database that is down.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fullDeck } from '../../../packages/model/src/fixtures.ts'
import { getTemplateRow, insertTemplateRow, templateThumbnailKey, type Db } from '@sleid/db'
import { connectOrNull, makeUser, removeUsers, TEST_DATABASE_URL } from '@sleid/db/testing'
import { createJobQueue, type JobQueue } from '@sleid/jobs'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import { createBrowserPool, type BrowserPool } from './browser.ts'
import { startExportService } from './service.ts'

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

let db: Db | null = null
let browser: BrowserPool | null = null
let queue: JobQueue | null = null
let stop: (() => Promise<void>) | null = null
let browserOk = false
let ownerId = ''
const dir = mkdtempSync(join(tmpdir(), 'sleid-thumb-test-'))
let storage: StorageDriver

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  storage = createLocalStorage(join(dir, 'assets'))
  ownerId = (await makeUser(db, 'thumb-owner')).id

  browser = createBrowserPool(process.env.CHROME_PATH || undefined)
  try {
    await browser.get()
    browserOk = true
  } catch (err) {
    console.warn(`[thumbnail test] no browser: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    return
  }
  // Queue names are unique per run, so a running dev worker on the same database cannot take these jobs.
  queue = createJobQueue(TEST_DATABASE_URL, { queueName: `export-deck-thumb-${randomUUID()}`, thumbnailQueueName: `template-thumbnail-test-${randomUUID()}` })
  const service = await startExportService({
    db,
    queue,
    assets: storage,
    exports: createLocalStorage(join(dir, 'exports')),
    browser,
    concurrency: 1,
    tmpRoot: join(dir, 'work'),
    logger: { info: () => {}, warn: () => {}, error: (m, d) => console.error(m, d ?? '') },
  })
  stop = () => service.stop()
}, 120_000)

afterAll(async () => {
  await stop?.()
  if (db) {
    await removeUsers(db, [ownerId])
    await db.$client.end({ timeout: 1 })
  }
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

describe('template thumbnail job', () => {
  it('a saved template gets its thumbnail: the job runs, the PNG is stored, and the row records the key', async () => {
    if (!db || !browserOk || !queue) return
    const templateId = randomUUID()
    const deck = { ...fullDeck(), id: randomUUID() }
    await insertTemplateRow(db, {
      id: templateId,
      ownerId,
      name: 'Thumbnail test',
      description: '',
      category: 'general',
      visibility: 'private',
      deck,
      themeName: deck.theme.name,
      slideCount: deck.slides.length,
    })
    expect((await getTemplateRow(db, templateId))!.thumbnailKey).toBeNull()

    await queue.enqueueTemplateThumbnail({ templateId })
    const started = Date.now()
    let row = await getTemplateRow(db, templateId)
    while (!row?.thumbnailKey) {
      if (Date.now() - started > 150_000) throw new Error('the thumbnail job did not finish')
      await new Promise((r) => setTimeout(r, 300))
      row = await getTemplateRow(db, templateId)
    }
    expect(row.thumbnailKey).toBe(templateThumbnailKey(templateId))
    const bytes = await storage.get(row.thumbnailKey)
    expect(bytes).not.toBeNull()
    expect(Array.from(bytes!.slice(0, 8))).toEqual(PNG_SIGNATURE)
  }, 180_000)
})

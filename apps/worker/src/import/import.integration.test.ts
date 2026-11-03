// Integration: import jobs through pg-boss, real Postgres, an in-process import worker and local storage.
// Skips when the database is unreachable. The pptx round trip uses the deck-to-pptx exporter, so no fixture file is needed.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDeck, type Deck } from '@sleid/model'
import { deckToPptx } from '@sleid/pptx'
import { getImportJob, insertImportJob, readDeck, type Db, type ImportJobRow } from '@sleid/db'
import { connectOrNull, makeUser, removeUsers, TEST_DATABASE_URL } from '@sleid/db/testing'
import { createJobQueue, type JobQueue } from '@sleid/jobs'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import { fullDeck } from '../../../../packages/model/src/fixtures.ts'
import { startImportService } from './service.ts'

let db: Db | null = null
let queue: JobQueue | null = null
let stop: (() => Promise<void>) | null = null
let ownerId = ''
const uploadsRoot = mkdtempSync(join(tmpdir(), 'sleid-import-test-uploads-'))
const assetsRoot = mkdtempSync(join(tmpdir(), 'sleid-import-test-assets-'))
let uploads: StorageDriver
let assets: StorageDriver
const enc = (s: string) => new TextEncoder().encode(s)

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  uploads = createLocalStorage(uploadsRoot)
  assets = createLocalStorage(assetsRoot)
  const owner = await makeUser(db, 'import-owner')
  ownerId = owner.id
  queue = createJobQueue(TEST_DATABASE_URL, { importQueueName: `import-deck-test-${randomUUID()}` })
  const service = await startImportService({
    db,
    queue,
    uploads,
    assets,
    concurrency: 2,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
  stop = async () => {
    await service.stop()
    await queue?.stop()
  }
}, 60_000)

afterAll(async () => {
  await stop?.()
  if (db) {
    await removeUsers(db, [ownerId])
    await db.$client.end({ timeout: 1 })
  }
  rmSync(uploadsRoot, { recursive: true, force: true })
  rmSync(assetsRoot, { recursive: true, force: true })
})

/** Stores the source, inserts the row, queues the job and waits for the row to finish. */
async function runImport(format: 'pptx' | 'markdown' | 'json', bytes: Uint8Array, options: { title?: string; storeSource?: boolean } = {}): Promise<ImportJobRow> {
  const id = randomUUID()
  const sourceKey = `import/${id}`
  if (options.storeSource !== false) await uploads.put(sourceKey, bytes)
  await insertImportJob(db!, { id, userId: ownerId, format, fileName: `source.${format}`, title: options.title ?? null, bytes: bytes.byteLength, sourceKey })
  await queue!.enqueueImport({ importId: id })
  const started = Date.now()
  for (;;) {
    const row = await getImportJob(db!, id)
    if (row && (row.status === 'done' || row.status === 'failed')) return row
    if (Date.now() - started > 60_000) throw new Error(`import ${format} did not finish`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe('import worker (pg-boss, Postgres)', () => {
  it('a markdown file becomes a deck with one slide per "---" section, and its upload is deleted', async (ctx) => {
    if (!db) return ctx.skip()
    const md = '# Welcome\n\nHello there\n\n---\n\n## Second\n\n- one\n- two\n\n---\n\n# Third\n\nBye'
    const row = await runImport('markdown', enc(md))
    expect(row.status, row.error ?? '').toBe('done')
    expect(row.warnings).toEqual([])
    const { deck } = await readDeck(db!, row.deckId!)
    expect(deck.slides).toHaveLength(3)
    expect(deck.title).toBe('Welcome')
    expect(await uploads.get(row.sourceKey!)).toBeNull()
  }, 90_000)

  it('the title given with the import overrides the file title', async (ctx) => {
    if (!db) return ctx.skip()
    const row = await runImport('markdown', enc('# From the file\n\nText'), { title: 'Chosen title' })
    expect(row.status, row.error ?? '').toBe('done')
    const { deck } = await readDeck(db!, row.deckId!)
    expect(deck.title).toBe('Chosen title')
  }, 90_000)

  it('a sleid json deck is imported with new ids', async (ctx) => {
    if (!db) return ctx.skip()
    const source: Deck = createDeck('From JSON')
    const row = await runImport('json', enc(JSON.stringify(source)))
    expect(row.status, row.error ?? '').toBe('done')
    const { deck } = await readDeck(db!, row.deckId!)
    expect(deck.title).toBe('From JSON')
    expect(deck.slides).toHaveLength(1)
    expect(deck.id).not.toBe(source.id)
    expect(deck.slides[0]!.id).not.toBe(source.slides[0]!.id)
  }, 90_000)

  it('a pptx exported by Sleid comes back with the same slide count', async (ctx) => {
    if (!db) return ctx.skip()
    const source = fullDeck()
    const bytes = await deckToPptx(source)
    const row = await runImport('pptx', bytes)
    expect(row.status, row.error ?? '').toBe('done')
    const { deck } = await readDeck(db!, row.deckId!)
    expect(deck.slides).toHaveLength(source.slides.length)
  }, 120_000)

  it('a file that is not valid JSON fails with a message for the user, and the upload is still deleted', async (ctx) => {
    if (!db) return ctx.skip()
    const row = await runImport('json', enc('{ not json'))
    expect(row.status).toBe('failed')
    expect(row.error).toBe('This file is not valid JSON.')
    expect(row.deckId).toBeNull()
    expect(await uploads.get(row.sourceKey!)).toBeNull()
  }, 90_000)

  it('a broken pptx fails with a message and creates no deck', async (ctx) => {
    if (!db) return ctx.skip()
    const row = await runImport('pptx', enc('PK\u0003\u0004 this is not a real package'))
    expect(row.status).toBe('failed')
    expect(row.error?.length ?? 0).toBeGreaterThan(0)
    expect(row.deckId).toBeNull()
  }, 90_000)

  it('a row whose upload is missing fails with a clear message', async (ctx) => {
    if (!db) return ctx.skip()
    const row = await runImport('markdown', enc('# Gone'), { storeSource: false })
    expect(row.status).toBe('failed')
    expect(row.error).toBe('The uploaded file is missing. Upload it again.')
  }, 90_000)
})

// Integration: export jobs through pg-boss, real Postgres, an in-process worker, and real Chrome
// (CHROME_PATH, or Playwright's bundled Chromium). Skips the browser formats when no browser can start.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import * as Y from 'yjs'
import { deckToYDoc, type Deck, type Slide } from '@sleid/model'
import { fullDeck } from '../../../packages/model/src/fixtures.ts'
import { assets as assetsTable, createExportJob, deckSnapshots, getExportJob, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers, TEST_DATABASE_URL } from '@sleid/db/testing'
import { createJobQueue, type JobQueue } from '@sleid/jobs'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import { createBrowserPool, type BrowserPool } from './browser.ts'
import { startExportService } from './service.ts'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let db: Db | null = null
let queue: JobQueue | null = null
let browser: BrowserPool | null = null
let stop: (() => Promise<void>) | null = null
let browserOk = false
let deckId = ''
let sheetDeckId = ''
let ownerId = ''
let assetId = ''
const exportsStore = mkdtempSync(join(tmpdir(), 'sleid-export-test-exports-'))
const assetsStore = mkdtempSync(join(tmpdir(), 'sleid-export-test-assets-'))
let exportsDriver: StorageDriver
let assetsDriver: StorageDriver

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  exportsDriver = createLocalStorage(exportsStore)
  assetsDriver = createLocalStorage(assetsStore)

  const owner = await makeUser(db, 'export-owner')
  ownerId = owner.id
  deckId = await makeDeck(db, owner.id, 'Export fixture')

  assetId = randomUUID()
  const png = Uint8Array.from(Buffer.from(PNG_B64, 'base64'))
  await assetsDriver.put(assetId, png)
  await db.insert(assetsTable).values({
    id: assetId,
    deckId,
    ownerId,
    mime: 'image/png',
    bytes: png.byteLength,
    sha256: createHash('sha256').update(png).digest('hex'),
  })

  const deck = fullDeck()
  deck.id = deckId
  deck.title = 'Export fixture'
  for (const slide of deck.slides) {
    for (const el of slide.elements) {
      if (el.type === 'image') el.src = `/api/assets/${assetId}`
    }
  }
  await db.insert(deckSnapshots).values({ deckId, ydoc: Buffer.from(Y.encodeStateAsUpdate(deckToYDoc(deck))) })

  // A five-slide deck for the multi-slide exports: the three fixture slides, then two copies of slide-full.
  sheetDeckId = await makeDeck(db, owner.id, 'Sheet fixture')
  const five = fullDeck()
  five.id = sheetDeckId
  five.title = 'Sheet fixture'
  for (const slide of five.slides) {
    for (const el of slide.elements) {
      if (el.type === 'image') el.src = `/api/assets/${assetId}`
    }
  }
  const base = five.slides.find((s) => s.id === 'slide-full')!
  five.slides.push(copySlide(base, 'sheet-4'), copySlide(base, 'sheet-5'))
  await db.insert(deckSnapshots).values({ deckId: sheetDeckId, ydoc: Buffer.from(Y.encodeStateAsUpdate(deckToYDoc(five))) })

  browser = createBrowserPool(process.env.CHROME_PATH || undefined)
  try {
    await browser.get()
    browserOk = true
  } catch (err) {
    console.warn(`[export test] no browser for PDF and PNG: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }

  queue = createJobQueue(TEST_DATABASE_URL, { queueName: `export-deck-test-${randomUUID()}` })
  const service = await startExportService({
    db,
    queue,
    assets: assetsDriver,
    exports: exportsDriver,
    browser,
    concurrency: 2,
    tmpRoot: join(exportsStore, 'work'),
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
  rmSync(exportsStore, { recursive: true, force: true })
  rmSync(assetsStore, { recursive: true, force: true })
}, 60_000)

/** A copy of a slide with a new id and new element ids, so the deck's ids stay unique. */
function copySlide(base: Slide, id: string): Slide {
  const copy = structuredClone(base)
  copy.id = id
  copy.hidden = false
  copy.elements = copy.elements.map((el, i) => ({ ...el, id: `${id}-el-${i}` }))
  return copy
}

async function runJob(format: string, options: Record<string, unknown> = {}, target = deckId) {
  const id = await createExportJob(db!, { deckId: target, userId: ownerId, format: format as never, options })
  await queue!.enqueueExport({ exportId: id })
  const started = Date.now()
  for (;;) {
    const row = await getExportJob(db!, id)
    if (row && (row.status === 'done' || row.status === 'failed')) return row
    if (Date.now() - started > 150_000) throw new Error(`export ${format} did not finish`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function bytesOf(exportId: string): Promise<Uint8Array> {
  const data = await exportsDriver.get(exportId)
  if (!data) throw new Error('export file missing')
  return data
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(Array.from(bytes.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47])
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

describe('export worker (pg-boss, Postgres, Chrome)', () => {
  it('json and markdown are produced from the persisted deck', async (ctx) => {
    if (!db) return ctx.skip()
    const json = await runJob('json')
    expect(json.status).toBe('done')
    expect(json.fileName).toMatch(/^Export fixture\.sleid\.json$/)
    const parsed = JSON.parse(new TextDecoder().decode(await bytesOf(json.id))) as Deck
    expect(parsed.id).toBe(deckId)
    expect(parsed.slides).toHaveLength(3)

    const md = await runJob('markdown')
    expect(md.status).toBe('done')
    expect(new TextDecoder().decode(await bytesOf(md.id))).toContain('## Heading')
  }, 180_000)

  it('pptx re-opens, keeps the hidden slide with show="0", and embeds the image', async (ctx) => {
    if (!db) return ctx.skip()
    const row = await runJob('pptx')
    expect(row.status, row.error ?? '').toBe('done')
    expect(row.contentType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    const zip = await JSZip.loadAsync(await bytesOf(row.id))
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    expect(slides).toHaveLength(3)
    expect(await zip.file('ppt/slides/slide3.xml')!.async('string')).toMatch(/<p:sld show="0"/)
    expect(Object.keys(zip.files).some((n) => n.startsWith('ppt/media/'))).toBe(true)
    expect(Object.keys(zip.files).some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true)
  }, 180_000)

  it('html zip contains a standalone index with the images bundled and no hidden-slide removal', async (ctx) => {
    if (!db) return ctx.skip()
    const row = await runJob('html')
    expect(row.status, row.error ?? '').toBe('done')
    const zip = await JSZip.loadAsync(await bytesOf(row.id))
    expect(Object.keys(zip.files)).toContain('index.html')
    expect(Object.keys(zip.files)).toContain(`assets/${assetId}.png`)
    const html = await zip.file('index.html')!.async('string')
    expect(html.match(/<section /g)).toHaveLength(3)
    expect(html).toContain(`assets/${assetId}.png`)
    expect(html).not.toMatch(/https:\/\/cdn\.jsdelivr/)
  }, 180_000)

  it('pdf: one page per visible slide, 1920x1080, offline', async (ctx) => {
    if (!db || !browserOk) return ctx.skip()
    const row = await runJob('pdf')
    expect(row.status, row.error ?? '').toBe('done')
    const bytes = await bytesOf(row.id)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('%PDF')
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBe(2) // slide-full and the title; the hidden slide is skipped
    const size = pdf.getPage(0).getSize()
    expect(Math.round(size.width)).toBe(1440) // 1920 px at 96 dpi
    expect(Math.round(size.height)).toBe(810)
  }, 180_000)

  it('pdf with speaker notes adds one page for each slide that has notes', async (ctx) => {
    if (!db || !browserOk) return ctx.skip()
    const row = await runJob('pdf', { includeNotes: true })
    expect(row.status, row.error ?? '').toBe('done')
    const pdf = await PDFDocument.load(await bytesOf(row.id))
    expect(pdf.getPageCount()).toBe(3) // two slides, plus a notes page for slide-full
  }, 180_000)

  it('png per slide comes as a zip; scale 0.5 halves the pixels', async (ctx) => {
    if (!db || !browserOk) return ctx.skip()
    const row = await runJob('png', { scale: 0.5 })
    expect(row.status, row.error ?? '').toBe('done')
    expect(row.fileName).toBe('Export fixture.png.zip')
    const zip = await JSZip.loadAsync(await bytesOf(row.id))
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual(['slide-01.png', 'slide-02.png'])
    expect(pngSize(await zip.file('slide-01.png')!.async('uint8array'))).toEqual({ width: 960, height: 540 })
  }, 180_000)

  it('a single slide PNG at scale 1 is one image, not a zip', async (ctx) => {
    if (!db || !browserOk) return ctx.skip()
    const row = await runJob('png', { scale: 1, slideId: 'slide-full' })
    expect(row.status, row.error ?? '').toBe('done')
    expect(row.contentType).toBe('image/png')
    expect(pngSize(await bytesOf(row.id))).toEqual({ width: 1920, height: 1080 })
  }, 180_000)

  it('a slide that is not in the deck fails with a readable message', async (ctx) => {
    if (!db || !browserOk) return ctx.skip()
    const row = await runJob('png', { scale: 1, slideId: 'no-such-slide' })
    expect(row.status).toBe('failed')
    expect(row.error).toBe('That slide is not in the deck')
  }, 180_000)

  it('a contact sheet of five slides at 3 columns is one 1920-wide PNG with two rows of slides', async (ctx) => {
    if (!db || !browserOk) return ctx.skip()
    const row = await runJob('png', { contactSheet: true, columns: 3, includeHidden: true }, sheetDeckId)
    expect(row.status, row.error ?? '').toBe('done')
    expect(row.fileName).toBe('contact-sheet.png')
    expect(row.contentType).toBe('image/png')
    const bytes = await bytesOf(row.id)
    const size = pngSize(bytes)
    const s = (1920 - 24 * (3 + 1)) / 3 / 1920
    expect(size.width).toBe(1920)
    expect(size.height).toBeGreaterThan(2 * 1080 * s)
    expect(size.height).toBeLessThan(3 * 1080 * s) // two rows, not three
  }, 180_000)

  it('slideIds exports those slides in deck order as a zip with one entry per slide', async (ctx) => {
    if (!db || !browserOk) return ctx.skip()
    const row = await runJob('png', { slideIds: ['sheet-5', 'slide-full'] }, sheetDeckId)
    expect(row.status, row.error ?? '').toBe('done')
    expect(row.fileName).toBe('Sheet fixture.png.zip')
    const zip = await JSZip.loadAsync(await bytesOf(row.id))
    expect(Object.keys(zip.files).sort()).toEqual(['slide-02.png', 'slide-05.png'])
  }, 180_000)

  it('an unknown id in slideIds fails the job and names the slide', async (ctx) => {
    if (!db || !browserOk) return ctx.skip()
    const row = await runJob('png', { slideIds: ['slide-full', 'no-such-slide'] }, sheetDeckId)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('Slide "no-such-slide" is not in the deck')
  }, 180_000)
})

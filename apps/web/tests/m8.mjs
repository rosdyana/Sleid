// M8 browser check: import PPTX, Markdown, JSON and Google Slides (a public link, through the test override), the
// refusal of a text file named .pptx and of a private presentation, and present mode on an imported deck.
// Needs `pnpm dev` with SLEID_TEST_AUTH=1, COLLAB_TOKEN_SECRET and COLLAB_INTERNAL_SECRET in the environment, and the
// Google test override pointing at this script's fake server:
//   SLEID_TEST_GOOGLE_EXPORT_ORIGIN=http://127.0.0.1:4413 SLEID_TEST_AUTH=1 pnpm dev
//   CHROME_PATH=... SCREENSHOT_DIR=... node tests/m8.mjs [http://localhost:3000]
// The script starts the fake Google server itself (port M8_FAKE_GOOGLE_PORT, default 4413).
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import JSZip from 'jszip'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const internalUrl = (process.env.COLLAB_INTERNAL_URL ?? 'http://127.0.0.1:3002').replace(/\/$/, '')
const internalSecret = process.env.COLLAB_INTERNAL_SECRET
if (!internalSecret) throw new Error('COLLAB_INTERNAL_SECRET must be set for this check')
const fakePort = Number(process.env.M8_FAKE_GOOGLE_PORT ?? 4413)
const expectedOrigin = `http://127.0.0.1:${fakePort}`

const stamp = Date.now().toString(36)
const email = `m8-${stamp}@example.com`
const password = 'password123'
const PUBLIC_ID = 'M8PubPresentation0001'
const PRIVATE_ID = 'M8PrivPresentation0001'
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
mkdirSync(shotDir, { recursive: true })
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

const log = (msg) => console.log(`ok  ${msg}`)
const check = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  log(msg)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(label, fn, timeoutMs = 20000, intervalMs = 250) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return Date.now() - started
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms: ${label}`)
    await sleep(intervalMs)
  }
}

async function internalJson(deckId) {
  const res = await fetch(`${internalUrl}/internal/decks/${deckId}/json`, { headers: { 'x-sleid-internal': internalSecret } })
  if (!res.ok) throw new Error(`internal json ${res.status}`)
  return res.json()
}

async function internalOps(deckId, ops) {
  const res = await fetch(`${internalUrl}/internal/decks/${deckId}/ops`, {
    method: 'POST',
    headers: { 'x-sleid-internal': internalSecret, 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'm8-test', ops }),
  })
  if (!res.ok) throw new Error(`internal ops ${res.status} ${await res.text()}`)
}

/** A PNG with a colour gradient, so the image shows in the export. */
function makePng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3
      raw[i] = Math.round((x / width) * 255)
      raw[i + 1] = Math.round((y / height) * 255)
      raw[i + 2] = 180
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * The exported PPTX with one shape the importer does not support (a wave), so the result carries a warning. The rest
 * of the file is the real export of the seeded deck.
 */
async function withUnsupportedShape(pptx) {
  const zip = await JSZip.loadAsync(pptx)
  const path = 'ppt/slides/slide1.xml'
  const xml = await zip.file(path).async('string')
  const wave = '<p:sp><p:nvSpPr><p:cNvPr id="990" name="Wave"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="600000" y="600000"/><a:ext cx="2400000" cy="900000"/></a:xfrm><a:prstGeom prst="wave"><a:avLst/></a:prstGeom></p:spPr></p:sp>'
  zip.file(path, xml.replace('</p:spTree>', `${wave}</p:spTree>`))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ---- The fake Google server: a public presentation (302 to a googleusercontent-style path, then the file), and a
// private one (the login page, which is HTML).
let publicPptx = null
const fakeHits = []
const fake = createServer((req, res) => {
  fakeHits.push(req.url)
  if (req.url === `/presentation/d/${PUBLIC_ID}/export/pptx`) {
    res.writeHead(302, { location: `/export/${PUBLIC_ID}/file.pptx` })
    res.end()
  } else if (req.url === `/export/${PUBLIC_ID}/file.pptx` && publicPptx) {
    res.writeHead(200, { 'content-type': PPTX_MIME })
    res.end(publicPptx)
  } else if (req.url === `/presentation/d/${PRIVATE_ID}/export/pptx`) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body>Sign in to Google to continue</body></html>')
  } else {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((resolve) => fake.listen(fakePort, '127.0.0.1', resolve))

const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
async function newContext(options = {}) {
  return browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...options })
}
function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`))
  page.on('console', (m) => {
    // Expected refusals (the private link, the text file) are answered with 4xx and show as console errors.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text()}`)
  })
}
const statusSaved = (page) => page.getByRole('status').filter({ hasText: 'All changes saved' }).first()

/** Waits for the export tray to show a download link, or fails on the export's error message. */
async function waitForDownload(page, namePattern) {
  const link = page.getByRole('link', { name: namePattern })
  const failed = page.getByRole('alert').filter({ hasText: 'Export failed' })
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    if (await link.first().isVisible().catch(() => false)) return link.first()
    if (await failed.first().isVisible().catch(() => false)) throw new Error(`export failed: ${await failed.first().textContent()}`)
    await sleep(500)
  }
  throw new Error(`timed out waiting for a download link matching ${namePattern}`)
}

/** Opens the Import dialog from the dashboard's New menu. */
async function openDashboardImport(page, item) {
  await page.goto(`${base}/`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'More ways to start a deck' }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import slides' })
  await dialog.waitFor({ state: 'visible', timeout: 10000 })
  return dialog
}

async function uploadTo(dialog, file) {
  await dialog.locator('input[type=file]').setInputFiles(file)
}

/** Waits for the import to finish: either the result or the error. Returns 'done' or the error text. */
async function waitForImportEnd(dialog, timeoutMs = 90000) {
  const ready = dialog.getByText('Your deck is ready.')
  const failed = dialog.getByRole('alert')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await ready.isVisible().catch(() => false)) return 'done'
    if (await failed.first().isVisible().catch(() => false)) return (await failed.first().textContent())?.trim() ?? ''
    await sleep(300)
  }
  throw new Error('timed out waiting for the import to finish')
}

/** The deck id from a URL like /d/<uuid>. */
const deckIdFrom = (url) => new URL(url).pathname.split('/')[2]

try {
  // ---- Sign up, make the source deck: a title, a chart, a table, an image, notes on three slides.
  const ctx = await newContext()
  const page = await ctx.newPage()
  watch(page, 'owner')
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await ctx.request.post(`${base}/api/auth/sign-up/email`, { headers, data: { name: 'M8 Tester', email, password } })
  if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()} ${await signIn.text()}`)

  await page.goto(`${base}/`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  const sourceId = deckIdFrom(page.url())
  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await statusSaved(page).waitFor({ state: 'visible', timeout: 20000 })
  const SOURCE_TITLE = `M8 source ${stamp}`
  await page.getByLabel('Deck title').fill(SOURCE_TITLE)
  await page.getByLabel('Deck title').press('Enter')
  await statusSaved(page).waitFor({ state: 'visible', timeout: 20000 })

  const first = await internalJson(sourceId)
  const slide1 = first.slides[0].id
  const slide2 = `m8-s2-${stamp}`
  const slide3 = `m8-s3-${stamp}`
  const text = (id, value, y) => ({
    id,
    type: 'text',
    x: 120,
    y,
    w: 1680,
    h: 140,
    rotation: 0,
    z: 1,
    locked: false,
    opacity: 1,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] },
    style: { align: 'left', valign: 'top', fontSize: 48 },
    role: 'title',
  })
  const png = makePng(480, 300)
  const upload = await ctx.request.post(`${base}/api/decks/${sourceId}/assets`, { multipart: { file: { name: 'gradient.png', mimeType: 'image/png', buffer: png } } })
  if (!upload.ok()) throw new Error(`asset upload failed: ${upload.status()} ${await upload.text()}`)
  const imageUrl = (await upload.json()).url
  await internalOps(sourceId, [
    { op: 'addSlide', layout: 'blank', slide: { id: slide2 } },
    { op: 'addSlide', layout: 'blank', slide: { id: slide3 } },
    { op: 'addElement', slideId: slide1, element: text(`m8-title-${stamp}`, 'Quarterly review', 120) },
    {
      op: 'addElement',
      slideId: slide2,
      element: {
        id: `m8-chart-${stamp}`,
        type: 'chart',
        x: 120,
        y: 320,
        w: 900,
        h: 600,
        rotation: 0,
        z: 1,
        locked: false,
        opacity: 1,
        chartType: 'bar',
        data: { columns: ['Quarter', 'Revenue'], rows: [['Q1', 10], ['Q2', 14], ['Q3', 9]] },
        options: { legend: false, title: 'Revenue' },
      },
    },
    {
      op: 'addElement',
      slideId: slide2,
      element: {
        id: `m8-table-${stamp}`,
        type: 'table',
        x: 1100,
        y: 320,
        w: 700,
        h: 300,
        rotation: 0,
        z: 2,
        locked: false,
        opacity: 1,
        rows: [['Region', 'Share'], ['North', '40%'], ['South', '60%']],
        header: true,
      },
    },
    {
      op: 'addElement',
      slideId: slide3,
      element: { id: `m8-image-${stamp}`, type: 'image', x: 200, y: 200, w: 960, h: 540, rotation: 0, z: 1, locked: false, opacity: 1, src: imageUrl, fit: 'contain' },
    },
    { op: 'setNotes', slideId: slide1, notes: 'Notes for slide one' },
    { op: 'setNotes', slideId: slide2, notes: 'Notes for slide two: the chart and the table' },
    { op: 'setNotes', slideId: slide3, notes: 'Notes for slide three, the image' },
  ])
  await page.locator('[id^="thumb-"]').nth(2).waitFor({ state: 'attached', timeout: 10000 })
  await statusSaved(page).waitFor({ state: 'visible', timeout: 20000 })
  check((await page.locator('[id^="thumb-"]').count()) === 3, 'the source deck has three slides, with a chart, a table, an image and notes')

  // ---- Export the source as PPTX (File > Download > PowerPoint).
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  await page.getByRole('group', { name: 'Download' }).getByRole('menuitem', { name: 'PowerPoint (.pptx)', exact: true }).click()
  const pptxLink = await waitForDownload(page, new RegExp(`^Download ${SOURCE_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.pptx$`))
  const [pptxDownload] = await Promise.all([page.waitForEvent('download'), pptxLink.click()])
  const pptxPath = join(shotDir, 'm8-source.pptx')
  await pptxDownload.saveAs(pptxPath)
  const pptxBytes = readFileSync(pptxPath)
  const zip = await JSZip.loadAsync(pptxBytes)
  check(Object.keys(zip.files).some((f) => /^ppt\/slides\/slide3\.xml$/.test(f)), 'the export is a PPTX with three slides')
  publicPptx = await withUnsupportedShape(pptxBytes)
  log('the exported PPTX is saved, and a copy with one unsupported shape is served as the public Google presentation')

  // ---- Import the PPTX from the dashboard's Import file dialog. Shows the dialog first.
  let dialog = await openDashboardImport(page, 'Import file…')
  await page.screenshot({ path: join(shotDir, 'import-dialog.png') })
  log('import-dialog.png saved (the Import dialog on the File tab)')
  check(await dialog.getByRole('tab', { name: 'File', exact: true }).getAttribute('aria-selected').then((v) => v === 'true'), 'the dialog opens on the File tab')
  await uploadTo(dialog, { name: 'm8-source.pptx', mimeType: PPTX_MIME, buffer: pptxBytes })
  check((await waitForImportEnd(dialog)) === 'done', 'the PPTX import finished without an error')
  await dialog.getByRole('button', { name: 'Open deck' }).click()
  await page.waitForURL(new RegExp(`/d/[0-9a-f-]{36}`), { timeout: 20000 })
  const importedId = deckIdFrom(page.url())
  check(importedId !== sourceId, `the imported PPTX opened as a new deck (${importedId})`)

  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('[id^="thumb-"]').nth(2).waitFor({ state: 'attached', timeout: 20000 })
  await statusSaved(page).waitFor({ state: 'visible', timeout: 20000 })
  const imported = await internalJson(importedId)
  check(imported.slides.length === 3, `the imported deck has ${imported.slides.length} slides, the source had 3`)
  const notesOf = (deck) => deck.slides.map((s) => s.notes ?? '')
  check(notesOf(imported).some((n) => n.includes('Notes for slide one')) && notesOf(imported).some((n) => n.includes('Notes for slide three')), 'the speaker notes came across')
  const types = (slide) => slide.elements.map((e) => e.type)
  check(types(imported.slides[1]).includes('chart') && types(imported.slides[1]).includes('table'), 'slide 2 has the chart and the table')
  check(types(imported.slides[2]).includes('image'), 'slide 3 has the image')
  // The chart renders in the editor: go to slide 2 and wait for the chart's drawing.
  await page.locator('[id^="thumb-"]').nth(1).click()
  const chart = page.locator('[data-testid=slide-canvas] [data-type=chart]').first()
  await chart.waitFor({ state: 'attached', timeout: 15000 })
  await waitUntil('the chart is drawn (canvas or svg inside it)', async () => (await chart.locator('canvas, svg').count()) > 0, 20000)
  check(true, 'the chart renders in the editor')
  await page.screenshot({ path: join(shotDir, 'imported-pptx-editor.png') })
  log('imported-pptx-editor.png saved')

  // ---- Present mode on the imported deck: the audience window opens on the current slide.
  const audiencePromise = ctx.waitForEvent('page')
  await page.getByRole('button', { name: 'Present', exact: true }).click()
  const audience = await audiencePromise
  watch(audience, 'audience')
  await audience.waitForURL(/\/present/, { timeout: 20000 })
  await audience.getByTestId('present-root').waitFor({ state: 'visible', timeout: 20000 })
  await audience.locator('section.present').waitFor({ state: 'attached', timeout: 20000 })
  await sleep(800)
  await audience.screenshot({ path: join(shotDir, 'imported-pptx-present.png') })
  log('imported-pptx-present.png saved')
  const presentText = (await audience.getByTestId('present-root').innerText()).replace(/\s+/g, ' ').trim()
  // Present starts from the current slide, which is slide 2 (the chart and the table).
  check(presentText.includes('Revenue') && presentText.includes('Region'), `present mode shows the imported chart and table (text: "${presentText.slice(0, 60)}")`)
  await audience.close()

  // ---- Markdown, from the editor's File > Import slides… (the new deck opens in a new tab).
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Import slides…', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Import slides' })
  await dialog.waitFor({ state: 'visible', timeout: 10000 })
  const mdTitle = `M8 markdown ${stamp}`
  const markdown = `---\ntitle: ${mdTitle}\n---\n# Markdown opening\n\n- first point\n- second point\n\n---\n\n## Second slide\n\nSome text on the second slide.\n`
  await uploadTo(dialog, { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown, 'utf8') })
  check((await waitForImportEnd(dialog)) === 'done', 'the Markdown import finished')
  const mdPagePromise = ctx.waitForEvent('page')
  await dialog.getByRole('link', { name: 'Open deck' }).click()
  const mdPage = await mdPagePromise
  watch(mdPage, 'markdown')
  await mdPage.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  check(mdPage.url() !== page.url(), 'the Markdown deck opened in a new tab, and the editor stays on the imported PPTX')
  const mdId = deckIdFrom(mdPage.url())
  await mdPage.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  const md = await internalJson(mdId)
  check(md.slides.length === 2, `the Markdown deck has ${md.slides.length} slides, split on the --- lines`)
  check(md.title === mdTitle, 'the Markdown title came from the front matter')
  await mdPage.close()

  // ---- JSON, from the dashboard. The deck JSON of the source, with a new title.
  const jsonTitle = `M8 json ${stamp}`
  const sourceJson = await internalJson(sourceId)
  const jsonBytes = Buffer.from(JSON.stringify({ ...sourceJson, title: jsonTitle }), 'utf8')
  dialog = await openDashboardImport(page, 'Import file…')
  await uploadTo(dialog, { name: 'deck.json', mimeType: 'application/json', buffer: jsonBytes })
  check((await waitForImportEnd(dialog)) === 'done', 'the JSON import finished')
  await dialog.getByRole('button', { name: 'Open deck' }).click()
  await page.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  const jsonDeck = await internalJson(deckIdFrom(page.url()))
  check(jsonDeck.slides.length === 3 && jsonDeck.title === jsonTitle, `the JSON deck has ${jsonDeck.slides.length} slides and its title`)

  // ---- Google Slides, public link (through the test override).
  dialog = await openDashboardImport(page, 'Import from Google Slides…')
  await dialog.getByLabel('Google Slides link').fill(`https://docs.google.com/presentation/d/${PUBLIC_ID}/edit?usp=sharing`)
  await dialog.getByRole('button', { name: 'Import link' }).click()
  check((await waitForImportEnd(dialog)) === 'done', 'the public Google Slides link imported')
  check(fakeHits.includes(`/presentation/d/${PUBLIC_ID}/export/pptx`), `the export was requested from the fake Google server (${expectedOrigin})`)
  const warnings = dialog.getByTestId('import-warnings')
  await warnings.waitFor({ state: 'visible', timeout: 10000 })
  await warnings.locator('summary').click()
  await warnings.getByText(/wave/).first().waitFor({ state: 'visible', timeout: 5000 })
  check(true, 'the result lists the warning about the unsupported shape')
  await dialog.screenshot({ path: join(shotDir, 'import-result.png') })
  log('import-result.png saved (the result with its warnings)')
  await dialog.getByRole('button', { name: 'Open deck' }).click()
  await page.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  const googleDeck = await internalJson(deckIdFrom(page.url()))
  check(googleDeck.slides.length === 3, `the Google Slides deck has ${googleDeck.slides.length} slides`)

  // ---- A private presentation (the login page) is refused with the message the user needs.
  dialog = await openDashboardImport(page, 'Import from Google Slides…')
  await dialog.getByLabel('Google Slides link').fill(`https://docs.google.com/presentation/d/${PRIVATE_ID}/edit`)
  await dialog.getByRole('button', { name: 'Import link' }).click()
  const privateResult = await waitForImportEnd(dialog)
  check(privateResult.includes("This presentation isn't public. Share it as 'Anyone with the link' or use Google Drive."), 'a private presentation is refused with the share message')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // ---- A link that is not a Google Slides link is refused before any request.
  dialog = await openDashboardImport(page, 'Import from Google Slides…')
  await dialog.getByLabel('Google Slides link').fill('https://evil.example/presentation/d/M8PubPresentation0001/edit')
  await dialog.getByRole('button', { name: 'Import link' }).click()
  const badLink = await dialog.getByRole('alert').first().textContent({ timeout: 15000 })
  check(/Paste the link of a Google Slides presentation/.test(badLink ?? ''), 'a link to another host is refused with the paste message')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // ---- A text file named .pptx is refused with a clear message (the server checks the content).
  dialog = await openDashboardImport(page, 'Import file…')
  await uploadTo(dialog, { name: 'not-a-deck.pptx', mimeType: PPTX_MIME, buffer: Buffer.from('hello, this is plain text, not a PowerPoint file\n', 'utf8') })
  const txtResult = await waitForImportEnd(dialog)
  check(txtResult.includes('This is not a PowerPoint file'), `a text file named .pptx is refused: "${txtResult.slice(0, 80)}"`)

  // The expected refusals are answered with 4xx and logged by the browser as "Failed to load resource", which watch() drops.
  check(errors.length === 0, `no page or console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
  console.log('m8 check passed')
} finally {
  await browser.close()
  await new Promise((resolve) => fake.close(resolve))
}

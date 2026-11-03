// Browser check for M3: export from the editor (PDF, PPTX), publish to web, and the public page.
// Needs the dev stack running with SLEID_TEST_AUTH=1 (web, collab and worker, see `pnpm dev`).
// Optional: CHROME_PATH (Google Chrome), SCREENSHOT_DIR (screenshots and downloaded files), SLEID_BASE_URL.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { PDFDocument } from 'pdf-lib'
import JSZip from 'jszip'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const stamp = Date.now().toString(36)
const email = `export-${stamp}@example.com`
const password = 'password123'
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
const downloadDir = join(shotDir, 'exports')
mkdirSync(downloadDir, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'sleid-export-e2e-'))

const log = (msg) => console.log(`ok  ${msg}`)
const check = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  log(msg)
}
const notes = []

async function waitSaved(page) {
  await page.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
}

/** A PNG with a colour gradient, so the image is visible in the exports. */
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
    raw[y * (width * 3 + 1)] = 0
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
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Waits for the export tray to show a download link, or fails on the export's error message. */
async function waitForDownload(page, namePattern) {
  const link = page.getByRole('link', { name: namePattern })
  const failed = page.getByRole('alert').filter({ hasText: 'Export failed' })
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    if (await link.first().isVisible().catch(() => false)) return link.first()
    if (await failed.first().isVisible().catch(() => false)) {
      throw new Error(`export failed: ${await failed.first().textContent()}`)
    }
    await page.waitForTimeout(500)
  }
  throw new Error(`timed out waiting for a download link matching ${namePattern}`)
}

async function exportViaMenu(page, groupOrNull, itemName, namePattern) {
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  const scope = groupOrNull ? page.getByRole('group', { name: groupOrNull }) : page
  await scope.getByRole('menuitem', { name: itemName, exact: true }).click()
  return namePattern
}

async function pdfPageToPng(pdfBytes, pageIndex, outPng) {
  const src = await PDFDocument.load(pdfBytes)
  const single = await PDFDocument.create()
  const [page] = await single.copyPages(src, [pageIndex])
  single.addPage(page)
  const file = join(work, `page-${pageIndex + 1}.pdf`)
  writeFileSync(file, await single.save())
  execFileSync('sips', ['-s', 'format', 'png', file, '--out', outPng], { stdio: 'ignore' })
}

const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await ctx.request.post(`${base}/api/auth/sign-up/email`, { headers, data: { name: 'Export Tester', email, password } })
  if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()} ${await signIn.text()}`)

  await page.goto(`${base}/`)
  await page.waitForLoadState('networkidle')
  const blank = page.getByRole('button', { name: 'New', exact: true })
  await blank.waitFor({ state: 'visible', timeout: 20000 })
  await blank.click()
  await page.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  const deckId = new URL(page.url()).pathname.split('/')[2]
  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await page.getByLabel('Deck title').fill('Export check')
  await page.getByLabel('Deck title').press('Enter')
  await waitSaved(page)

  // Slide 1: a text box.
  await page.getByRole('button', { name: 'Text box' }).click()
  const text1 = page.locator('[data-testid=slide-canvas] [data-type=text]').last()
  await text1.dblclick()
  await page.locator('.ProseMirror.ProseMirror-focused').first().waitFor({ state: 'visible', timeout: 10000 })
  await page.keyboard.type('Export check: opening slide')
  await page.getByLabel('Deck title').click()
  await waitSaved(page)
  log('slide 1 text typed and saved')

  // Slide 2: a chart, an uploaded image, and a Mermaid diagram.
  await page.locator('[data-testid=slide-canvas]').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('ControlOrMeta+Enter')
  await page.locator('[id^="thumb-"]').nth(1).waitFor({ state: 'attached', timeout: 10000 })
  await waitSaved(page)
  await page.getByLabel('Insert chart').selectOption('bar')
  await page.locator('[data-testid=slide-canvas] [data-type=chart]').first().waitFor({ state: 'attached', timeout: 10000 })
  await waitSaved(page)
  log('slide 2: bar chart inserted')

  await page.locator('input[type=file]').setInputFiles({ name: 'gradient.png', mimeType: 'image/png', buffer: makePng(480, 300) })
  await page.locator('[data-testid=slide-canvas] img').first().waitFor({ state: 'attached', timeout: 20000 })
  const imgSrc = await page.locator('[data-testid=slide-canvas] img').first().getAttribute('src')
  check(/^\/api\/assets\/[0-9a-f-]{36}$/.test(imgSrc ?? ''), `uploaded image is stored as an asset URL (${imgSrc})`)
  const assetResponse = await ctx.request.get(`${base}${imgSrc}`)
  check(assetResponse.ok() && assetResponse.headers()['content-type'] === 'image/png', 'the asset is served as image/png to its owner')
  await waitSaved(page)

  await page.getByRole('menuitem', { name: 'Insert', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Diagram (Mermaid)', exact: true }).click()
  await page.locator('[data-testid=slide-canvas] [data-type=diagram]').first().waitFor({ state: 'attached', timeout: 10000 })
  await waitSaved(page)
  log('slide 2: image uploaded and Mermaid diagram inserted')

  // Export PDF through File > Download > PDF, with the options dialog.
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  await page.getByRole('group', { name: 'Download' }).getByRole('menuitem', { name: 'PDF (.pdf)', exact: true }).click()
  await page.getByRole('dialog', { name: 'Export PDF' }).waitFor({ state: 'visible', timeout: 5000 })
  await page.getByRole('dialog', { name: 'Export PDF' }).getByRole('button', { name: 'Export', exact: true }).click()
  const pdfLink = await waitForDownload(page, /^Download Export check\.pdf$/)
  const [pdfDownload] = await Promise.all([page.waitForEvent('download'), pdfLink.click()])
  const pdfPath = join(downloadDir, 'Export check.pdf')
  await pdfDownload.saveAs(pdfPath)
  const pdfBytes = new Uint8Array(await (await import('node:fs/promises')).readFile(pdfPath))
  check(new TextDecoder().decode(pdfBytes.subarray(0, 5)) === '%PDF-', 'the PDF starts with %PDF-')
  const pdf = await PDFDocument.load(pdfBytes)
  check(pdf.getPageCount() === 2, `the PDF has one page per visible slide (${pdf.getPageCount()} pages, 2 slides)`)
  log('PDF exported, downloaded and checked')

  // Export PPTX through File > Download > PowerPoint.
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  await page.getByRole('group', { name: 'Download' }).getByRole('menuitem', { name: 'PowerPoint (.pptx)', exact: true }).click()
  const pptxLink = await waitForDownload(page, /^Download Export check\.pptx$/)
  const [pptxDownload] = await Promise.all([page.waitForEvent('download'), pptxLink.click()])
  const pptxPath = join(downloadDir, 'Export check.pptx')
  await pptxDownload.saveAs(pptxPath)
  const zip = await JSZip.loadAsync(new Uint8Array(await (await import('node:fs/promises')).readFile(pptxPath)))
  const slideParts = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  check(slideParts.length === 2, `the PPTX re-opens with 2 slides (${slideParts.length})`)
  check(Object.keys(zip.files).some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)), 'the PPTX has a native chart part')
  check(Object.keys(zip.files).some((n) => n.startsWith('ppt/media/')), 'the PPTX has the image as media')
  const slide1 = await zip.file('ppt/slides/slide1.xml').async('string')
  check(slide1.includes('Export check: opening slide'), 'the PPTX text box keeps its text as a text run')
  log('PPTX exported, downloaded and checked')

  // Publish to web from the share dialog.
  await page.getByRole('button', { name: 'Share' }).click()
  const share = page.getByRole('dialog', { name: 'Share deck' })
  await share.getByRole('switch', { name: 'Publish to web' }).click()
  const linkInput = share.getByRole('textbox', { name: 'Public link' })
  await linkInput.waitFor({ state: 'visible', timeout: 10000 })
  const publicUrl = await linkInput.inputValue()
  const token = publicUrl.split('/p/')[1]
  check(!!token && token.length >= 32, `publish issues a public link (${publicUrl.replace(token, '<token>')})`)
  await share.getByRole('button', { name: 'Done' }).click()

  // The public page in a fresh, logged-out context.
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const publicPage = await anon.newPage()
  publicPage.on('pageerror', (e) => errors.push(`public pageerror: ${e.message}`))
  await publicPage.goto(publicUrl)
  await publicPage.locator('.reveal .slides section').first().waitFor({ state: 'attached', timeout: 30000 })
  await publicPage.waitForFunction(() => document.querySelector('.reveal')?.classList.contains('ready'), null, { timeout: 30000 })
  check((await publicPage.locator('.reveal .slides section').count()) === 2, 'the public page renders both slides without signing in')
  check((await publicPage.locator('.sleid-chart svg').count()) >= 1, 'the public page renders the chart')
  check(await publicPage.getByText('Made with Sleid').isVisible(), 'the public page shows the Made with Sleid footer')
  const robots = await publicPage.locator('meta[name=robots]').getAttribute('content')
  check(robots?.includes('noindex'), 'the public page asks search engines not to index it')
  await publicPage.screenshot({ path: join(shotDir, 'publish-public.png') })

  // Unpublish: the link stops working.
  await page.getByRole('button', { name: 'Share' }).click()
  await share.getByRole('switch', { name: 'Publish to web' }).click()
  await share.getByText('Off: the deck is not public').waitFor({ state: 'visible', timeout: 10000 })
  await share.getByRole('button', { name: 'Done' }).click()
  const gone = await anon.request.get(publicUrl)
  check(gone.status() === 404, `after unpublishing, the link returns 404 (got ${gone.status()})`)
  await anon.close()

  // Render the PDF pages and the PPTX slides as PNG for review.
  if (process.platform === 'darwin') {
    await pdfPageToPng(pdfBytes, 0, join(shotDir, 'export-pdf-1.png'))
    await pdfPageToPng(pdfBytes, 1, join(shotDir, 'export-pdf-chart.png'))
    log('export-pdf-1.png and export-pdf-chart.png saved (rendered with sips)')
  } else {
    notes.push('PDF page screenshots skipped: sips is macOS only')
  }
  const soffice = spawnSoffice()
  if (soffice) {
    execFileSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', work, pptxPath], { stdio: 'ignore', timeout: 180000 })
    const converted = join(work, 'Export check.pdf')
    if (existsSync(converted)) {
      const slidesPdf = new Uint8Array(await (await import('node:fs/promises')).readFile(converted))
      for (let i = 0; i < 2; i++) await pdfPageToPng(slidesPdf, i, join(shotDir, `export-pptx-${i + 1}.png`))
      log('export-pptx-1.png and export-pptx-2.png saved (LibreOffice render)')
    }
  } else {
    notes.push('PPTX images skipped: soffice (LibreOffice) is not installed')
  }

  await ctx.close()
} catch (e) {
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
} finally {
  await browser.close()
}

function spawnSoffice() {
  for (const candidate of ['/opt/homebrew/bin/soffice', '/usr/local/bin/soffice', 'soffice']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 20000 })
      return candidate
    } catch {
      // try the next
    }
  }
  return null
}

for (const note of notes) console.log(`note: ${note}`)
if (errors.length) {
  console.error(`browser errors:\n${errors.join('\n')}`)
  process.exitCode = 1
}
if (process.exitCode) process.exit(process.exitCode)
console.log('export check passed')

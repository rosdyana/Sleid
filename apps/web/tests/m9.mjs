// M9 browser check: templates and brand kits.
//   - the built-in Quarterly review: six slides, the chart draws, the table header text is white
//   - Save as template (everyone on this server, and a private one): the gallery Mine tab shows the thumbnail (the worker
//     renders it); a second user sees the shared one under Shared, and not the private one
//   - a brand kit with a PNG logo and a palette; the saved logo previews in the kit editor
//   - the kit applied in the editor: the logo is on the canvas, the slides' elements are unchanged, a collaborator sees
//     the theme and the logo live, present mode shows the logo on non-title slides only (All except title), and the
//     PNG of the current slide carries the logo (the pixels at the logo's corner)
//   - an AI proposal with an off-palette accent (the fake model): the stored accent is a kit colour
//   - the wizard with the built-in template and the kit: the run completes, and the deck has the kit theme and logo
// Needs `pnpm dev` with SLEID_TEST_AUTH=1, COLLAB_TOKEN_SECRET, COLLAB_INTERNAL_SECRET, LLM_SECRET_KEY, SEARXNG_URL and
// the worker running (thumbnails and exports), and the fake SearXNG (`node tests/fake-searxng.mjs 4412`).
//   CHROME_PATH=... SCREENSHOT_DIR=... node tests/m9.mjs [http://localhost:3000]
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { startFakeOpenAI } from './fake-openai-server.mjs'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const internalUrl = (process.env.COLLAB_INTERNAL_URL ?? 'http://127.0.0.1:3002').replace(/\/$/, '')
const internalSecret = process.env.COLLAB_INTERNAL_SECRET
if (!internalSecret) throw new Error('COLLAB_INTERNAL_SECRET must be set for this check')
const SEARXNG = (process.env.WIZARD_SEARXNG_URL ?? 'http://127.0.0.1:4412').replace(/\/$/, '')
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
mkdirSync(shotDir, { recursive: true })

const stamp = Date.now().toString(36)
const password = 'password123'
const people = {
  a: { name: 'M9 Ana', email: `m9-a-${stamp}@example.com` },
  b: { name: 'M9 Bea', email: `m9-b-${stamp}@example.com` },
}
const LOCAL_KEY = `sk-m9-local-${stamp}`
const DECK_TITLE = `M9 quarterly ${stamp}`
const TEMPLATE_NAME = `M9 review ${stamp}`
const PRIVATE_NAME = `M9 private ${stamp}`
const KIT_NAME = `M9 Kit ${stamp}`
const WIZARD_TITLE = 'Rooftop solar for bakeries'
const LOGO_RGB = [214, 40, 40]
const KIT_PALETTE = {
  background: '#fffaf0',
  surface: '#fde7c7',
  text: '#1f2937',
  muted: '#6b7280',
  accent: '#0f766e',
  accent2: '#ea580c',
  accent3: '#7c3aed',
  accent4: '#0284c7',
}

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

/** A solid-colour PNG, so the logo's pixels are easy to find in an export. */
function solidPng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
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
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const LOGO_PNG = solidPng(400, 400, LOGO_RGB)

const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
const contexts = []
async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  contexts.push(ctx)
  return ctx
}
function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text()}`)
  })
}
const statusSaved = (page) => page.getByRole('status').filter({ hasText: 'All changes saved' }).first()
const thumbs = (page) => page.locator('[id^="thumb-"]').count()

async function signUpAndIn(ctx, who) {
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await ctx.request.post(`${base}/api/auth/sign-up/email`, { headers, data: { name: who.name, email: who.email, password } })
  if (!signUp.ok()) throw new Error(`sign-up failed for ${who.email}: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email: who.email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed for ${who.email}: ${signIn.status()} ${await signIn.text()}`)
}

/** Adds the fake local model as the user's default provider (the same form the ai and wizard checks use). */
async function addFakeProvider(page, fake) {
  await page.goto(`${base}/settings/ai`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('heading', { name: 'AI providers' }).waitFor({ state: 'visible', timeout: 20000 })
  await page.getByRole('button', { name: 'Add provider', exact: true }).click()
  const form = page.getByRole('form', { name: 'Add provider' })
  await form.getByLabel('Kind', { exact: true }).selectOption('openai-compatible')
  await form.getByLabel('Name', { exact: true }).fill('M9 fake model')
  await form.getByLabel('Base URL (include /v1)', { exact: true }).fill(fake.url)
  await form.getByLabel('Model name', { exact: true }).fill('fake-local')
  await form.getByLabel('API key (optional for local servers)', { exact: true }).fill(LOCAL_KEY)
  await form.getByLabel('Use as my default', { exact: true }).check()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByText('M9 fake model', { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 })
}

/** The gallery card for a template name, once its thumbnail has loaded. The worker renders it, so the page is reloaded until it has. */
async function waitForGalleryThumb(page, url, name, timeoutMs = 150000) {
  const started = Date.now()
  for (;;) {
    await page.goto(url)
    await page.waitForLoadState('networkidle')
    const card = page.locator('[data-testid^="gallery-item-"]').filter({ hasText: name }).first()
    if ((await card.count()) > 0) {
      await page.waitForTimeout(800)
      const loaded = await card
        .locator('img')
        .evaluate((img) => img.complete && img.naturalWidth > 0)
        .catch(() => false)
      if (loaded) return card
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for the thumbnail of "${name}"`)
    await sleep(3000)
  }
}

/** Decodes a PNG in the browser (no PNG library in the check) and samples the logo's corner. */
async function samplePng(page, dataUrl, rgb) {
  return page.evaluate(
    async ({ dataUrl, rgb }) => {
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const W = img.naturalWidth
      const H = img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      // The logo: width 14% of the slide, square, 40 px (of 1920) from the bottom and right edges.
      const margin = (40 * W) / 1920
      const size = 0.14 * W
      const cx = Math.round(W - margin - size / 2)
      const cy = Math.round(H - margin - size / 2)
      const data = ctx.getImageData(cx - 2, cy - 2, 5, 5).data
      let r = 0
      let g = 0
      let b = 0
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
      }
      const n = data.length / 4
      const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
      const close = avg.every((c, i) => Math.abs(c - rgb[i]) <= 40)
      return { W, H, avg, close, cx, cy }
    },
    { dataUrl, rgb },
  )
}

const fake = await startFakeOpenAI(0)
const shot = (name) => join(shotDir, name)

try {
  // ---- Owner A: a provider for the assistant and the wizard, then the built-in Quarterly review.
  const ctxA = await newContext()
  const pageA = await ctxA.newPage()
  watch(pageA, 'A')
  await signUpAndIn(ctxA, people.a)
  log('signed in with the test login (owner A)')
  await addFakeProvider(pageA, fake)

  await pageA.goto(`${base}/`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByTestId('start-template-builtin:quarterly-review').waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByTestId('start-template-builtin:quarterly-review').click()
  await pageA.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 30000 })
  const deckId = new URL(pageA.url()).pathname.split('/')[2]
  await pageA.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await statusSaved(pageA).waitFor({ state: 'visible', timeout: 20000 })
  await pageA.locator('[id^="thumb-"]').nth(5).waitFor({ state: 'attached', timeout: 20000 })
  await pageA.getByLabel('Deck title').fill(DECK_TITLE)
  await pageA.getByLabel('Deck title').press('Enter')
  await statusSaved(pageA).waitFor({ state: 'visible', timeout: 20000 })

  const template = await internalJson(deckId)
  check(template.slides.length === 6 && (await thumbs(pageA)) === 6, `the built-in Quarterly review deck has ${template.slides.length} slides in the editor`)
  const chartSlide = template.slides.findIndex((s) => s.elements.some((e) => e.type === 'chart'))
  const tableSlide = template.slides.findIndex((s) => s.elements.some((e) => e.type === 'table'))
  check(chartSlide >= 0 && tableSlide >= 0, 'the Quarterly review has a chart and a table')
  await pageA.locator('[id^="thumb-"]').nth(chartSlide).click()
  const chart = pageA.locator('[data-testid=slide-canvas] [data-type=chart]').first()
  await chart.waitFor({ state: 'attached', timeout: 15000 })
  await waitUntil('the chart is drawn', async () => (await chart.locator('canvas, svg').count()) > 0, 20000)
  check(true, 'the chart renders in the editor')
  await pageA.locator('[id^="thumb-"]').nth(tableSlide).click()
  const headerCell = pageA.locator('[data-testid=slide-canvas] [data-type=table] th').first()
  await headerCell.waitFor({ state: 'visible', timeout: 15000 })
  const headerColour = await headerCell.evaluate((el) => getComputedStyle(el).color)
  check(headerColour === 'rgb(255, 255, 255)', `the table header text is white (${headerColour})`)

  // ---- Save as template: everyone on this server, and a private copy.
  const saveTemplate = async (name, visibility) => {
    await pageA.getByRole('menuitem', { name: 'File', exact: true }).click()
    await pageA.getByText('Save as template…', { exact: true }).click()
    await pageA.getByTestId('save-template-dialog').waitFor({ state: 'visible', timeout: 10000 })
    await pageA.getByTestId('save-template-name').fill(name)
    await pageA.getByTestId('save-template-description').fill('Quarterly numbers and the three asks for the board.')
    await pageA.getByTestId('save-template-category').selectOption('business')
    await pageA.getByTestId(visibility === 'instance' ? 'save-template-visibility-instance' : 'save-template-visibility-private').check()
    await pageA.getByTestId('save-template-submit').click()
    await pageA.getByTestId('save-template-success').waitFor({ state: 'visible', timeout: 20000 })
    await pageA.getByTestId('save-template-dialog').getByRole('button', { name: 'Done' }).click()
  }
  await saveTemplate(TEMPLATE_NAME, 'instance')
  await saveTemplate(PRIVATE_NAME, 'private')
  check(true, 'saved two templates from the deck: one for everyone on this server, one private')

  await waitForGalleryThumb(pageA, `${base}/?gallery=mine`, TEMPLATE_NAME)
  check(true, 'the gallery Mine tab lists the saved template, and its thumbnail rendered (the worker)')
  check((await pageA.locator('[data-testid^="gallery-item-"]').filter({ hasText: PRIVATE_NAME }).count()) === 1, 'the private template is on A\'s Mine tab')
  await pageA.getByTestId('template-gallery').waitFor({ state: 'visible', timeout: 10000 })
  await pageA.screenshot({ path: shot('gallery.png') })
  log('gallery.png saved (Mine tab, with the thumbnail)')
  await pageA.getByTestId('template-gallery').getByRole('button', { name: 'Close' }).click()

  // ---- Second user B: sees the shared template under Shared, and not the private one.
  const ctxB = await newContext()
  const pageB = await ctxB.newPage()
  watch(pageB, 'B')
  await signUpAndIn(ctxB, people.b)
  await waitForGalleryThumb(pageB, `${base}/?gallery=shared`, TEMPLATE_NAME)
  check(true, 'B sees the template saved for everyone on this server under Shared, with its thumbnail')
  check((await pageB.locator('[data-testid^="gallery-item-"]').filter({ hasText: PRIVATE_NAME }).count()) === 0, 'B does not see A\'s private template under Shared')
  await pageB.getByTestId('gallery-tab-mine').click()
  await pageB.waitForTimeout(500)
  check((await pageB.locator('[data-testid^="gallery-item-"]').filter({ hasText: PRIVATE_NAME }).count()) === 0, 'B does not see A\'s private template under Mine')
  check((await pageB.locator('[data-testid^="gallery-item-"]').filter({ hasText: TEMPLATE_NAME }).count()) === 0, 'B\'s Mine tab does not list A\'s shared template either')

  // ---- A makes a brand kit with a palette and a PNG logo, and checks the saved logo in the kit editor.
  await pageA.goto(`${base}/settings/brand-kits`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByTestId('kit-new').waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByTestId('kit-new').click()
  await pageA.getByTestId('kit-name').fill(KIT_NAME)
  for (const [key, value] of Object.entries(KIT_PALETTE)) await pageA.getByTestId(`kit-color-${key}`).fill(value)
  await pageA.getByTestId('kit-font-heading').selectOption('Georgia, serif')
  await pageA.getByTestId('kit-font-body').selectOption('Arial, sans-serif')
  await pageA.getByTestId('kit-logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: LOGO_PNG })
  await pageA.getByTestId('kit-placement-corner').selectOption('br')
  await pageA.getByTestId('kit-placement-size').fill('14')
  await pageA.getByTestId('kit-placement-margin').fill('40')
  await pageA.getByTestId('kit-placement-slides').selectOption('all-but-title')
  await pageA.getByTestId('kit-save').click()
  await pageA.getByRole('status').filter({ hasText: 'Brand kit created.' }).waitFor({ state: 'visible', timeout: 20000 })
  const kitRow = pageA.locator('[data-testid^="kit-row-"]').filter({ hasText: KIT_NAME }).first()
  await kitRow.waitFor({ state: 'visible', timeout: 10000 })
  const kitId = (await kitRow.getAttribute('data-testid')).replace(/^kit-row-/, '')
  check(/^[0-9a-f-]{36}$/.test(kitId), 'the brand kit was created with a PNG logo')
  await kitRow.locator('[data-testid^="kit-edit-"]').click()
  await pageA.getByTestId('kit-editor').waitFor({ state: 'visible', timeout: 10000 })
  await waitUntil(
    'the saved logo previews in the kit editor',
    async () => pageA.getByTestId('kit-logo-saved').evaluate((img) => img.complete && img.naturalWidth > 0),
    20000,
  )
  check((await pageA.getByTestId('kit-placement-preview').locator('img').count()) === 1, 'the placement preview shows the saved logo')
  await pageA.getByTestId('kit-editor').screenshot({ path: shot('kit-editor-saved-logo.png') })
  log('kit-editor-saved-logo.png saved (the saved logo in the kit editor)')
  await pageA.getByTestId('kit-editor').getByRole('button', { name: 'Cancel', exact: true }).click()

  // ---- A shares the deck with B (editor), and B opens it, to see the change live.
  await pageA.goto(`${base}/d/${deckId}`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await statusSaved(pageA).waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByRole('button', { name: 'Share', exact: true }).click()
  const share = pageA.getByRole('dialog', { name: 'Share deck' })
  await share.waitFor({ state: 'visible', timeout: 10000 })
  await share.getByLabel('Add people by email').fill(people.b.email)
  await share.getByLabel('Invite role').selectOption('editor')
  await share.getByRole('button', { name: 'Send invite' }).click()
  // B signed up before this invite, so the invite is a membership at once (listed with the people, not as pending).
  await share.getByText(people.b.email).first().waitFor({ state: 'visible', timeout: 10000 })
  await share.getByRole('button', { name: 'Done' }).click()

  await waitUntil(
    'B sees the shared deck',
    async () => {
      await pageB.goto(`${base}/`)
      await pageB.waitForLoadState('networkidle')
      await pageB.getByRole('tab', { name: 'Shared with me' }).click()
      return (await pageB.getByRole('link', { name: new RegExp(DECK_TITLE) }).count()) > 0
    },
    25000,
    1000,
  )
  await pageB.getByRole('link', { name: new RegExp(DECK_TITLE) }).click()
  await pageB.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await statusSaved(pageB).waitFor({ state: 'visible', timeout: 20000 })
  const nonTitle = template.slides.findIndex((s) => s.layout !== 'title')
  check(nonTitle >= 0, 'the deck has a slide that is not a title slide')
  await pageB.locator('[id^="thumb-"]').nth(nonTitle).click()
  check(true, 'B opened the deck as an editor')

  // ---- A applies the kit in the editor.
  await pageA.locator('[id^="thumb-"]').nth(nonTitle).click()
  const before = await internalJson(deckId)
  const contentOf = (deck) => deck.slides.map((s) => ({ id: s.id, layout: s.layout, elements: s.elements }))
  const contentBefore = contentOf(before)
  await pageA.getByRole('tab', { name: 'Theme' }).click()
  await pageA.getByTestId('brand-kit-section').waitFor({ state: 'visible', timeout: 15000 })
  await pageA.waitForFunction(() => document.querySelectorAll('[data-testid=brand-kit-select] option').length > 1, null, { timeout: 15000 })
  await pageA.getByTestId('brand-kit-select').selectOption({ label: KIT_NAME })
  await pageA.getByTestId('brand-kit-apply').click()
  await pageA.getByTestId('brand-kit-applied').waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByTestId('brand-kit-logo-preview').waitFor({ state: 'attached', timeout: 10000 })
  const logoOnA = pageA.locator('[data-testid=slide-canvas] img[data-brand-logo]')
  await waitUntil('the logo is on the canvas (A)', async () => (await logoOnA.count()) === 1, 10000)
  check(true, 'the kit is applied: the logo is on the canvas of a non-title slide')

  const after = await internalJson(deckId)
  check(after.theme.name === KIT_NAME && after.theme.colors.accent === KIT_PALETTE.accent, 'the deck theme is the kit theme')
  check(after.brand?.brandKitId === kitId && /^\/api\/assets\//.test(after.brand?.logo?.src ?? ''), 'the deck records the kit and a logo of its own')
  check(JSON.stringify(contentOf(after)) === JSON.stringify(contentBefore), 'applying the kit leaves every slide and element unchanged')

  // B sees the theme and the logo live.
  await waitUntil('B sees the kit theme live', async () => (await pageB.getByLabel('Theme', { exact: true }).inputValue()) === KIT_NAME, 15000)
  await waitUntil('B sees the logo live', async () => (await pageB.locator('[data-testid=slide-canvas] img[data-brand-logo]').count()) === 1, 15000)
  check(true, 'B sees the kit theme and the logo live, without reloading')
  await pageB.screenshot({ path: shot('collab-branded-b.png') })

  await pageA.screenshot({ path: shot('branded-editor.png') })
  log('branded-editor.png saved (the editor with the kit applied)')

  // ---- Present: the logo on the non-title slides only.
  const audiencePromise = ctxA.waitForEvent('page')
  await pageA.getByRole('button', { name: 'Present', exact: true }).click()
  const audience = await audiencePromise
  watch(audience, 'audience')
  await audience.waitForURL(/\/present/, { timeout: 20000 })
  await audience.getByTestId('present-root').waitFor({ state: 'visible', timeout: 20000 })
  await audience.locator('section.present').waitFor({ state: 'attached', timeout: 20000 })
  await sleep(800)
  const presentLogos = await audience.evaluate(() =>
    Array.from(document.querySelectorAll('section')).map((s) => ({ logo: s.querySelector('img.sleid-brand-logo') !== null })),
  )
  const slidesNow = (await internalJson(deckId)).slides
  check(presentLogos.length === slidesNow.length, `present mode has ${presentLogos.length} slides, the deck has ${slidesNow.length}`)
  const wrong = slidesNow.map((s, i) => ({ i, layout: s.layout, logo: presentLogos[i]?.logo })).filter((x) => x.logo !== (x.layout !== 'title'))
  check(wrong.length === 0, `present mode shows the logo on the non-title slides only${wrong.length ? ` (wrong on ${JSON.stringify(wrong)})` : ''}`)
  await audience.screenshot({ path: shot('branded-present.png') })
  log('branded-present.png saved (present mode)')
  await audience.close()

  // ---- PNG export of the current slide carries the logo.
  await pageA.getByRole('menuitem', { name: 'File', exact: true }).click()
  await pageA.getByRole('group', { name: 'Download' }).getByRole('menuitem', { name: 'PNG (.png)', exact: true }).click()
  const exportDialog = pageA.getByRole('dialog', { name: 'Export PNG' })
  await exportDialog.waitFor({ state: 'visible', timeout: 10000 })
  await exportDialog.getByLabel('Current slide only').check()
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click()
  const link = pageA.getByRole('link', { name: /^Download .*\.png$/ }).first()
  const deadline = Date.now() + 150000
  while (!(await link.isVisible().catch(() => false))) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the PNG export')
    if (await pageA.getByRole('alert').filter({ hasText: 'Export failed' }).first().isVisible().catch(() => false)) {
      throw new Error(`export failed: ${await pageA.getByRole('alert').filter({ hasText: 'Export failed' }).first().textContent()}`)
    }
    await sleep(500)
  }
  const [download] = await Promise.all([pageA.waitForEvent('download'), link.click()])
  const pngPath = shot('m9-current-slide.png')
  await download.saveAs(pngPath)
  const pngBytes = readFileSync(pngPath)
  const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
  const decoder = await ctxA.newPage()
  await decoder.setContent('<html><body></body></html>')
  const sample = await samplePng(decoder, dataUrl, LOGO_RGB)
  await decoder.close()
  check(sample.close, `the PNG export carries the logo at its corner (${sample.W}x${sample.H}, pixel ${sample.avg.join(',')}, expected ${LOGO_RGB.join(',')})`)

  // ---- AI: an off-palette accent proposed by the fake model is snapped to a kit colour before it is stored.
  await pageA.getByRole('tab', { name: 'AI', exact: true }).click()
  await pageA.getByLabel('Message the assistant').fill('Recolour the accent to an off-palette orange')
  await pageA.getByLabel('Message the assistant').press('Enter')
  const aiCard = pageA.locator('section[aria-label^="Proposal: Recolour the accent"]')
  await aiCard.waitFor({ state: 'visible', timeout: 40000 })
  await aiCard.getByRole('button', { name: 'Apply', exact: true }).click()
  await waitUntil('the accent changes', async () => (await internalJson(deckId)).theme.colors.accent !== KIT_PALETTE.accent, 20000)
  const aiDeck = await internalJson(deckId)
  const palette = Object.values(aiDeck.brand?.palette ?? {}).map((c) => c.toLowerCase())
  const storedAccent = aiDeck.theme.colors.accent.toLowerCase()
  check(palette.includes(storedAccent), `the accent the AI stored (${storedAccent}) is a kit colour`)
  check(storedAccent !== '#f97316', 'the off-palette orange the model proposed was not stored')
  check(fake.seen.some((r) => JSON.stringify(r.body).includes('off-palette')), 'the fake model received the request')

  // ---- Wizard: the built-in Minimal template and the kit, with research over the fake SearXNG.
  await pageA.goto(`${base}/wizard/new`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByLabel(/What is the deck about/).fill(`${WIZARD_TITLE} in Jakarta`)
  await pageA.getByLabel(/Audience/).fill('bakery owners')
  await pageA.getByTestId('wizard-template-picker').waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByTestId('wizard-template-picker').selectOption('builtin:minimal')
  await pageA.getByTestId('wizard-brand-kit-picker').selectOption({ label: KIT_NAME })
  await pageA.getByRole('button', { name: 'Next: references', exact: true }).click()
  await pageA.waitForURL(/\/wizard\/[0-9a-f-]{36}$/, { timeout: 20000 })
  await pageA.getByRole('heading', { name: '2. References (optional)' }).waitFor({ state: 'visible', timeout: 15000 })
  await pageA.getByLabel(/Let AI research this topic/).check()
  await pageA.getByRole('button', { name: 'Research now', exact: true }).click()
  await pageA.getByText('Solar power for small bakeries').first().waitFor({ state: 'visible', timeout: 60000 })
  await waitUntil('research pages are ready', async () => (await pageA.getByText(/^(queued|running)$/).count()) === 0, 60000, 400)
  check(true, 'research added the search pages as references')
  await pageA.getByRole('button', { name: 'Draft outline', exact: true }).click()
  await pageA.getByLabel('Slide 2 title').waitFor({ state: 'visible', timeout: 60000 })
  await pageA.getByRole('button', { name: 'Generate deck', exact: true }).click()
  await pageA.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 30000 })
  const wizardDeckId = new URL(pageA.url()).pathname.split('/')[2]
  const banner = pageA.getByRole('status', { name: 'Wizard progress' })
  await banner.waitFor({ state: 'visible', timeout: 30000 })
  await waitUntil('the wizard run completes', async () => /Generated from prompt/.test(await banner.innerText().catch(() => '')), 150000, 500)
  check(true, 'the wizard run completed')
  const wizardDeck = await internalJson(wizardDeckId)
  check(wizardDeck.theme.name === KIT_NAME, `the wizard deck has the kit theme (${wizardDeck.theme.name})`)
  check(/^\/api\/assets\//.test(wizardDeck.brand?.logo?.src ?? ''), 'the wizard deck has the kit logo')
  await pageA.screenshot({ path: shot('wizard-result.png'), fullPage: true })
  log('wizard-result.png saved (the deck the wizard made)')

  // ---- Clean up what this check made: the kit and the two templates (decks keep their own copies).
  pageA.on('dialog', (d) => void d.accept())
  await pageA.goto(`${base}/settings/brand-kits`)
  await pageA.waitForLoadState('networkidle')
  await pageA.locator('[data-testid^="kit-row-"]').filter({ hasText: KIT_NAME }).first().locator('[data-testid^="kit-delete-"]').click()
  await waitUntil('the kit is deleted', async () => (await pageA.locator('[data-testid^="kit-row-"]').filter({ hasText: KIT_NAME }).count()) === 0, 15000)
  await pageA.goto(`${base}/settings/templates`)
  await pageA.waitForLoadState('networkidle')
  for (const name of [TEMPLATE_NAME, PRIVATE_NAME]) {
    const row = pageA.locator('[data-testid^="template-row-"]').filter({ hasText: name }).first()
    if ((await row.count()) > 0) {
      await row.getByTestId('template-delete').click()
      await waitUntil(`${name} is deleted`, async () => (await pageA.locator('[data-testid^="template-row-"]').filter({ hasText: name }).count()) === 0, 15000)
    }
  }
  log('deleted the brand kit and the two templates this check made')

  const real = errors.filter((e) => !/favicon/.test(e))
  check(real.length === 0, `no page or console errors${real.length ? `: ${real.slice(0, 5).join(' | ')}` : ''}`)
  console.log('m9 check passed')
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => undefined)
  await browser.close()
  await fake.close()
}
if (process.exitCode) process.exit(process.exitCode)

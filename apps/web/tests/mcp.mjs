// M5 live check: a personal access token made through the settings page, an editor open in the browser, and MCP
// calls from Node (the official SDK client, Streamable HTTP). The open editor must show each change within 3 seconds.
// Needs `pnpm dev` running with SLEID_TEST_AUTH=1, COLLAB_TOKEN_SECRET, COLLAB_INTERNAL_SECRET (the worker is part of
// `pnpm dev`, so render_slide works).
//   CHROME_PATH=... SCREENSHOT_DIR=... node tests/mcp.mjs [http://localhost:3000]
// Writes mcp-tokens.png, mcp-live.png and mcp-render.png to SCREENSHOT_DIR.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright-core'
import postgres from 'postgres'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
mkdirSync(shotDir, { recursive: true })
const stamp = Date.now().toString(36)
const password = 'password123'
const person = { name: 'Mcp Live', email: `mcp-live-${stamp}@example.com` }
const LIVE_BUDGET_MS = 3000

const log = (msg) => console.log(`ok  ${msg}`)
const check = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  log(msg)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(label, fn, timeoutMs, intervalMs = 50) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return Date.now() - started
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms: ${label}`)
    await sleep(intervalMs)
  }
}

const waitSaved = (page) => page.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
const thumbs = (page) => page.locator('[id^="thumb-"]').count()

async function signUpAndIn(ctx) {
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await ctx.request.post(`${base}/api/auth/sign-up/email`, { headers, data: { name: person.name, email: person.email, password } })
  if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email: person.email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()} ${await signIn.text()}`)
}

/** Calls a tool and returns its parsed JSON text (or throws with the tool's error text). */
async function call(mcp, name, args) {
  const result = await mcp.callTool({ name, arguments: args })
  const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text)
}

/** Inserts a brand kit for the user with the given email, and writes its logo to the asset store. Returns the kit id. */
async function seedBrandKit(email) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is needed to seed a brand kit (run with the same .env as pnpm dev)')
  const sql = postgres(url, { max: 1 })
  try {
    const [owner] = await sql`select id from "user" where email = ${email}`
    if (!owner) throw new Error(`no user for ${email}`)
    const kitId = randomUUID()
    const logoKey = `brand-logos/${kitId}-logo.png`
    const assetDir = process.env.ASSET_DIR ? resolve(process.env.ASSET_DIR) : resolve(process.cwd(), '../../data/assets')
    mkdirSync(join(assetDir, 'brand-logos'), { recursive: true })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    writeFileSync(join(assetDir, logoKey), png)
    const tokens = {
      palette: { background: '#ffffff', surface: '#f8f9fa', text: '#202124', muted: '#5f6368', accent: '#0b57d0', accent2: '#188038', accent3: '#e37400', accent4: '#a142f4' },
      fonts: { heading: 'Helvetica, sans-serif', body: 'Helvetica, sans-serif' },
    }
    await sql`insert into brand_kits (id, owner_id, name, visibility, tokens, logo_key, logo_mime, logo_bytes, logo_sha256, logo_placement)
      values (${kitId}, ${owner.id}, 'E2E Kit', 'private', ${sql.json(tokens)}, ${logoKey}, 'image/png', ${png.byteLength}, ${'0'.repeat(64)}, ${sql.json({ corner: 'tr', widthPct: 12, margin: 48, slides: 'all-but-title' })})`
    return kitId
  } finally {
    await sql.end({ timeout: 2 })
  }
}

const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
let mcp = null
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  await signUpAndIn(ctx)

  // ---- Create the token in the settings UI.
  await page.goto(`${base}/settings/tokens`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('heading', { name: 'MCP access tokens' }).waitFor({ state: 'visible', timeout: 20000 })
  await page.getByLabel('Name (so you can tell it apart later)', { exact: true }).fill('Live check')
  await page.getByRole('button', { name: 'Create token', exact: true }).click()
  const tokenBox = page.getByRole('textbox', { name: 'Token', exact: true })
  await tokenBox.waitFor({ state: 'visible', timeout: 15000 })
  const secret = await tokenBox.inputValue()
  check(/^sleid_pat_[A-Za-z0-9_-]{43}$/.test(secret), 'the settings page shows a new sleid_pat_ token once')
  check((await page.getByText('Copy “Live check” now').count()) > 0, 'the copy-once panel names the token')
  check((await page.getByText('claude mcp add --transport http sleid').count()) > 0, 'the Claude Code command is shown')
  await page.screenshot({ path: join(shotDir, 'mcp-tokens.png'), fullPage: true })
  log('mcp-tokens.png saved')

  // ---- Open a deck in the editor (the live view).
  await page.goto(`${base}/`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  const deckId = new URL(page.url()).pathname.split('/')[2]
  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await waitSaved(page)
  await page.getByLabel('Deck title').fill(`MCP live ${stamp}`)
  await page.getByLabel('Deck title').press('Enter')
  await waitSaved(page)
  check((await thumbs(page)) === 1, 'the editor opens the new deck with one slide')

  // ---- The agent connects with the token (Streamable HTTP, the official SDK client).
  mcp = new Client({ name: 'sleid-live-check', version: '0.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }))
  const { tools } = await mcp.listTools()
  check(tools.some((t) => t.name === 'render_slide') && tools.length >= 17, `the agent sees ${tools.length} tools`)

  const listed = await call(mcp, 'list_decks', {})
  check(listed.decks.some((d) => d.id === deckId), 'list_decks includes the deck open in the editor')

  // Slide 1 (title), slide 2 (bullets): each should appear in the open editor within 3 s.
  const cover = await call(mcp, 'add_slide', { deckId, layout: 'title', title: 'Solar at the shop', body: 'Lower bills' })
  const coverMs = await waitUntil('cover slide in the editor', () => thumbs(page).then((n) => n === 2), LIVE_BUDGET_MS)
  await page.getByText('Solar at the shop', { exact: true }).first().waitFor({ state: 'visible', timeout: LIVE_BUDGET_MS })
  log(`the cover slide reached the open editor in ${coverMs} ms (budget ${LIVE_BUDGET_MS} ms)`)

  const bullets = await call(mcp, 'add_slide', {
    deckId,
    layout: 'title-content',
    title: 'Why it pays',
    body: 'Lower power bills\n- Panels on the roof\n- **Battery** for night use',
    notes: 'Numbers are estimates.',
  })
  const bulletsMs = await waitUntil('bullets slide in the editor', () => thumbs(page).then((n) => n === 3), LIVE_BUDGET_MS)
  await page.getByText('Why it pays', { exact: true }).first().waitFor({ state: 'visible', timeout: LIVE_BUDGET_MS })
  log(`the bullet slide reached the open editor in ${bulletsMs} ms (budget ${LIVE_BUDGET_MS} ms)`)

  // A blank slide for the chart: open it in the editor first, then insert the chart through MCP.
  const chartSlide = await call(mcp, 'add_slide', { deckId, layout: 'blank' })
  await waitUntil('blank slide thumbnail', () => page.locator(`#thumb-${chartSlide.slideId}`).count().then((n) => n === 1), LIVE_BUDGET_MS)
  await page.locator(`#thumb-${chartSlide.slideId}`).click()
  const chart = await call(mcp, 'insert_chart', {
    deckId,
    slideId: chartSlide.slideId,
    chartType: 'bar',
    columns: ['Month', 'Saving'],
    rows: [
      ['Jan', 10],
      ['Feb', 14],
      ['Mar', 19],
    ],
    title: 'Saving per month',
  })
  const chartMs = await waitUntil('chart in the editor', () => page.locator('[data-type="chart"]').count().then((n) => n >= 1), LIVE_BUDGET_MS)
  log(`the chart reached the open editor in ${chartMs} ms (budget ${LIVE_BUDGET_MS} ms), element ${chart.elementId}`)

  // A diagram that the parser refuses: the agent gets the parse error, and the editor is unchanged.
  const badDiagram = await mcp.callTool({ name: 'insert_diagram', arguments: { deckId, slideId: chartSlide.slideId, mermaid: 'graph LR\nShop appliances --> Battery' } })
  check(badDiagram.isError === true, 'an invalid Mermaid source is refused with an error for the agent')
  check((await page.locator('[data-type="diagram"]').count()) === 0, 'the editor shows no diagram after the refusal')

  await waitSaved(page)
  await page.screenshot({ path: join(shotDir, 'mcp-live.png'), fullPage: true })
  log('mcp-live.png saved')

  // ---- render_slide returns the slide as a PNG the agent can look at.
  // A render reads the saved state when the worker cannot reach the live document, and that lags the edit by about
  // 2 seconds (the collab store debounce). Wait for the save first, so the check does not depend on that timing.
  await sleep(3000)
  const rendered = await mcp.callTool({ name: 'render_slide', arguments: { deckId, slideId: chartSlide.slideId } })
  check(rendered.isError !== true, `render_slide succeeded${rendered.isError ? `: ${(rendered.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 300)}` : ''}`)
  const image = rendered.content.find((c) => c.type === 'image')
  check(image && image.mimeType === 'image/png', 'render_slide returned image content (image/png)')
  const png = Buffer.from(image.data, 'base64')
  const signature = [...png.subarray(0, 8)].join(',')
  check(signature === '137,80,78,71,13,10,26,10', 'the returned image has a PNG signature')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  check(width === 1920 && height === 1080, `the PNG is ${width} x ${height}`)
  writeFileSync(join(shotDir, 'mcp-render.png'), png)
  log('mcp-render.png saved')

  // ---- import_deck: a small markdown deck, made by the worker. Three "---" sections must give three slides.
  const imported = await call(mcp, 'import_deck', {
    format: 'markdown',
    title: `MCP import ${stamp}`,
    text: '# Import one\n\nFirst slide\n\n---\n\n# Import two\n\n- alpha\n- beta\n\n---\n\n# Import three\n\nLast slide',
  })
  check(/^[0-9a-f-]{36}$/.test(imported.deckId) && imported.url.endsWith(`/d/${imported.deckId}`), 'import_deck returns the deck id and its URL')
  const importedDeck = await call(mcp, 'get_deck', { deckId: imported.deckId, format: 'json' })
  check(importedDeck.title === `MCP import ${stamp}`, 'the imported deck has the title given to import_deck')
  check(importedDeck.slides.length === 3, `the imported deck has ${importedDeck.slides.length} slides (expected 3)`)

  // ---- M9: templates and brand kits through MCP. A kit is seeded in the database for this user (no MCP tool makes
  // a kit), with its logo written to the asset folder the way the server stores it.
  const templates = await call(mcp, 'list_templates', {})
  check(templates.templates.some((t) => t.id === 'builtin:pitch' && t.builtIn === true), 'list_templates includes the built-in Pitch template')
  const fromTemplate = await call(mcp, 'create_deck', { title: `Template deck ${stamp}`, templateId: 'builtin:pitch' })
  check(/^[0-9a-f-]{36}$/.test(fromTemplate.id), 'create_deck with templateId returns a deck id')
  const templateDeck = await call(mcp, 'get_deck', { deckId: fromTemplate.id, format: 'json' })
  check(templateDeck.slides.length >= 4 && templateDeck.theme.name === 'Midnight', `the template deck has ${templateDeck.slides.length} slides on the Midnight theme`)

  const kitId = await seedBrandKit(person.email)
  const kits = await call(mcp, 'list_brand_kits', {})
  check(kits.brandKits.some((k) => k.id === kitId && k.hasLogo === true), 'list_brand_kits includes the seeded kit, with its logo')
  const applied = await call(mcp, 'apply_brand_kit', { deckId: fromTemplate.id, brandKitId: kitId })
  check(applied.logo === true && applied.theme === 'E2E Kit', 'apply_brand_kit applies the kit and its logo')
  const branded = await call(mcp, 'get_deck', { deckId: fromTemplate.id, format: 'json' })
  check(branded.brand?.brandKitId === kitId && /^\/api\/assets\//.test(branded.brand?.logo?.src ?? ''), 'the deck records the kit and a logo asset of its own')
  check(branded.theme.colors.accent === '#0b57d0', 'the deck theme takes the kit accent colour')
  await call(mcp, 'apply_brand_kit', { deckId: fromTemplate.id, brandKitId: null })
  const unbranded = await call(mcp, 'get_deck', { deckId: fromTemplate.id, format: 'json' })
  check(unbranded.brand === undefined && unbranded.theme.name === 'E2E Kit', 'removing the kit clears the logo and keeps the theme')

  for (const e of errors) console.log(`  captured: ${e.slice(0, 400)}`)
  check(errors.length === 0, `no page or console errors (${errors.length})`)
  console.log(`\nMCP live check passed (deck ${deckId}).`)
} finally {
  await mcp?.close().catch(() => undefined)
  await browser.close()
}

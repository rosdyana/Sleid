// M0 smoke test plus the M1b editor e2e.
// Requires the dev server running with SLEID_TEST_AUTH=1 (email+password login enabled).
// Usage: node tests/smoke.mjs [baseUrl]   (default http://localhost:3000)
// Browser: uses CHROME_PATH if set, otherwise the Playwright-managed Chromium.
// Screenshots go to SCREENSHOT_DIR (default: test-results/screenshots).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const stamp = Date.now().toString(36)
const email = `smoke-${stamp}@example.com`
const password = 'password123'
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
mkdirSync(shotDir, { recursive: true })

const log = (msg) => console.log(`ok  ${msg}`)
const check = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  log(msg)
}

async function slideOrder(page) {
  return page.$$eval('[id^="thumb-"]', (els) => els.map((e) => e.id.replace(/^thumb-/, '')))
}

async function waitSaved(page) {
  await page.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
}

const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
try {
  // 1. Unauthenticated visit to "/" must redirect to /login.
  const anon = await browser.newContext()
  const anonPage = await anon.newPage()
  await anonPage.goto(`${base}/`)
  await anonPage.waitForURL('**/login', { timeout: 20000 })
  await anonPage.getByRole('button', { name: 'Sign in with Google' }).waitFor({ state: 'visible', timeout: 10000 })
  log('unauthenticated / redirects to /login')
  await anon.close()

  // 2. Sign up, then sign in, through the test-only email+password API.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await ctx.request.post(`${base}/api/auth/sign-up/email`, {
    headers,
    data: { name: 'Smoke Tester', email, password },
  })
  if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()} ${await signIn.text()}`)
  log('sign-up and sign-in via /api/auth')

  // 3. Dashboard renders and "Blank deck" creates a deck and opens the editor.
  await page.goto(`${base}/`)
  await page.waitForLoadState('networkidle')
  const blank = page.getByRole('button', { name: 'Blank deck' })
  await blank.waitFor({ state: 'visible', timeout: 20000 })
  await blank.click()
  await page.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  log(`Blank deck created, now at ${new URL(page.url()).pathname}`)

  // 4. Editor shell renders with the Sheets-style chrome.
  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('button', { name: 'Share' }).waitFor({ state: 'visible', timeout: 10000 })
  await page.getByLabel('Deck title').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-testid=slide-canvas] [data-type=text]').first().waitFor({ state: 'attached', timeout: 10000 })
  await page.screenshot({ path: join(shotDir, 'editor-1.png') })
  log('editor shell renders; empty-ish deck screenshot saved to editor-1.png')

  // 5. Rename the deck. The title is an op, so the save status cycles back to saved.
  const title = page.getByLabel('Deck title')
  await title.fill('Quarterly review')
  await title.press('Enter')
  await waitSaved(page)
  log('title edited and saved')

  // 6. Add a text box, type into it with TipTap, and commit by clicking away.
  await page.getByRole('button', { name: 'Text box' }).click()
  const newText = page.locator('[data-testid=slide-canvas] [data-type=text]').last()
  await newText.dblclick()
  const editor = page.locator('.ProseMirror.ProseMirror-focused').first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Hello sleid')
  check((await editor.textContent()) === 'Hello sleid', 'select-all replaced the placeholder text')
  await page.getByLabel('Deck title').click()
  await page.locator('[data-testid=slide-canvas] [data-type=text]').filter({ hasText: 'Hello sleid' }).first().waitFor({ state: 'visible', timeout: 10000 })
  log('text box typed and committed through TipTap')

  // 7. Insert a bar chart from the toolbar and open its data grid from the fx bar.
  await page.getByLabel('Insert chart').selectOption('bar')
  await page.locator('[data-testid=slide-canvas] [data-type=chart]').first().waitFor({ state: 'attached', timeout: 10000 })
  await page.getByRole('button', { name: 'Open data' }).click()
  const grid = page.getByRole('grid', { name: 'Chart data grid' })
  await grid.waitFor({ state: 'visible', timeout: 10000 })
  log('bar chart inserted and data grid opened')

  // 8. Edit a data cell: Feb / Series 1 (row 2, column 1) from 7 to 42.
  // Default bar chart: header plus three data rows, three columns (category, Series 1, Series 2).
  const cells = grid.getByRole('gridcell')
  check((await cells.count()) === 12, 'data grid shows header plus three rows of three cells')
  await cells.nth(2 * 3 + 1).dblclick()
  await grid.getByLabel('Cell editor').fill('42')
  await grid.getByLabel('Cell editor').press('Enter')
  await waitSaved(page)
  await page.getByRole('gridcell').filter({ hasText: '42' }).first().waitFor({ state: 'visible', timeout: 10000 })
  log('chart data cell edited to 42')

  // 9. Click the canvas background (leaves the grid), then add a slide with Ctrl/Cmd+Enter.
  await page.locator('[data-testid=slide-canvas]').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('ControlOrMeta+Enter')
  await page.locator('[id^="thumb-"]').nth(1).waitFor({ state: 'attached', timeout: 10000 })
  const before = await slideOrder(page)
  check(before.length === 2, `two slides after Cmd+Enter (got ${before.length})`)
  await waitSaved(page)

  // 10. Reorder by dragging the second thumbnail onto the top of the first.
  const first = page.locator(`#thumb-${before[0]}`)
  const second = page.locator(`#thumb-${before[1]}`)
  await second.dragTo(first, { targetPosition: { x: 40, y: 6 } })
  await page.waitForFunction(
    (expected) => {
      const ids = Array.from(document.querySelectorAll('[id^="thumb-"]')).map((e) => e.id.replace(/^thumb-/, ''))
      return ids.length === expected.length && ids.every((id, i) => id === expected[i])
    },
    [before[1], before[0]],
    { timeout: 10000 },
  )
  const reordered = await slideOrder(page)
  check(reordered[0] === before[1] && reordered[1] === before[0], 'slides reordered by drag in the filmstrip')
  await waitSaved(page)

  // 11. Undo reverts the drag, redo puts it back.
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForFunction(
    (expected) => {
      const ids = Array.from(document.querySelectorAll('[id^="thumb-"]')).map((e) => e.id.replace(/^thumb-/, ''))
      return ids.length === expected.length && ids.every((id, i) => id === expected[i])
    },
    before,
    { timeout: 10000 },
  )
  log('Undo reverted the slide move')
  await page.getByRole('button', { name: 'Redo' }).click()
  await page.waitForFunction(
    (expected) => {
      const ids = Array.from(document.querySelectorAll('[id^="thumb-"]')).map((e) => e.id.replace(/^thumb-/, ''))
      return ids.length === expected.length && ids.every((id, i) => id === expected[i])
    },
    reordered,
    { timeout: 10000 },
  )
  log('Redo re-applied the slide move')
  await waitSaved(page)

  // 12. Reload: everything persisted.
  await page.reload()
  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  check((await page.getByLabel('Deck title').inputValue()) === 'Quarterly review', 'title persisted after reload')
  check((await slideOrder(page)).join(',') === reordered.join(','), 'slide order persisted after reload')
  // The editor opens on the first slide, which is the empty one after the move. Go to the chart slide.
  await page.locator(`#thumb-${before[0]}`).click()
  await page.locator('[data-testid=slide-canvas] [data-type=chart]').first().waitFor({ state: 'attached', timeout: 20000 })
  await page.locator('[data-testid=slide-canvas] [data-type=text]').filter({ hasText: 'Hello sleid' }).first().waitFor({ state: 'attached', timeout: 10000 })
  check(true, 'typed text persisted after reload')
  await page.locator('[data-testid=slide-canvas] [data-type=chart]').first().click({ position: { x: 20, y: 20 } })
  await page.getByRole('button', { name: 'Open data' }).click()
  await page.getByRole('gridcell').filter({ hasText: '42' }).first().waitFor({ state: 'attached', timeout: 10000 })
  check(true, 'chart data edit persisted after reload')
  await page.locator('[data-testid=slide-canvas]').click({ position: { x: 4, y: 4 } })
  await page.screenshot({ path: join(shotDir, 'editor-2.png') })
  log('editor-2.png saved (chart and data grid open)')

  // 13. Present: a new tab opens reveal.js with one section per slide.
  const presentBtn = page.getByRole('button', { name: 'Present' })
  const [presentPage] = await Promise.all([ctx.waitForEvent('page'), presentBtn.click()])
  await presentPage.waitForLoadState('domcontentloaded')
  await presentPage.locator('.reveal .slides section').first().waitFor({ state: 'attached', timeout: 20000 })
  await presentPage.waitForFunction(() => document.querySelector('.reveal')?.classList.contains('ready'), null, { timeout: 20000 })
  const sections = await presentPage.locator('.reveal .slides section').count()
  check(sections === reordered.length, `present shows ${sections} reveal sections, deck has ${reordered.length} slides`)
  await presentPage.screenshot({ path: join(shotDir, 'present-1.png') })
  log('present-1.png saved')
  await presentPage.close()

  // 14. Health endpoint.
  const health = await ctx.request.get(`${base}/api/health`)
  const body = await health.json()
  if (!health.ok() || body.ok !== true) throw new Error(`health check failed: ${health.status()} ${JSON.stringify(body)}`)
  log('/api/health returns {ok:true}')

  await ctx.close()
} catch (e) {
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
} finally {
  await browser.close()
}

if (errors.length) {
  console.error(`browser errors:\n${errors.join('\n')}`)
  process.exitCode = 1
}
if (process.exitCode) process.exit(process.exitCode)
console.log('smoke passed')

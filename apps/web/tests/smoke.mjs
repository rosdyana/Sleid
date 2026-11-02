// M0 smoke test. Requires the dev server running with SLEID_TEST_AUTH=1 (email+password login enabled).
// Usage: node tests/smoke.mjs [baseUrl]   (default http://localhost:3000)
// Browser: uses CHROME_PATH if set, otherwise the Playwright-managed Chromium.
import { chromium } from 'playwright-core'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const stamp = Date.now().toString(36)
const email = `smoke-${stamp}@example.com`
const password = 'password123'
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}

const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
try {
  // 1. Unauthenticated visit to "/" must redirect to /login.
  const anon = await browser.newContext()
  const anonPage = await anon.newPage()
  await anonPage.goto(`${base}/`)
  await anonPage.waitForURL('**/login', { timeout: 20000 })
  await anonPage.getByRole('button', { name: 'Sign in with Google' }).waitFor({ state: 'visible', timeout: 10000 })
  console.log('ok  unauthenticated / redirects to /login')
  await anon.close()

  // 2. Sign up, then sign in, through the test-only email+password API.
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } })
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
  console.log('ok  sign-up and sign-in via /api/auth')

  // 3. Dashboard renders and "Blank deck" creates a deck and opens the editor.
  await page.goto(`${base}/`)
  // Wait for hydration: a click on SSR-only HTML does nothing.
  await page.waitForLoadState('networkidle')
  const blank = page.getByRole('button', { name: 'Blank deck' })
  await blank.waitFor({ state: 'visible', timeout: 20000 })
  await blank.click()
  await page.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  console.log(`ok  Blank deck created, now at ${new URL(page.url()).pathname}`)

  // 4. Editor shell renders with the Sheets-style chrome.
  await page.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 20000 })
  await page.getByRole('button', { name: 'Share' }).waitFor({ state: 'visible', timeout: 10000 })
  await page.getByLabel('Deck title').waitFor({ state: 'visible', timeout: 10000 })
  console.log('ok  editor shell renders (menu bar "Extensions", Share, title)')

  // 5. Health endpoint.
  const health = await ctx.request.get(`${base}/api/health`)
  const body = await health.json()
  if (!health.ok() || body.ok !== true) throw new Error(`health check failed: ${health.status()} ${JSON.stringify(body)}`)
  console.log('ok  /api/health → {ok:true}')

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

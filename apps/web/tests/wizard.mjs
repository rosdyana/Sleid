// M6 browser check: the prompt-to-deck wizard, end to end, against a fake model and a fake SearXNG.
// Needs the dev stack running with (all via environment, none in files):
//   SLEID_TEST_AUTH=1                     email+password login for the test users
//   LLM_USER_ALLOW_PRIVATE_URLS=1         a user's provider may be the local fake model
//   SLEID_TEST_PRIVATE_WIZARD_URLS=1      the wizard's URL references may be on the local fake SearXNG (test only; refused in production)
//   LLM_SECRET_KEY=<32 random bytes, base64>
//   SEARXNG_URL=http://127.0.0.1:4412     research on, served by the fake (see tests/fake-searxng.mjs)
//   COLLAB_TOKEN_SECRET, COLLAB_INTERNAL_SECRET
// Start the fake SearXNG first, in its own terminal:  node tests/fake-searxng.mjs 4412
// The dev stack must be started with those variables set (the web app, the collab service and the worker all read them).
// Usage: node tests/wizard.mjs [http://localhost:3000]     (SCREENSHOT_DIR, CHROME_PATH and WIZARD_SEARXNG_URL are optional)
// Covers: brief, a CSV file and a web address as references, research, the outline (rename, reorder, delete), generation
// with slides arriving live (slide counts rise over time through the collab service), done, and the Sources list.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { startFakeOpenAI } from './fake-openai-server.mjs'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const SEARXNG = (process.env.WIZARD_SEARXNG_URL ?? 'http://127.0.0.1:4412').replace(/\/$/, '')
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
mkdirSync(shotDir, { recursive: true })
const stamp = Date.now().toString(36)
const password = 'password123'
const LOCAL_KEY = `sk-wizard-local-${stamp}`
const who = { name: 'Wizard Wes', email: `wizard-${stamp}@example.com` }
const CSV_NAME = 'tagihan-listrik.csv'
const CSV = 'Bulan,Tagihan sebelum (Rp),Tagihan sesudah (Rp)\nJan,4200000,2600000\nFeb,4100000,2550000\nMar,4350000,2480000\nApr,4250000,2400000\nMei,4000000,2350000\nJun,4150000,2300000\n'
const MANUAL_TITLE = 'Manual reference: how rooftop solar works'

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

// Slide 3 ("Point 4" after the outline edits) fails once with a 400, so it is a placeholder until it is retried.
const fake = await startFakeOpenAI(0, { wizardSlideDelayMs: 1200, failWizardSlideOnce: 3 })
const slideCalls = () => fake.seen.filter((r) => r.body?.response_format?.json_schema?.name === 'slide').length
const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))

const thumbs = () => page.locator('[id^="thumb-"]').count()
const pendingChips = () => page.getByText(/^(queued|running)$/).count()
async function waitNoPending(label) {
  await waitUntil(`${label}: references ready`, async () => (await pendingChips()) === 0, 60000)
}

try {
  // ---- 1. Sign in, and add the fake model as the default provider (Settings > AI).
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await context.request.post(`${base}/api/auth/sign-up/email`, { headers, data: { name: who.name, email: who.email, password } })
  if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email: who.email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()} ${await signIn.text()}`)

  await page.goto(`${base}/settings/ai`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('heading', { name: 'AI providers' }).waitFor({ state: 'visible', timeout: 20000 })
  await page.getByRole('button', { name: 'Add provider', exact: true }).click()
  const form = page.getByRole('form', { name: 'Add provider' })
  await form.getByLabel('Kind', { exact: true }).selectOption('openai-compatible')
  await form.getByLabel('Name', { exact: true }).fill('Fake wizard model')
  await form.getByLabel('Base URL (include /v1)', { exact: true }).fill(fake.url)
  await form.getByLabel('Model name', { exact: true }).fill('fake-local')
  await form.getByLabel('API key (optional for local servers)', { exact: true }).fill(LOCAL_KEY)
  await form.getByLabel('Use as my default', { exact: true }).check()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByText('Fake wizard model', { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 })
  check(await page.getByText(new RegExp(`Research: SearXNG at 127\\.0\\.0\\.1:${new URL(SEARXNG).port}`)).first().isVisible(), 'settings shows research on (SearXNG)')

  // ---- 2. The brief.
  await page.goto(`${base}/`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('link', { name: '✨ New from prompt' }).click()
  await page.waitForURL(/\/wizard\/new/, { timeout: 15000 })
  await page.getByLabel(/What is the deck about/).fill('Pitch deck: rooftop solar for small bakeries in Jakarta')
  await page.getByLabel(/Audience/).fill('bakery owners')
  await page.getByLabel(/Slides \(3 to 30\)/).fill('5')
  const sourcesBox = page.getByLabel(/A Sources slide at the end/)
  check(await sourcesBox.isChecked(), 'the Sources slide is on by default')
  await page.screenshot({ path: join(shotDir, 'wizard-brief.png'), fullPage: true })
  log('wizard-brief.png saved')
  await page.getByRole('button', { name: 'Next: references', exact: true }).click()
  await page.waitForURL(/\/wizard\/[0-9a-f-]{36}$/, { timeout: 20000 })
  const runId = new URL(page.url()).pathname.split('/')[2]
  check(/^[0-9a-f-]{36}$/.test(runId), 'the brief made a run')

  // ---- 3. References: a CSV file and a web address.
  await page.getByRole('heading', { name: '2. References (optional)' }).waitFor({ state: 'visible', timeout: 15000 })
  await page.getByLabel('Add files').setInputFiles({ name: CSV_NAME, mimeType: 'text/csv', buffer: Buffer.from(CSV) })
  await page.getByText(/words · 1 table/).first().waitFor({ state: 'visible', timeout: 30000 })
  check(true, 'the CSV was read as a reference with one table')
  await page.getByLabel('Web address').fill(`${new URL(SEARXNG).origin}/manual`)
  await page.getByRole('button', { name: 'Add address', exact: true }).click()
  await page.getByText(MANUAL_TITLE).first().waitFor({ state: 'visible', timeout: 30000 })
  await waitNoPending('manual address')
  check(true, 'the web address was fetched through the policy and is ready')

  // ---- 4. Research on: the AI searches, two pages are read.
  await page.getByLabel(/Let AI research this topic/).check()
  await page.getByRole('button', { name: 'Research now', exact: true }).click()
  await page.getByText('Solar power for small bakeries').first().waitFor({ state: 'visible', timeout: 60000 })
  await page.getByText('Electricity savings from rooftop solar').first().waitFor({ state: 'visible', timeout: 60000 })
  await waitNoPending('research pages')
  check(true, 'research added the two search pages as references')

  // ---- 5. The outline: draft it, rename, reorder, delete.
  await page.getByRole('button', { name: 'Draft outline', exact: true }).click()
  await page.getByLabel('Slide 2 title').waitFor({ state: 'visible', timeout: 60000 })
  await page.getByLabel('Deck title').waitFor({ state: 'visible', timeout: 5000 })
  check((await page.getByLabel(/^Slide \d+ title$/).count()) === 5, 'the outline has the five slides from the brief')
  await page.screenshot({ path: join(shotDir, 'wizard-outline.png'), fullPage: true })
  log('wizard-outline.png saved')
  await page.getByLabel('Slide 2 title').fill('Bills fell after solar')
  await page.getByRole('button', { name: 'Move slide 4 up', exact: true }).click()
  await page.getByRole('button', { name: 'Delete slide 5', exact: true }).click()
  check((await page.getByLabel(/^Slide \d+ title$/).count()) === 4, 'a slide was deleted (four left)')
  // Saved to the run after a short pause; a reload shows the saved outline.
  await sleep(1500)
  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Slide 2 title').waitFor({ state: 'visible', timeout: 20000 })
  check((await page.getByLabel(/^Slide \d+ title$/).count()) === 4, 'after a reload the outline keeps four slides')
  check((await page.getByLabel('Slide 2 title').inputValue()) === 'Bills fell after solar', 'the rename was saved')
  check((await page.getByLabel('Slide 3 title').inputValue()) === 'Point 4', 'the moved slide is now third')

  // ---- 6. Generate: the editor opens and slides arrive one by one.
  await page.getByRole('button', { name: 'Generate deck', exact: true }).click()
  await page.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 30000 })
  const deckId = new URL(page.url()).pathname.split('/')[2]
  const banner = page.getByRole('status', { name: 'Wizard progress' })
  await banner.waitFor({ state: 'visible', timeout: 30000 })
  // The banner is part of the layout (between the toolbar and the formula bar), not fixed over the title row.
  check((await banner.evaluate((el) => getComputedStyle(el).position)) !== 'fixed', 'the progress banner is in the layout flow, not fixed over the editor')
  const samples = []
  let shot = false
  const started = Date.now()
  for (;;) {
    const text = await banner.innerText().catch(() => '')
    const progress = /Slide (\d+) of (\d+)/.exec(text)
    const count = await thumbs()
    samples.push({ t: Date.now() - started, banner: text.replace(/\s+/g, ' ').slice(0, 80), thumbs: count })
    if (!shot && progress && Number(progress[1]) >= 1 && Number(progress[1]) < Number(progress[2])) {
      await page.screenshot({ path: join(shotDir, 'wizard-live.png') })
      shot = true
      log('wizard-live.png saved (generation in progress)')
    }
    if (/Generated from prompt/.test(text)) break
    if (/Generation failed/.test(text)) throw new Error(`generation failed: ${text}`)
    if (Date.now() - started > 120000) throw new Error('generation did not finish in two minutes')
    await sleep(400)
  }
  const distinct = [...new Set(samples.map((s) => s.thumbs))]
  check(distinct.length >= 3 && distinct[0] < distinct[distinct.length - 1], `slide count rose over time while generating (${distinct.join(' → ')})`)
  check(samples.some((s) => /Slide \d+ of/.test(s.banner)), 'the progress banner showed "Slide n of m" during generation')
  // Outline slides + the Sources slide.
  check((await thumbs()) === 5, 'the deck has the four outline slides and the Sources slide')
  check(samples.every((s, i, a) => i === 0 || s.thumbs >= a[i - 1].thumbs), 'the slide count never went down')
  // Four slides, one call each: the forced failure on slide 3 is one of those calls (a provider error is not retried).
  check(slideCalls() === 4, 'the model was called once per slide (slide 3 failed on its one call)')
  check(fake.seen.some((r) => r.body?.response_format?.json_schema?.name === 'outline'), 'the outline was drafted by the model')

  // ---- 6b. A slide the model could not write: a placeholder with its outline points and a note. Retry fills it in place.
  await banner.getByText('could not be written and show the outline points').waitFor({ state: 'visible', timeout: 10000 })
  check(true, 'the banner names the slide the model could not write')
  check((await page.getByText('Could not be generated', { exact: false }).count()) >= 1, 'the placeholder slide shows the note in the deck language')
  check((await page.getByText('A short point', { exact: true }).count()) >= 1, 'the placeholder slide shows its outline points as bullets')
  await page.screenshot({ path: join(shotDir, 'wizard-placeholder.png') })
  log('wizard-placeholder.png saved')
  await banner.getByRole('button', { name: 'Retry failed slides', exact: true }).click()
  await waitUntil('retry finished', async () => /Generated from prompt/.test(await banner.innerText()) && !/could not be written/.test(await banner.innerText()), 60000)
  check((await page.getByText('Could not be generated', { exact: false }).count()) === 0, 'Retry failed slides replaced the placeholder: the note is gone')
  check((await page.getByText('A short point', { exact: true }).count()) === 0, 'Retry failed slides replaced the placeholder: its outline point is gone')
  check((await thumbs()) === 5, 'the retry kept the slide count (four outline slides and the Sources slide)')
  check(slideCalls() === 5, 'the retry called the model once more, for slide 3 only')

  // ---- 7. Done: the Sources list names the references.
  await page.getByRole('button', { name: /^Sources \(\d+\)$/ }).click()
  const sources = page.getByLabel('Sources', { exact: true })
  await sources.waitFor({ state: 'visible', timeout: 10000 })
  const sourcesText = await sources.innerText()
  check(sourcesText.includes(CSV_NAME), 'Sources lists the CSV')
  check(sourcesText.includes(MANUAL_TITLE) || sourcesText.includes('/manual'), 'Sources lists the web address')
  check(sourcesText.includes('Solar power for small bakeries'), 'Sources lists a research page')
  check(deckId.length === 36, 'the deck is open in the editor')

  const real = errors.filter((e) => !/favicon/.test(e))
  check(real.length === 0, `no page or console errors${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`)
  console.log('wizard check passed')
} catch (err) {
  await page.screenshot({ path: join(shotDir, 'wizard-failure.png'), fullPage: true }).catch(() => undefined)
  throw err
} finally {
  await browser.close()
  await fake.close()
}

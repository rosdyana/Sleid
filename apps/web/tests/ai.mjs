// M4 browser check: the AI assistant against a fake OpenAI-compatible server (tests/fake-openai-server.mjs).
// Needs `pnpm dev` running with SLEID_TEST_AUTH=1, LLM_SECRET_KEY, COLLAB_TOKEN_SECRET and COLLAB_INTERNAL_SECRET.
// The fake server listens on 127.0.0.1, and this script adds it as a USER provider (through the UI). A user provider
// may use a loopback address only when the dev server has LLM_USER_ALLOW_PRIVATE_URLS=1. So start the dev server with:
//   LLM_USER_ALLOW_PRIVATE_URLS=1 SLEID_TEST_AUTH=1 LLM_SECRET_KEY=... pnpm dev
// (The alternative, adding the provider as an administrator, would need an ADMIN_EMAILS account and a workspace provider.)
//   CHROME_PATH=... SCREENSHOT_DIR=... node tests/ai.mjs [http://localhost:3000]
// Covers: settings (add a provider, Test connection OK, key never shown), generate a slide (Preview, Apply, Undo),
// shorten a text box, a chart from a prompt in the panel, a theme with a brand colour, a collaborator seeing the
// applied change live, and a viewer seeing no AI tab.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { startFakeOpenAI } from './fake-openai-server.mjs'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
mkdirSync(shotDir, { recursive: true })
const stamp = Date.now().toString(36)
const password = 'password123'
const LOCAL_KEY = `sk-e2e-local-${stamp}`
const people = {
  a: { name: 'Ai Ana', email: `ai-a-${stamp}@example.com` },
  b: { name: 'Ai Bea', email: `ai-b-${stamp}@example.com` },
  c: { name: 'Ai Cy', email: `ai-c-${stamp}@example.com` },
}
const log = (msg) => console.log(`ok  ${msg}`)
const check = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  log(msg)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(label, fn, timeoutMs = 10000, intervalMs = 150) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return Date.now() - started
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms: ${label}`)
    await sleep(intervalMs)
  }
}

async function signUpAndIn(ctx, who) {
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await ctx.request.post(`${base}/api/auth/sign-up/email`, { headers, data: { name: who.name, email: who.email, password } })
  if (!signUp.ok()) throw new Error(`sign-up failed for ${who.email}: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email: who.email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed for ${who.email}: ${signIn.status()} ${await signIn.text()}`)
}

const waitSaved = (page) => page.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
const thumbs = (page) => page.locator('[id^="thumb-"]').count()

const fake = await startFakeOpenAI()
const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
const contexts = []
function newContext() {
  return browser.newContext({ viewport: { width: 1440, height: 900 } }).then((ctx) => {
    contexts.push(ctx)
    return ctx
  })
}

try {
  // ---- A signs in, adds the local model as the default provider, and tests the connection.
  const ctxA = await newContext()
  const pageA = await ctxA.newPage()
  pageA.on('pageerror', (e) => errors.push(`A pageerror: ${e.message}`))
  pageA.on('console', (m) => m.type() === 'error' && errors.push(`A console: ${m.text()}`))
  await signUpAndIn(ctxA, people.a)

  await pageA.goto(`${base}/settings/ai`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByRole('heading', { name: 'AI providers' }).waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByRole('button', { name: 'Add provider', exact: true }).click()
  const form = pageA.getByRole('form', { name: 'Add provider' })
  await form.getByLabel('Kind', { exact: true }).selectOption('openai-compatible')
  await form.getByLabel('Name', { exact: true }).fill('Fake local model')
  await form.getByLabel('Base URL (include /v1)', { exact: true }).fill(fake.url)
  await form.getByLabel('Model name', { exact: true }).fill('fake-local')
  await form.getByLabel('API key (optional for local servers)', { exact: true }).fill(LOCAL_KEY)
  await form.getByLabel('Use as my default', { exact: true }).check()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await pageA.getByText('Fake local model', { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 })
  check(!(await pageA.content()).includes(LOCAL_KEY), 'the saved key is not in the settings page')
  check((await pageA.getByText('Key: ••••• set').count()) > 0, 'the provider shows "••••• set" for its key')
  await pageA.getByRole('button', { name: 'Test connection' }).first().click()
  await pageA.getByText(/^OK · fake-local · \d+ ms$/).waitFor({ state: 'visible', timeout: 15000 })
  check(true, 'Test connection reports OK with the model and the latency')
  await pageA.screenshot({ path: join(shotDir, 'ai-settings.png'), fullPage: true })
  log('ai-settings.png saved')

  // ---- A opens a new deck and gives it a title.
  await pageA.goto(`${base}/`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByRole('button', { name: 'Blank deck' }).click()
  await pageA.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  const deckId = new URL(pageA.url()).pathname.split('/')[2]
  await pageA.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await waitSaved(pageA)
  await pageA.getByLabel('Deck title').fill(`AI deck ${stamp}`)
  await pageA.getByLabel('Deck title').press('Enter')
  await waitSaved(pageA)
  // The title slide's title box gets a long line, to be shortened later.
  await pageA.getByLabel('Formula bar').fill('Pricing overview with far too many words in one single title line')
  await pageA.getByLabel('Formula bar').press('Enter')
  await waitSaved(pageA)
  check((await thumbs(pageA)) === 1, 'the deck starts with one slide')

  // ---- Ask AI in the fx bar: generate a slide from a prompt, preview it, apply it, undo it.
  await pageA.getByRole('button', { name: 'Ask AI', exact: true }).click()
  await pageA.getByRole('menuitem', { name: 'Generate a new slide from a prompt…' }).click()
  const slidePrompt = pageA.getByRole('dialog', { name: 'New slide' })
  await slidePrompt.locator('#prompt-input').fill('A slide about our three pricing plans')
  await slidePrompt.getByRole('button', { name: 'Generate', exact: true }).click()
  const slideCard = pageA.locator('section[aria-label^="Proposal: Add slide"]')
  await slideCard.waitFor({ state: 'visible', timeout: 30000 })
  check(true, 'the fx bar Ask AI produced a proposal card in the AI panel')
  check((await slideCard.getByText(/change/).count()) > 0, 'the card shows the number of changes')
  check((await slideCard.getByText(/fake-local/).count()) > 0, 'the card shows the provider and model')
  check((await thumbs(pageA)) === 1, 'the proposal is not applied yet')

  await slideCard.getByRole('button', { name: 'Preview', exact: true }).click()
  const ribbon = pageA.getByRole('region', { name: 'Preview' })
  await ribbon.waitFor({ state: 'visible', timeout: 10000 })
  check(await pageA.locator('[data-testid=slide-canvas]').getByText('Our three pricing plans').isVisible(), 'the preview shows the new slide on the canvas')
  check((await thumbs(pageA)) === 2, 'the filmstrip shows the previewed slide')
  await pageA.screenshot({ path: join(shotDir, 'ai-preview.png') })
  log('ai-preview.png saved')
  await ribbon.getByRole('button', { name: 'Apply', exact: true }).click()
  await ribbon.waitFor({ state: 'detached', timeout: 10000 })
  await waitSaved(pageA)
  check((await thumbs(pageA)) === 2, 'Apply adds the slide to the deck')
  await pageA.getByRole('button', { name: 'Undo', exact: true }).click()
  await waitUntil('Undo removes the applied slide', async () => (await thumbs(pageA)) === 1, 5000)
  check(true, 'Undo removes the applied slide')
  await pageA.getByRole('button', { name: 'Redo', exact: true }).click()
  await waitUntil('Redo brings it back', async () => (await thumbs(pageA)) === 2, 5000)
  check(true, 'Redo brings it back')
  await pageA.getByRole('button', { name: 'Undo', exact: true }).click()
  await waitUntil('back to one slide', async () => (await thumbs(pageA)) === 1, 5000)

  // ---- Rewrite a text box: select the title, Ask AI ▸ Shorten.
  await pageA.locator('[data-testid=slide-canvas] [data-type=text]').first().click()
  await pageA.getByRole('button', { name: 'Ask AI', exact: true }).click()
  await pageA.getByRole('menuitem', { name: 'Shorten', exact: true }).click()
  const shortenCard = pageA.locator('section[aria-label^="Proposal: Rewrite text (shorten)"]')
  await shortenCard.waitFor({ state: 'visible', timeout: 30000 })
  await shortenCard.getByRole('button', { name: 'Apply', exact: true }).click()
  await pageA.getByText('Short text.', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 })
  check(true, 'Shorten replaced the text box with the shorter text')

  // ---- Chart from a prompt, in the chat panel.
  await pageA.getByLabel('Message the assistant').fill('Chart monthly sales as a bar chart')
  await pageA.getByLabel('Message the assistant').press('Enter')
  const chartCard = pageA.locator('section[aria-label^="Proposal: Add bar chart"]')
  await chartCard.waitFor({ state: 'visible', timeout: 40000 })
  check(true, 'the chat turned the request into a chart proposal card')
  await pageA.screenshot({ path: join(shotDir, 'ai-panel.png') })
  log('ai-panel.png saved')
  const chartsBefore = await pageA.locator('[data-testid=slide-canvas] [data-type=chart]').count()
  await chartCard.getByRole('button', { name: 'Apply', exact: true }).click()
  await waitUntil('the chart appears on the canvas', async () => (await pageA.locator('[data-testid=slide-canvas] [data-type=chart]').count()) === chartsBefore + 1, 10000)
  check(true, 'Apply adds the chart to the slide')

  // ---- Theme with a brand colour, from Tools.
  await pageA.getByRole('menuitem', { name: 'Tools', exact: true }).click()
  await pageA.getByRole('menuitem', { name: 'Generate theme…' }).click()
  const themeDialog = pageA.getByRole('dialog', { name: 'Generate theme' })
  await themeDialog.locator('#theme-prompt').fill('calm and professional for a finance review')
  await themeDialog.locator('#theme-brand').fill('#0b57d0')
  await themeDialog.getByRole('button', { name: 'Generate', exact: true }).click()
  const themeCard = pageA.locator('section[aria-label^="Proposal: Change theme to"]')
  await themeCard.waitFor({ state: 'visible', timeout: 30000 })
  check((await themeCard.getByText(/Adjusted for contrast/).count()) > 0, 'the theme card lists the contrast adjustment')
  await themeCard.getByRole('button', { name: 'Apply', exact: true }).click()
  await waitUntil('the theme select shows Brand Calm', async () => (await pageA.getByLabel('Theme', { exact: true }).inputValue()) === 'Brand Calm', 10000)
  check(true, 'Apply changes the deck theme to the generated one')

  // ---- A shares the deck with B (editor) and with a viewer link. C is the viewer.
  await pageA.getByRole('button', { name: 'Share', exact: true }).click()
  const share = pageA.getByRole('dialog', { name: 'Share deck' })
  await share.waitFor({ state: 'visible', timeout: 10000 })
  await share.getByLabel('Add people by email').fill(people.b.email)
  await share.getByLabel('Invite role').selectOption('editor')
  await share.getByRole('button', { name: 'Send invite' }).click()
  await share.getByRole('list', { name: 'Pending invites' }).getByText(people.b.email).waitFor({ state: 'visible', timeout: 10000 })
  await share.getByLabel('General access').selectOption('viewer')
  const viewerLink = await share.getByLabel('Share link').inputValue()
  await share.getByRole('button', { name: 'Done' }).click()

  const ctxB = await newContext()
  const pageB = await ctxB.newPage()
  pageB.on('pageerror', (e) => errors.push(`B pageerror: ${e.message}`))
  pageB.on('console', (m) => m.type() === 'error' && errors.push(`B console: ${m.text()}`))
  await signUpAndIn(ctxB, people.b)
  await waitUntil(
    'B sees the shared deck',
    async () => {
      await pageB.goto(`${base}/`)
      await pageB.waitForLoadState('networkidle')
      await pageB.getByRole('tab', { name: 'Shared with me' }).click()
      return (await pageB.getByRole('link', { name: new RegExp(`AI deck ${stamp}`) }).count()) > 0
    },
    25000,
    1000,
  )
  await pageB.getByRole('link', { name: new RegExp(`AI deck ${stamp}`) }).click()
  await pageB.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await waitSaved(pageB)
  check(true, 'B opened the deck as an editor')

  // A applies one more change; B must see it live (a new slide, same as the other side).
  await pageA.getByRole('button', { name: 'Ask AI', exact: true }).click()
  await pageA.getByRole('menuitem', { name: 'Generate a new slide from a prompt…' }).click()
  await pageA.getByRole('dialog', { name: 'New slide' }).locator('#prompt-input').fill('A slide about the pricing plans for teams')
  await pageA.getByRole('dialog', { name: 'New slide' }).getByRole('button', { name: 'Generate', exact: true }).click()
  const liveCard = pageA.locator('section[aria-label^="Proposal: Add slide"]').last()
  await liveCard.waitFor({ state: 'visible', timeout: 30000 })
  const appliedAt = Date.now()
  await liveCard.getByRole('button', { name: 'Apply', exact: true }).click()
  await waitUntil('A has two slides', async () => (await thumbs(pageA)) === 2, 5000)
  await waitUntil('B sees the applied slide live', async () => (await thumbs(pageB)) === 2, 10000)
  check(true, `B sees the AI change live, ${Date.now() - appliedAt} ms after A clicked Apply`)
  check((await pageB.getByLabel('Theme', { exact: true }).inputValue()) === 'Brand Calm', 'B sees the generated theme')

  // ---- A viewer (link, signed in) sees no AI tab and no Ask AI button.
  const ctxC = await newContext()
  const pageC = await ctxC.newPage()
  pageC.on('pageerror', (e) => errors.push(`C pageerror: ${e.message}`))
  pageC.on('console', (m) => m.type() === 'error' && errors.push(`C console: ${m.text()}`))
  await signUpAndIn(ctxC, people.c)
  await pageC.goto(viewerLink)
  await pageC.getByText('View only', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  check((await pageC.getByRole('tab', { name: 'AI', exact: true }).count()) === 0, 'a viewer sees no AI tab')
  check((await pageC.getByRole('button', { name: 'Ask AI', exact: true }).count()) === 0, 'a viewer sees no Ask AI button')
  check((await pageC.locator('[aria-label="Message the assistant"]').count()) === 0, 'a viewer sees no assistant composer')

  // The server refuses a viewer's direct call too.
  const denied = await pageC.request.post(`${base}/api/decks/${deckId}/ai/chat`, {
    headers: { origin: base, 'content-type': 'application/json' },
    data: { messages: [{ role: 'user', content: 'hello' }] },
  })
  check(denied.status() === 403, `the chat route answers 403 to a viewer (got ${denied.status()})`)
  await ctxC.close()
  contexts.splice(contexts.indexOf(ctxC), 1)

  // The fake server saw the connection test and the structured calls with the key as the bearer token.
  check(fake.seen.some((r) => r.auth === `Bearer ${LOCAL_KEY}`), 'the model server received the key as the bearer token')
  check(fake.seen.every((r) => !JSON.stringify(r.body).includes(LOCAL_KEY)), 'the key is not in any request body')
  check(fake.seen.some((r) => r.body.response_format?.json_schema?.name === 'slide'), 'the slide ability used a JSON schema request')
  check(fake.seen.some((r) => r.body.stream === true), 'the chat used a streamed request')
} catch (e) {
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => undefined)
  await browser.close()
  await fake.close()
}

if (errors.length) {
  console.error(`browser errors:\n${errors.join('\n')}`)
  process.exitCode = 1
}
if (process.exitCode) process.exit(process.exitCode)
console.log('ai check passed')

// Two-browser co-editing check (M2). Needs `pnpm dev` running with SLEID_TEST_AUTH=1,
// COLLAB_TOKEN_SECRET and COLLAB_INTERNAL_SECRET set (the forced-write step signs a token).
//   CHROME_PATH=... SCREENSHOT_DIR=... node tests/collab.mjs [http://localhost:3000]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { signCollabToken } from '@sleid/db'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const collabUrl = process.env.VITE_COLLAB_URL ?? 'ws://localhost:3001'
const internalUrl = (process.env.COLLAB_INTERNAL_URL ?? 'http://127.0.0.1:3002').replace(/\/$/, '')
const internalSecret = process.env.COLLAB_INTERNAL_SECRET
const tokenSecret = process.env.COLLAB_TOKEN_SECRET
if (!internalSecret || !tokenSecret) throw new Error('COLLAB_INTERNAL_SECRET and COLLAB_TOKEN_SECRET must be set for this check')

const stamp = Date.now().toString(36)
const password = 'password123'
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
mkdirSync(shotDir, { recursive: true })

const people = {
  a: { name: 'Collab Ana', email: `collab-a-${stamp}@example.com` },
  b: { name: 'Collab Bea', email: `collab-b-${stamp}@example.com` },
  c: { name: 'Collab Cy', email: `collab-c-${stamp}@example.com` },
}
const DECK_TITLE = `Collab review ${stamp}`
const log = (msg) => console.log(`ok  ${msg}`)
const check = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
  log(msg)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(label, fn, timeoutMs = 3000, intervalMs = 100) {
  const started = Date.now()
  for (;;) {
    if (await fn().catch(() => false)) return Date.now() - started
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms: ${label}`)
    await sleep(intervalMs)
  }
}

/** Signs up and signs in through the test auth API, like smoke.mjs. Returns the user id. */
async function signUpAndIn(ctx, base, who) {
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await ctx.request.post(`${base}/api/auth/sign-up/email`, { headers, data: { name: who.name, email: who.email, password } })
  if (!signUp.ok()) throw new Error(`sign-up failed for ${who.email}: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email: who.email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed for ${who.email}: ${signIn.status()} ${await signIn.text()}`)
  const body = await signIn.json()
  return body.user.id
}

async function internalJson(deckId) {
  const res = await fetch(`${internalUrl}/internal/decks/${deckId}/json`, { headers: { 'x-sleid-internal': internalSecret } })
  if (!res.ok) throw new Error(`internal json ${res.status}`)
  return res.json()
}

const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
const contexts = []
function newContext(viewport = { width: 1440, height: 900 }) {
  return browser.newContext({ viewport }).then((ctx) => {
    contexts.push(ctx)
    return ctx
  })
}

try {
  // ---- User A creates a deck and invites B before B has an account.
  const ctxA = await newContext()
  const pageA = await ctxA.newPage()
  pageA.on('pageerror', (e) => errors.push(`A pageerror: ${e.message}`))
  pageA.on('console', (m) => m.type() === 'error' && errors.push(`A console: ${m.text()}`))
  const idA = await signUpAndIn(ctxA, base, people.a)
  await pageA.goto(`${base}/`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByRole('button', { name: 'Blank deck' }).click()
  await pageA.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 }).catch((e) => {
    throw new Error(`A did not reach a new deck (at ${pageA.url()}): ${e.message.split('\n')[0]}`)
  })
  const deckId = new URL(pageA.url()).pathname.split('/')[2]
  await pageA.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await pageA.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByLabel('Deck title').fill(DECK_TITLE)
  await pageA.getByLabel('Deck title').press('Enter')
  await pageA.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
  log(`A created deck ${deckId} and titled it`)

  await pageA.getByRole('button', { name: 'Share', exact: true }).click()
  const dialog = pageA.getByRole('dialog', { name: 'Share deck' })
  await dialog.waitFor({ state: 'visible', timeout: 10000 })
  await dialog.getByLabel('Add people by email').fill(people.b.email)
  await dialog.getByLabel('Invite role').selectOption('editor')
  await dialog.getByRole('button', { name: 'Send invite' }).click()
  await dialog.getByRole('list', { name: 'Pending invites' }).getByText(people.b.email).waitFor({ state: 'visible', timeout: 10000 })
  log(`A invited ${people.b.email} as editor (pending until that email signs in)`)

  await dialog.getByLabel('General access').selectOption('viewer')
  const linkInput = dialog.getByLabel('Share link')
  await linkInput.waitFor({ state: 'visible', timeout: 10000 })
  const shareLink = await linkInput.inputValue()
  check(shareLink.startsWith(`${base}/d/${deckId}?share=`), 'general access is "Anyone with the link: viewer" and a link is shown')
  await dialog.screenshot({ path: join(shotDir, 'share-dialog.png') })
  log('share-dialog.png saved')
  await dialog.getByRole('button', { name: 'Done' }).click()

  // ---- User B signs up with the invited email and finds the deck under "Shared with me".
  const ctxB = await newContext()
  const pageB = await ctxB.newPage()
  pageB.on('pageerror', (e) => errors.push(`B pageerror: ${e.message}`))
  pageB.on('console', (m) => m.type() === 'error' && errors.push(`B console: ${m.text()}`))
  await signUpAndIn(ctxB, base, people.b)
  // The dashboard lists titles as stored. The title is written about 2 s after the last edit,
  // so B reloads the dashboard until the stored title shows up.
  await waitUntil(
    'B sees the shared deck under "Shared with me"',
    async () => {
      await pageB.goto(`${base}/`)
      await pageB.waitForLoadState('networkidle')
      await pageB.getByRole('tab', { name: 'Shared with me' }).click()
      return (await pageB.getByRole('link', { name: new RegExp(DECK_TITLE) }).count()) > 0
    },
    20000,
    1000,
  )
  const bLink = pageB.getByRole('link', { name: new RegExp(DECK_TITLE) })
  check(true, 'B sees the deck under "Shared with me" after signing in with the invited email')
  await bLink.click()
  await pageB.waitForURL(new RegExp(`/d/${deckId}`), { timeout: 20000 }).catch((e) => {
    throw new Error(`B did not reach the deck (at ${pageB.url()}): ${e.message.split('\n')[0]}`)
  })
  await pageB.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await pageB.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
  check((await pageB.getByText('View only', { exact: true }).count()) === 0, 'B (editor) does not see a View only badge')

  // Presence: each sees the other's avatar.
  await pageA.getByLabel(`${people.b.name} is here`).waitFor({ state: 'visible', timeout: 10000 })
  await pageB.getByLabel(`${people.a.name} is here`).waitFor({ state: 'visible', timeout: 10000 })
  check(true, "B's avatar appears for A, and A's appears for B")

  // ---- Live edits: A moves the title box, B adds a slide. Each side must see the other within 3 s.
  const titleBox = pageA.locator('[data-testid=slide-canvas] [data-type=text]').first()
  const elementId = await titleBox.getAttribute('data-el')
  const bBox = pageB.locator(`[data-testid=slide-canvas] [data-el="${elementId}"]`)
  await bBox.waitFor({ state: 'attached', timeout: 10000 })
  const beforeLeft = await bBox.evaluate((e) => e.style.left)
  await titleBox.click()
  for (let i = 0; i < 3; i++) await pageA.keyboard.press('Shift+ArrowRight')
  const aLeft = await titleBox.evaluate((e) => e.style.left)
  const movedMs = await waitUntil('B sees A move the title box', async () => (await bBox.evaluate((e) => e.style.left)) === aLeft, 3000)
  check(aLeft !== beforeLeft, `A moved the title box; B saw the move in ${movedMs} ms`)

  const slidesBefore = await pageA.locator('[id^="thumb-"]').count()
  await pageB.locator('[aria-label="New slide"]').first().click()
  const slideMs = await waitUntil('A sees the new slide', async () => (await pageA.locator('[id^="thumb-"]').count()) === slidesBefore + 1, 3000)
  check(true, `B added a slide; A saw it in ${slideMs} ms`)

  // Remote cursors are drawn only for collaborators on the same slide, so B goes back to slide 1 first.
  await pageB.locator('[id^="thumb-"]').first().click()
  await pageB.locator('[data-testid=slide-canvas]').hover({ position: { x: 300, y: 200 } })
  await waitUntil('A sees a remote cursor from B', async () => (await pageA.locator('[data-testid=remote-cursor]').count()) > 0, 3000)
  check(true, 'A sees B\'s cursor on the canvas')

  await pageA.screenshot({ path: join(shotDir, 'collab-A.png') })
  await pageB.screenshot({ path: join(shotDir, 'collab-B.png') })
  log('collab-A.png and collab-B.png saved (same moment)')

  // Offline: B goes offline, moves the title box, and comes back. The change must reach A.
  await ctxB.setOffline(true)
  await pageB.getByRole('status').filter({ hasText: 'Offline — changes will sync' }).first().waitFor({ state: 'visible', timeout: 10000 })
  check(true, 'B is offline and the status reads "Offline — changes will sync"')
  const bTitle = pageB.locator(`[data-testid=slide-canvas] [data-el="${elementId}"]`)
  await bTitle.click()
  for (let i = 0; i < 2; i++) await pageB.keyboard.press('Shift+ArrowDown')
  const bOffline = await bTitle.evaluate((e) => e.style.top)
  await ctxB.setOffline(false)
  await pageB.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
  const syncedMs = await waitUntil('A receives the change B made offline', async () => (await titleBox.evaluate((e) => e.style.top)) === bOffline, 15000)
  check(true, `B's offline edit reached A after reconnecting, in ${syncedMs} ms`)

  // ---- User C follows the share link while signed out, then signs in and opens it.
  const ctxAnon = await newContext()
  const anonPage = await ctxAnon.newPage()
  await anonPage.goto(shareLink)
  await anonPage.waitForURL(/\/login\?redirect=/, { timeout: 20000 })
  check(true, 'a signed-out visit to the share link goes to /login with a return URL')
  await ctxAnon.close()
  contexts.splice(contexts.indexOf(ctxAnon), 1)

  const ctxC = await newContext()
  const pageC = await ctxC.newPage()
  pageC.on('pageerror', (e) => errors.push(`C pageerror: ${e.message}`))
  pageC.on('console', (m) => m.type() === 'error' && errors.push(`C console: ${m.text()}`))
  const idC = await signUpAndIn(ctxC, base, people.c)
  await pageC.goto(shareLink)
  await pageC.getByText('View only', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await pageC.getByRole('status').filter({ hasText: 'All changes saved' }).first().waitFor({ state: 'visible', timeout: 20000 })
  check(true, 'C opens the link and sees the View only badge')
  check((await pageC.getByLabel('Deck title').getAttribute('readonly')) !== null, 'the title is read-only for C')

  check(await pageC.locator('[aria-label="Text box"]').isDisabled(), 'the toolbar insert buttons are disabled for C')
  check(await pageC.locator('[aria-label="Undo"]').isDisabled(), 'Undo is disabled for C')
  await pageC.getByRole('menuitem', { name: 'Insert', exact: true }).click()
  await pageC.getByRole('menu').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined)
  // Disabled items carry a "View only" note, which is part of their accessible name.
  check(await pageC.getByRole('menuitem', { name: /^Text box/ }).isDisabled(), 'the Insert > Text box menu item is disabled for C')
  await pageC.keyboard.press('Escape')

  const cBoxes = pageC.locator('[data-testid=slide-canvas] [data-type=text]')
  const cCount = await cBoxes.count()
  await cBoxes.first().click()
  await pageC.keyboard.press('Delete')
  await pageC.keyboard.press('Backspace')
  await sleep(400)
  check((await cBoxes.count()) === cCount, 'Delete and Backspace do nothing for C')
  check((await pageC.locator('[data-testid=slide-canvas] [data-type=text]').count()) === cCount, 'C still sees every element')

  // Forced write: a valid viewer token, connected straight to the socket, tries to change the title.
  const viewerToken = signCollabToken({ userId: idC, deckId, role: 'viewer', name: people.c.name, image: null }, tokenSecret)
  const forcedDoc = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({ url: collabUrl, WebSocketPolyfill: globalThis.WebSocket })
  const forced = new HocuspocusProvider({ url: collabUrl, name: deckId, document: forcedDoc, websocketProvider: socket, token: viewerToken })
  forced.attach()
  await waitUntil('forced viewer connection authenticates', async () => forced.isAuthenticated, 10000)
  check(forced.authorizedScope === 'readonly', 'the server authorises the viewer token as read-only')
  forcedDoc.transact(() => forcedDoc.getMap('deck').set('title', 'Forced by a viewer'))
  await sleep(2500)
  forced.destroy()
  socket.destroy()
  const serverDeck = await internalJson(deckId)
  check(serverDeck.title === DECK_TITLE, `the forced write did not change the server title (still "${serverDeck.title}")`)
  await pageA.getByLabel('Deck title').waitFor({ state: 'visible' })
  check((await pageA.getByLabel('Deck title').inputValue()) === DECK_TITLE, "A's title is unchanged after the forced write")

  void idA
  await ctxC.close()
  contexts.splice(contexts.indexOf(ctxC), 1)
} catch (e) {
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => undefined)
  await browser.close()
}

if (errors.length) {
  console.error(`browser errors:\n${errors.join('\n')}`)
  process.exitCode = 1
}
if (process.exitCode) process.exit(process.exitCode)
console.log('collab check passed')

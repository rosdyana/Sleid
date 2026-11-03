// M7 browser check: comments (live, mentions, resolve, commenter role), version history (name, preview, restore,
// convergence), and presenter view with the phone remote (QR, Next twice, notes on the phone, close).
// Needs `pnpm dev` running with SLEID_TEST_AUTH=1, COLLAB_TOKEN_SECRET and COLLAB_INTERNAL_SECRET in the environment.
//   CHROME_PATH=... SCREENSHOT_DIR=... node tests/m7.mjs [http://localhost:3000]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const base = (process.argv[2] ?? process.env.SLEID_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const internalUrl = (process.env.COLLAB_INTERNAL_URL ?? 'http://127.0.0.1:3002').replace(/\/$/, '')
const internalSecret = process.env.COLLAB_INTERNAL_SECRET
if (!internalSecret) throw new Error('COLLAB_INTERNAL_SECRET must be set for this check')

const stamp = Date.now().toString(36)
const password = 'password123'
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
const shotDir = process.env.SCREENSHOT_DIR ?? join(process.cwd(), 'test-results', 'screenshots')
mkdirSync(shotDir, { recursive: true })

const people = {
  a: { name: 'M7 Ana', email: `m7-a-${stamp}@example.com` },
  b: { name: 'M7 Bea', email: `m7-b-${stamp}@example.com` },
  c: { name: 'M7 Cy', email: `m7-c-${stamp}@example.com` },
}
const DECK_TITLE = `M7 review ${stamp}`
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

/** Signs up and signs in through the test auth API, like collab.mjs. Returns the user id. */
async function signUpAndIn(ctx, who) {
  const headers = { origin: base, 'content-type': 'application/json' }
  const signUp = await ctx.request.post(`${base}/api/auth/sign-up/email`, { headers, data: { name: who.name, email: who.email, password } })
  if (!signUp.ok()) throw new Error(`sign-up failed for ${who.email}: ${signUp.status()} ${await signUp.text()}`)
  const signIn = await ctx.request.post(`${base}/api/auth/sign-in/email`, { headers, data: { email: who.email, password } })
  if (!signIn.ok()) throw new Error(`sign-in failed for ${who.email}: ${signIn.status()} ${await signIn.text()}`)
  return (await signIn.json()).user.id
}

async function internalJson(deckId) {
  const res = await fetch(`${internalUrl}/internal/decks/${deckId}/json`, { headers: { 'x-sleid-internal': internalSecret } })
  if (!res.ok) throw new Error(`internal json ${res.status}`)
  return res.json()
}

/** A batch of deck-ops through the collab internal API. Connected editors see it live. */
async function internalOps(deckId, ops) {
  const res = await fetch(`${internalUrl}/internal/decks/${deckId}/ops`, {
    method: 'POST',
    headers: { 'x-sleid-internal': internalSecret, 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'm7-test', ops }),
  })
  if (!res.ok) throw new Error(`internal ops ${res.status} ${await res.text()}`)
}

const browser = await chromium.launch({ headless: true, ...launchOptions })
const errors = []
const contexts = []
async function newContext(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })
  contexts.push(ctx)
  return ctx
}
function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label} console: ${m.text()}`))
}

const statusSaved = (page) => page.getByRole('status').filter({ hasText: 'All changes saved' }).first()

try {
  // ---- Owner A creates the deck, titles it, and adds two slides with notes.
  const ctxA = await newContext()
  const pageA = await ctxA.newPage()
  watch(pageA, 'A')
  const idA = await signUpAndIn(ctxA, people.a)
  await pageA.goto(`${base}/`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByRole('button', { name: 'Blank deck' }).click()
  await pageA.waitForURL(/\/d\/[0-9a-f-]{36}/, { timeout: 20000 })
  const deckId = new URL(pageA.url()).pathname.split('/')[2]
  await pageA.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await statusSaved(pageA).waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByLabel('Deck title').fill(DECK_TITLE)
  await pageA.getByLabel('Deck title').press('Enter')
  await statusSaved(pageA).waitFor({ state: 'visible', timeout: 20000 })

  const first = await internalJson(deckId)
  const slide1 = first.slides[0].id
  const slide2 = `m7-s2-${stamp}`
  const slide3 = `m7-s3-${stamp}`
  await internalOps(deckId, [
    { op: 'addSlide', layout: 'blank', slide: { id: slide2 } },
    { op: 'addSlide', layout: 'blank', slide: { id: slide3 } },
    { op: 'setNotes', slideId: slide1, notes: 'Notes for slide one' },
    { op: 'setNotes', slideId: slide2, notes: 'Notes for slide two' },
    { op: 'setNotes', slideId: slide3, notes: 'Notes for slide three, read on the phone' },
  ])
  await pageA.locator('[id^="thumb-"]').nth(2).waitFor({ state: 'attached', timeout: 10000 })
  check((await pageA.locator('[id^="thumb-"]').count()) === 3, 'A has a three-slide deck')

  // ---- A invites B by email as a commenter. B signs up, finds the deck under "Shared with me", and opens it.
  await pageA.getByRole('button', { name: 'Share', exact: true }).click()
  const shareDialog = pageA.getByRole('dialog', { name: 'Share deck' })
  await shareDialog.waitFor({ state: 'visible', timeout: 10000 })
  await shareDialog.getByLabel('Add people by email').fill(people.b.email)
  await shareDialog.getByLabel('Invite role').selectOption('commenter')
  await shareDialog.getByRole('button', { name: 'Send invite' }).click()
  await shareDialog.getByRole('list', { name: 'Pending invites' }).getByText(people.b.email).waitFor({ state: 'visible', timeout: 10000 })
  // C is a viewer. C follows the presenter at the end.
  await shareDialog.getByLabel('Add people by email').fill(people.c.email)
  await shareDialog.getByLabel('Invite role').selectOption('viewer')
  await shareDialog.getByRole('button', { name: 'Send invite' }).click()
  await shareDialog.getByRole('list', { name: 'Pending invites' }).getByText(people.c.email).waitFor({ state: 'visible', timeout: 10000 })
  await shareDialog.getByRole('button', { name: 'Done' }).click()

  const ctxB = await newContext()
  const pageB = await ctxB.newPage()
  watch(pageB, 'B')
  const idB = await signUpAndIn(ctxB, people.b)
  // The dashboard shows the stored title, which is written about 2 s after the last edit, so B reloads until it appears.
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
  await pageB.getByRole('link', { name: new RegExp(DECK_TITLE) }).click()
  await pageB.waitForURL(new RegExp(`/d/${deckId}`), { timeout: 20000 })
  await pageB.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await statusSaved(pageB).waitFor({ state: 'visible', timeout: 20000 })
  check((await pageB.getByTestId('access-badge').textContent())?.trim() === 'Commenting', 'B (commenter) sees the Commenting badge, not View only')
  check(await pageB.locator('[aria-label="Text box"]').isDisabled(), 'B cannot insert elements (toolbar disabled)')

  // ---- Scenario A: comments.
  // A has the Comments tab open first, so the live update is visible on A's screen.
  await pageA.getByTestId('side-tab-comments').click()

  // B selects the title text box and starts a comment on it with Ctrl+Alt+M, then mentions A.
  await pageB.getByTestId('side-tab-comments').waitFor({ state: 'visible', timeout: 10000 })
  const titleBoxB = pageB.locator('[data-testid=slide-canvas] [data-type=text]').first()
  const elementId = await titleBoxB.getAttribute('data-el')
  await titleBoxB.click()
  await pageB.keyboard.press('Control+Alt+M')
  const composer = pageB.getByTestId('comment-composer')
  await composer.waitFor({ state: 'visible', timeout: 5000 })
  await composer.click()
  await composer.pressSequentially('Check the title @Ana')
  await pageB.getByTestId('mention-options').waitFor({ state: 'visible', timeout: 10000 })
  await composer.press('Enter')
  await composer.pressSequentially(' before the review.')
  const commentPanelB = pageB.getByTestId('comments-panel')
  const postedAt = Date.now()
  await commentPanelB.getByRole('button', { name: 'Comment', exact: true }).click()
  await pageB.getByTestId('comment-thread').first().waitFor({ state: 'visible', timeout: 10000 })
  check((await pageB.getByTestId('comment-pin').count()) === 1, 'B pinned a comment to the title element (one pin on the canvas)')
  const bMention = await pageB.getByTestId('comment-mention').first().textContent()
  check(bMention === `@${people.a.name}`, `B's comment shows the mention as a chip: ${bMention}`)
  const bBody = (await pageB.getByTestId('comment').first().textContent()) ?? ''
  check(bBody.includes('Check the title') && bBody.includes('before the review.'), 'the typed text is intact around the mention (no characters moved)')

  // The thread must reach A within 3 s, with the unread badge.
  const liveMs = await waitUntil('A sees the comment thread live', async () => (await pageA.getByTestId('comment-thread').count()) === 1, 3000)
  check(Date.now() - postedAt <= 3000, `A sees B's pinned comment live, ${Date.now() - postedAt} ms after B posted it (budget 3000 ms, poll ${liveMs} ms)`)
  await pageA.getByTestId('comments-alert').waitFor({ state: 'visible', timeout: 3000 })
  check(true, 'A sees the unread mention dot on the Comments tab')
  await pageA.getByTestId('mention-banner').waitFor({ state: 'visible', timeout: 3000 })
  check((await pageA.getByTestId('mention-banner').textContent())?.includes('1 unread mention'), 'A sees "1 unread mention of you" in the Comments panel')
  check((await pageA.getByTestId('slide-comment-count').first().textContent())?.trim() === '1', 'the filmstrip shows one open comment on slide 1')
  check((await pageA.getByTestId('thread-anchor').first().textContent())?.includes('Title'), 'the thread is anchored to the title element')
  await pageA.screenshot({ path: join(shotDir, 'comments.png') })
  log('comments.png saved')

  // A checks the Mentions list on the dashboard. The badge shows the mention, and opening the list clears it.
  await pageA.goto(`${base}/`)
  await pageA.waitForLoadState('networkidle')
  await pageA.getByTestId('mentions-badge').waitFor({ state: 'visible', timeout: 10000 })
  check((await pageA.getByTestId('mentions-badge').textContent())?.trim() === '1', 'the dashboard shows a mention badge with 1')
  await pageA.getByRole('button', { name: /^Mentions/ }).click()
  await pageA.getByTestId('mentions-list').getByText(`${people.b.name}: Check the title`).waitFor({ state: 'visible', timeout: 5000 })
  check(true, 'the Mentions list shows B\'s comment')
  await pageA.getByRole('dialog', { name: 'Mentions' }).getByRole('button', { name: 'Close' }).click()
  await pageA.getByTestId('mentions-badge').waitFor({ state: 'detached', timeout: 5000 })
  check(true, 'opening the Mentions list clears the badge')

  await pageA.goto(`${base}/d/${deckId}`)
  await pageA.getByText('Extensions', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
  await statusSaved(pageA).waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByTestId('side-tab-comments').click()
  await pageA.getByTestId('comment-thread').first().waitFor({ state: 'visible', timeout: 10000 })

  // A replies and resolves. B sees the resolution live.
  const reply = pageA.getByTestId('comment-thread').first().getByLabel('Reply', { exact: true })
  await reply.fill('Fixed in the next version.')
  await pageA.getByTestId('comment-thread').first().getByRole('button', { name: 'Reply', exact: true }).click()
  await pageA.getByTestId('comment-thread').first().getByText('Fixed in the next version.').waitFor({ state: 'visible', timeout: 5000 })
  await pageA.getByTestId('comment-thread').first().getByRole('button', { name: 'Resolve', exact: true }).click()
  // Resolved threads are hidden until the "Resolved" toggle is on. The thread leaves B's open list at once.
  await pageA.getByLabel('Resolved', { exact: true }).check()
  await pageA.getByTestId('comment-thread').first().getByTestId('thread-resolved').waitFor({ state: 'visible', timeout: 5000 })
  check(true, 'A replied, and resolved the thread (shown with the Resolved toggle on)')
  await pageB.getByTestId('side-tab-comments').click()
  await waitUntil('B no longer sees the thread as open', async () => (await pageB.getByTestId('comment-thread').count()) === 0, 3000)
  check((await pageB.getByTestId('comment-pin').count()) === 0, 'B sees the resolved thread leave the open list and the canvas, live')
  check((await pageB.getByRole('button', { name: 'Resolve', exact: true }).count()) === 0, 'B (commenter) has no Resolve control')
  check(await pageB.locator('[aria-label="Text box"]').isDisabled(), 'B still cannot change slides after commenting')

  // An element deleted by A: the thread stays and says the element was removed.
  await pageA.locator(`[data-testid=slide-canvas] [data-el="${elementId}"]`).click()
  await pageA.keyboard.press('Delete')
  await pageA.getByLabel('Resolved', { exact: true }).check()
  await pageA.getByTestId('thread-anchor').first().filter({ hasText: 'element removed' }).waitFor({ state: 'visible', timeout: 5000 })
  check(true, 'after the element is deleted, the thread stays with "element removed"')

  // ---- Scenario A: version history. Name v1, change the deck, preview v1, restore it. B converges.
  await pageA.getByLabel('Deck title').fill('Quarterly v1')
  await pageA.getByLabel('Deck title').press('Enter')
  await statusSaved(pageA).waitFor({ state: 'visible', timeout: 20000 })
  await pageA.getByTestId('side-tab-history').click()
  await pageA.getByRole('button', { name: 'Name current version…' }).click()
  const naming = pageA.getByRole('dialog', { name: 'Name current version' })
  await naming.getByRole('textbox').fill('v1')
  await naming.getByRole('button', { name: 'Save version' }).click()
  await pageA.getByRole('region', { name: 'Named versions' }).getByText('v1', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
  check(true, 'A named the current version "v1" (History ▸ Name current version)')

  // Edit more: a fourth slide and a new title, written through the collab service like an agent would.
  await internalOps(deckId, [
    { op: 'addSlide', layout: 'blank', slide: { id: `m7-s4-${stamp}` } },
    { op: 'setTitle', title: 'Quarterly after v1' },
  ])
  await waitUntil('A sees the fourth slide', async () => (await pageA.locator('[id^="thumb-"]').count()) === 4, 5000)

  await pageA.getByTestId('version-row').filter({ hasText: 'v1' }).first().click()
  const preview = pageA.getByTestId('version-preview')
  await preview.waitFor({ state: 'visible', timeout: 10000 })
  check((await preview.textContent())?.includes('Viewing v1'), 'the preview banner says "Viewing v1", read only')
  check((await pageA.locator('[id^="thumb-"]').count()) === 3, 'the preview shows the three slides of v1')
  check((await preview.textContent())?.includes('1 only in the current deck'), 'the preview summary says one slide is only in the current deck')
  check(await pageA.locator('[aria-label="Text box"]').isDisabled(), 'the editing controls are off while previewing')
  await pageA.screenshot({ path: join(shotDir, 'history-preview.png') })
  log('history-preview.png saved')

  pageA.once('dialog', (d) => d.accept())
  await preview.getByRole('button', { name: 'Restore this version', exact: true }).click()
  await waitUntil('A is back to the restored version', async () => (await pageA.locator('[id^="thumb-"]').count()) === 3, 10000)
  await pageA.getByTestId('version-preview').waitFor({ state: 'detached', timeout: 5000 })
  check((await pageA.getByLabel('Deck title').inputValue()) === 'Quarterly v1', "A's deck is v1 after the restore")
  await waitUntil('History lists "Before restore"', async () => (await pageA.getByTestId('version-row').filter({ hasText: 'Before restore' }).count()) >= 1, 8000, 250)
  check(true, 'the state before the restore is kept in History as "Before restore"')

  await waitUntil(
    'B converges to v1 after the restore',
    async () => (await pageB.locator('[id^="thumb-"]').count()) === 3 && (await pageB.getByLabel('Deck title').inputValue()) === 'Quarterly v1',
    5000,
  )
  check(true, "B's window converged to v1 (three slides, title \"Quarterly v1\") without a reload")

  // ---- Scenario B: presenter view and phone remote.
  const audienceUrlPromise = ctxA.waitForEvent('page')
  await pageA.getByRole('button', { name: 'Present', exact: true }).click()
  const audience = await audienceUrlPromise
  watch(audience, 'audience')
  await audience.waitForURL(/\/present\?slide=1&sid=/, { timeout: 20000 })
  await audience.locator('section.present').waitFor({ state: 'attached', timeout: 20000 })
  check(true, 'A opened the audience window from Present (slide 1, with a presenter session)')

  await audience.bringToFront()
  const presenterPromise = ctxA.waitForEvent('page')
  await audience.keyboard.press('s')
  const presenter = await presenterPromise
  watch(presenter, 'presenter')
  await presenter.getByTestId('presenter-view').waitFor({ state: 'visible', timeout: 20000 })
  await presenter.getByTestId('presenter-counter').filter({ hasText: 'Slide 1 of' }).waitFor({ state: 'visible', timeout: 10000 })
  check(true, 'S on the audience window opened the presenter view on the same session')
  await presenter.getByTestId('audience-status').filter({ hasText: 'Audience window open' }).waitFor({ state: 'visible', timeout: 10000 })
  check(true, 'the presenter view sees the audience window')

  await presenter.getByRole('button', { name: 'Phone remote', exact: true }).click()
  await presenter.getByTestId('remote-url').waitFor({ state: 'visible', timeout: 10000 })
  const remoteUrl = (await presenter.getByTestId('remote-url').textContent())?.trim() ?? ''
  check(/^http:\/\/localhost:3000\/r\/[A-Za-z0-9._-]+$/.test(remoteUrl), `the presenter view shows the QR and a /r/<token> link: ${remoteUrl.slice(0, 40)}…`)
  check((await presenter.getByTestId('remote-qr').locator('svg').count()) === 1, 'the QR code is rendered as an SVG')
  await presenter.screenshot({ path: join(shotDir, 'presenter.png') })
  log('presenter.png saved')

  // The presenter's state must reach the phone's server view before the phone uses it.
  const stateUrl = remoteUrl.replace('/r/', '/api/remote/') + '/state'
  await waitUntil('the presenter reports its state for the phone', async () => {
    const body = await (await fetch(stateUrl)).json()
    return body.presenterOnline === true && body.state?.slide === 1
  }, 15000, 250)
  check(true, 'the presenter state reached the phone endpoint (slide 1 of 3)')

  // A phone-sized context opens the link. Next, Next. The audience window must be on slide 3.
  const phoneCtx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const phone = await phoneCtx.newPage()
  watch(phone, 'phone')
  await phone.goto(remoteUrl)
  await phone.getByTestId('phone-presenter-status').filter({ hasText: 'Connected' }).waitFor({ state: 'visible', timeout: 10000 })
  const counterText = await waitUntil('the phone shows slide 1 of 3', async () => (await phone.getByTestId('phone-counter').textContent())?.trim() === '1 / 3', 10000, 200)
    .then(() => '1 / 3')
    .catch(async () => (await phone.getByTestId('phone-counter').textContent())?.trim())
  check(counterText === '1 / 3', `the phone shows Connected and slide 1 / 3 (phone reads "${counterText}")`)
  await phone.getByTestId('phone-next').tap()
  await phone.getByTestId('phone-counter').filter({ hasText: '2 / 3' }).waitFor({ state: 'visible', timeout: 5000 })
  await phone.getByTestId('phone-next').tap()
  await phone.getByTestId('phone-counter').filter({ hasText: '3 / 3' }).waitFor({ state: 'visible', timeout: 5000 })
  await audience.waitForFunction(
    (id) => document.querySelector('.reveal section.present')?.getAttribute('data-slide-id') === id,
    slide3,
    { timeout: 5000 },
  )
  check(true, 'two taps of Next on the phone put the audience window on slide 3')
  await phone.getByTestId('phone-notes').filter({ hasText: 'Notes for slide three, read on the phone' }).waitFor({ state: 'visible', timeout: 5000 })
  check(true, 'the phone shows the notes of slide 3')
  await presenter.getByTestId('presenter-counter').filter({ hasText: 'Slide 3 of 3' }).waitFor({ state: 'visible', timeout: 5000 })
  check(true, 'the presenter view follows: Slide 3 of 3')
  await phone.screenshot({ path: join(shotDir, 'phone-remote.png') })
  log('phone-remote.png saved (390 x 844)')

  // A viewer follows the presenter. The audience window's slide reaches the follower within a few seconds (heartbeat),
  // and a Prev in the presenter view moves the follower too.
  const ctxC = await newContext()
  const pageC = await ctxC.newPage()
  watch(pageC, 'C')
  await signUpAndIn(ctxC, people.c)
  const sid = new URL(audience.url()).searchParams.get('sid')
  await waitUntil(
    'C (viewer) has access to the deck',
    async () => {
      await pageC.goto(`${base}/d/${deckId}`)
      return pageC.getByText('View only', { exact: true }).waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)
    },
    30000,
    500,
  )
  await pageC.goto(`${base}/d/${deckId}/present?follow=${sid}`)
  await pageC.getByTestId('follow-badge').waitFor({ state: 'visible', timeout: 20000 })
  await pageC.waitForFunction((id) => document.querySelector('.reveal section.present')?.getAttribute('data-slide-id') === id, slide3, { timeout: 8000 })
  check(true, 'a viewer who follows the presenter lands on the presenter\'s slide 3 (within the heartbeat)')
  await presenter.getByRole('button', { name: 'Previous slide', exact: true }).click()
  await pageC.waitForFunction((id) => document.querySelector('.reveal section.present')?.getAttribute('data-slide-id') === id, slide2, { timeout: 5000 })
  check(true, 'when the presenter goes back to slide 2, the follower follows to slide 2')
  await presenter.getByRole('button', { name: 'Next slide', exact: true }).click()
  await pageC.waitForFunction((id) => document.querySelector('.reveal section.present')?.getAttribute('data-slide-id') === id, slide3, { timeout: 5000 })
  check(true, 'and forward again to slide 3')

  // Closing the remote stops the phone at once.
  await presenter.getByRole('button', { name: 'Close remote', exact: true }).click()
  await phone.getByTestId('phone-problem').filter({ hasText: 'closed' }).waitFor({ state: 'visible', timeout: 5000 })
  check(true, 'closing the remote in the presenter view stops the phone (its next command or poll is refused)')

  void idA
  void idB
} catch (e) {
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => undefined)
  await browser.close()
}

// The phone's own 410 responses after the remote is closed are the refusal being tested, not a fault.
const unexpected = errors.filter((e) => !(e.startsWith('phone console:') && e.includes('status of 410')))
if (unexpected.length) {
  console.error(`browser errors:\n${unexpected.join('\n')}`)
  process.exitCode = 1
}
if (process.exitCode) process.exit(process.exitCode)
console.log('m7 check passed')

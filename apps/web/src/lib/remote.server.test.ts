// The phone remote's server rules against real Postgres: token and session checks, revocation, lost access,
// rate limiting, command forwarding and presenter staleness. The collab service is a fake here.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grantMembership, issueRemoteSession, removeMember, revokeRemoteSession, signRemoteToken, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { FixedWindowLimiter } from './mcp/rate-limit'
import { handleRemoteCommand, handleRemoteState, type RemoteDeps, PRESENTER_STALE_MS } from './remote.server'

const SECRET = 'web-remote-test-collab-secret-0123456789'
const NOW = Date.UTC(2026, 10, 3, 9, 0, 0)

let db: Db | null = null
const users: string[] = []

beforeAll(async () => {
  db = await connectOrNull()
})
afterAll(async () => {
  if (!db) return
  await removeUsers(db, users)
  await db.$client.end({ timeout: 1 })
})

interface FakeCollab {
  commands: Array<{ deckId: string; sid: string; action: string }>
  delivered: number
  state: { state: unknown; ageMs: number | null }
}

function fakeCollab(overrides: Partial<FakeCollab> = {}): FakeCollab & RemoteDeps['collab'] {
  const fake: FakeCollab = { commands: [], delivered: 1, state: { state: null, ageMs: null }, ...overrides }
  return Object.assign(fake, {
    remoteCommand: async (deckId: string, sid: string, action: string) => {
      fake.commands.push({ deckId, sid, action })
      return { delivered: fake.delivered }
    },
    remoteState: async () => fake.state as never,
  }) as FakeCollab & RemoteDeps['collab']
}

function depsFor(collab: RemoteDeps['collab'], limiter = new FixedWindowLimiter(20, 10_000)): RemoteDeps {
  return { db: db!, secret: SECRET, collab, limiter, now: () => NOW }
}

function commandRequest(body: unknown): Request {
  return new Request('http://localhost/api/remote/x/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function presenterSetup(label: string) {
  const owner = await makeUser(db!, `${label}-presenter`)
  users.push(owner.id)
  const deckId = await makeDeck(db!, owner.id, `${label} deck`)
  const sid = `s${randomUUID().replace(/-/g, '')}`
  await issueRemoteSession(db!, { id: sid, deckId, userId: owner.id })
  const { token } = signRemoteToken({ deckId, sid, userId: owner.id }, SECRET, NOW)
  return { owner, deckId, token, sid }
}

describe('phone remote (server rules)', () => {
  it('refuses when the secret is not configured, and when the token is not valid', async (ctx) => {
    if (!db) return ctx.skip()
    const collab = fakeCollab()
    const noSecret = await handleRemoteState({ ...depsFor(collab), secret: undefined }, 'anything')
    expect(noSecret.status).toBe(503)
    const bad = await handleRemoteState(depsFor(collab), 'not.a-token')
    expect(bad.status).toBe(401)
    expect(bad.headers.get('cache-control')).toBe('no-store')
    expect(bad.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('an expired token is 410, with a hint to start a new remote', async (ctx) => {
    if (!db) return ctx.skip()
    const { deckId, owner, sid } = await presenterSetup('expired')
    const { token } = signRemoteToken({ deckId, sid, userId: owner.id }, SECRET, NOW - 3_600_000)
    const res = await handleRemoteState(depsFor(fakeCollab()), token)
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('expired') })
  })

  it('a closed remote is refused at once, and nothing reaches the presenter', async (ctx) => {
    if (!db) return ctx.skip()
    const { deckId, owner, token, sid } = await presenterSetup('closed')
    const collab = fakeCollab()
    expect((await handleRemoteCommand(depsFor(collab), token, commandRequest({ action: 'next' }))).status).toBe(200)
    expect(await revokeRemoteSession(db, { id: sid, deckId, userId: owner.id })).toBe(true)
    const res = await handleRemoteCommand(depsFor(collab), token, commandRequest({ action: 'next' }))
    expect(res.status).toBe(410)
    expect(collab.commands).toHaveLength(1)
  })

  it('a presenter who lost access to the deck is refused on the next call', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'lost-owner')
    const presenter = await makeUser(db, 'lost-presenter')
    users.push(owner.id, presenter.id)
    const deckId = await makeDeck(db, owner.id, 'Lost access')
    await db.transaction((tx) => grantMembership(tx, deckId, presenter.id, 'editor'))
    const sid = `s${randomUUID().replace(/-/g, '')}`
    await issueRemoteSession(db, { id: sid, deckId, userId: presenter.id })
    const { token } = signRemoteToken({ deckId, sid, userId: presenter.id }, SECRET, NOW)
    expect((await handleRemoteState(depsFor(fakeCollab()), token)).status).toBe(200)
    await removeMember(db, deckId, presenter.id)
    const res = await handleRemoteState(depsFor(fakeCollab()), token)
    expect(res.status).toBe(403)
  })

  it('forwards next and prev to the presenter, and says so when no presenter window is open', async (ctx) => {
    if (!db) return ctx.skip()
    const { deckId, token, sid } = await presenterSetup('forward')
    const collab = fakeCollab()
    const ok = await handleRemoteCommand(depsFor(collab), token, commandRequest({ action: 'prev' }))
    expect(ok.status).toBe(200)
    expect(collab.commands).toEqual([{ deckId, sid, action: 'prev' }])
    expect((await handleRemoteCommand(depsFor(collab), token, commandRequest({ action: 'jump' }))).status).toBe(400)
    expect((await handleRemoteCommand(depsFor(collab), token, new Request('http://x', { method: 'POST', body: 'not json' }))).status).toBe(400)
    collab.delivered = 0
    const none = await handleRemoteCommand(depsFor(collab), token, commandRequest({ action: 'next' }))
    expect(none.status).toBe(409)
    expect(await none.json()).toMatchObject({ error: expect.stringContaining('not open') })
  })

  it('rate limits commands per session: 20 in a window, then 429 with Retry-After', async (ctx) => {
    if (!db) return ctx.skip()
    const { token } = await presenterSetup('rate')
    const collab = fakeCollab()
    const deps = depsFor(collab, new FixedWindowLimiter(20, 10_000))
    for (let i = 0; i < 20; i++) expect((await handleRemoteCommand(deps, token, commandRequest({ action: 'next' }))).status).toBe(200)
    const limited = await handleRemoteCommand(deps, token, commandRequest({ action: 'next' }))
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(collab.commands).toHaveLength(20)
  })

  it('reports the presenter as online only while its last state is fresh', async (ctx) => {
    if (!db) return ctx.skip()
    const { token } = await presenterSetup('state')
    const state = { slide: 3, total: 9, slideId: 's3', notes: 'Say it slowly', title: 'Deck' }
    const fresh = fakeCollab({ state: { state, ageMs: 1500 } })
    const onlineRes = await handleRemoteState(depsFor(fresh), token)
    expect(await onlineRes.json()).toMatchObject({ presenterOnline: true, state: { slide: 3, notes: 'Say it slowly' } })
    const stale = fakeCollab({ state: { state, ageMs: PRESENTER_STALE_MS + 1 } })
    expect(await (await handleRemoteState(depsFor(stale), token)).json()).toMatchObject({ presenterOnline: false })
    const nothing = fakeCollab()
    expect(await (await handleRemoteState(depsFor(nothing), token)).json()).toEqual({ presenterOnline: false, state: null })
  })
})

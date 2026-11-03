import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { signCollabToken } from './collab-token.ts'
import { pruneRemoteSessions, REMOTE_TOKEN_TTL_SECONDS, RemoteTokenError, getRemoteSession, issueRemoteSession, revokeRemoteSession, signRemoteToken, verifyRemoteToken } from './remote-session.ts'
import type { Db } from './client.ts'

const SECRET = 'remote-test-collab-secret-0123456789'
const DECK = '0b1f9c3e-2f7a-4d8e-9a10-3c5d7e9f1a2b'
const SID = 'abcdefghijklmnop1234'
const NOW = 1_800_000_000_000

describe('remote tokens (pure)', () => {
  it('signs and verifies a token for its deck and session', () => {
    const { token, expiresAt } = signRemoteToken({ deckId: DECK, sid: SID, userId: 'user-1' }, SECRET, NOW)
    expect(expiresAt).toBe(NOW + REMOTE_TOKEN_TTL_SECONDS * 1000)
    expect(verifyRemoteToken(token, SECRET, NOW + 1000)).toMatchObject({ deckId: DECK, sid: SID, userId: 'user-1' })
  })

  it('expires after 30 minutes', () => {
    const { token } = signRemoteToken({ deckId: DECK, sid: SID, userId: 'user-1' }, SECRET, NOW)
    expect(() => verifyRemoteToken(token, SECRET, NOW + (REMOTE_TOKEN_TTL_SECONDS - 1) * 1000)).not.toThrow()
    expect(() => verifyRemoteToken(token, SECRET, NOW + REMOTE_TOKEN_TTL_SECONDS * 1000)).toThrow(RemoteTokenError)
    try {
      verifyRemoteToken(token, SECRET, NOW + REMOTE_TOKEN_TTL_SECONDS * 1000 + 1)
    } catch (err) {
      expect((err as RemoteTokenError).reason).toBe('expired')
    }
  })

  it('refuses a tampered payload, a wrong secret, and a malformed token', () => {
    const { token } = signRemoteToken({ deckId: DECK, sid: SID, userId: 'user-1' }, SECRET, NOW)
    const [payload, sig] = token.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ deckId: DECK, sid: SID, userId: 'someone-else', exp: 2_000_000_000 })).toString('base64url')
    expect(reasonOf(() => verifyRemoteToken(`${forged}.${sig}`, SECRET, NOW))).toBe('bad-signature')
    expect(reasonOf(() => verifyRemoteToken(token, 'a-different-secret-that-is-long-enough', NOW))).toBe('bad-signature')
    expect(reasonOf(() => verifyRemoteToken(`${payload}`, SECRET, NOW))).toBe('malformed')
    expect(reasonOf(() => verifyRemoteToken('a.b.c', SECRET, NOW))).toBe('malformed')
  })

  it('refuses claims that are not a valid remote session', () => {
    const bad = Buffer.from(JSON.stringify({ deckId: 'not-a-uuid', sid: 'short', userId: 'u', exp: 2_000_000_000 })).toString('base64url')
    const { token } = signRemoteToken({ deckId: DECK, sid: SID, userId: 'u' }, SECRET, NOW)
    const sig = token.split('.')[1]!
    // the signature is for the good payload, so the forged payload fails the signature check first
    expect(reasonOf(() => verifyRemoteToken(`${bad}.${sig}`, SECRET, NOW))).toBe('bad-signature')
    expect(() => signRemoteToken({ deckId: DECK, sid: 'short', userId: 'u' }, SECRET, NOW)).toThrow()
  })

  it('a collab token signed with the same secret is not accepted as a remote token', () => {
    const collab = signCollabToken({ userId: 'user-1', deckId: DECK, role: 'owner', name: 'Ana', image: null }, SECRET, NOW)
    expect(reasonOf(() => verifyRemoteToken(collab, SECRET, NOW))).toBe('bad-signature')
  })
})

function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof RemoteTokenError ? err.reason : 'other'
  }
  return 'ok'
}

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

describe('remote sessions (real Postgres)', () => {
  it('creates a session once, reuses it for the same presenter, and refuses other users', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'remote-owner')
    const other = await makeUser(db, 'remote-other')
    users.push(owner.id, other.id)
    const deckId = await makeDeck(db, owner.id, 'Remote')
    const sid = `sess-${owner.id.slice(-8)}-abcdef12`
    expect(await issueRemoteSession(db, { id: sid, deckId, userId: owner.id })).toBe('created')
    expect(await issueRemoteSession(db, { id: sid, deckId, userId: owner.id })).toBe('reused')
    await expect(issueRemoteSession(db, { id: sid, deckId, userId: other.id })).rejects.toThrow('Session not found')
  })

  it('prunes session rows older than the cutoff and keeps recent ones', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'remote-prune')
    users.push(owner.id)
    const deckId = await makeDeck(db, owner.id, 'Prune remote')
    const old = `old-${owner.id.slice(-8)}-abcdef12`
    const fresh = `new-${owner.id.slice(-8)}-abcdef12`
    await issueRemoteSession(db, { id: old, deckId, userId: owner.id, now: new Date(Date.now() - 2 * 24 * 3600 * 1000) })
    await issueRemoteSession(db, { id: fresh, deckId, userId: owner.id })
    const removed = await pruneRemoteSessions(db, new Date(Date.now() - 24 * 3600 * 1000))
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(await getRemoteSession(db, old)).toBeNull()
    expect(await getRemoteSession(db, fresh)).not.toBeNull()
  })

  it('revokes a session once, and refuses to reuse a revoked one', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await makeUser(db, 'remote-revoke')
    users.push(owner.id)
    const deckId = await makeDeck(db, owner.id, 'Revoke')
    const sid = `rev-${owner.id.slice(-8)}-abcdef12`
    await issueRemoteSession(db, { id: sid, deckId, userId: owner.id })
    expect(await revokeRemoteSession(db, { id: sid, deckId, userId: owner.id })).toBe(true)
    expect(await revokeRemoteSession(db, { id: sid, deckId, userId: owner.id })).toBe(false)
    expect((await getRemoteSession(db, sid))?.revokedAt).toBeTruthy()
    await expect(issueRemoteSession(db, { id: sid, deckId, userId: owner.id })).rejects.toThrow('closed')
  })
})

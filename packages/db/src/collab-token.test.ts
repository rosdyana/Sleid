import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { COLLAB_TOKEN_TTL_SECONDS, CollabTokenError, signCollabToken, verifyCollabToken } from './collab-token.ts'

const SECRET = 'test-secret-that-is-at-least-32-characters-long'
const DECK = '6f1f2c1e-8a64-4a7b-9d55-0e7d3c2b1a10'
const OTHER_DECK = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)

function claims(overrides: Partial<{ role: 'owner' | 'editor' | 'commenter' | 'viewer' }> = {}) {
  return { userId: 'user-1', deckId: DECK, role: 'editor' as const, name: 'Ada', image: null, ...overrides }
}

function reason(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof CollabTokenError) return err.reason
    throw err
  }
  return 'no-error'
}

describe('collab token', () => {
  it('signs and verifies claims for the deck it was issued for', () => {
    const token = signCollabToken(claims({ role: 'viewer' }), SECRET, NOW)
    const verified = verifyCollabToken(token, SECRET, { deckId: DECK, now: NOW })
    expect(verified).toMatchObject({ userId: 'user-1', deckId: DECK, role: 'viewer', name: 'Ada', image: null })
  })

  it('defaults to a five minute lifetime', () => {
    const token = signCollabToken(claims(), SECRET, NOW)
    const verified = verifyCollabToken(token, SECRET, { now: NOW })
    expect(verified.exp - Math.floor(NOW / 1000)).toBe(COLLAB_TOKEN_TTL_SECONDS)
    expect(COLLAB_TOKEN_TTL_SECONDS).toBe(300)
  })

  it('rejects an expired token', () => {
    const token = signCollabToken(claims(), SECRET, NOW)
    const later = NOW + (COLLAB_TOKEN_TTL_SECONDS + 1) * 1000
    expect(reason(() => verifyCollabToken(token, SECRET, { deckId: DECK, now: later }))).toBe('expired')
  })

  it('rejects a token for another deck', () => {
    const token = signCollabToken(claims(), SECRET, NOW)
    expect(reason(() => verifyCollabToken(token, SECRET, { deckId: OTHER_DECK, now: NOW }))).toBe('wrong-deck')
  })

  it('rejects a tampered payload, so a viewer cannot edit their role into owner', () => {
    const token = signCollabToken(claims({ role: 'viewer' }), SECRET, NOW)
    const [payload, signature] = token.split('.') as [string, string]
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    forged.role = 'owner'
    const forgedPayload = Buffer.from(JSON.stringify(forged)).toString('base64url')
    expect(reason(() => verifyCollabToken(`${forgedPayload}.${signature}`, SECRET, { now: NOW }))).toBe('bad-signature')
  })

  it('rejects a tampered signature', () => {
    const token = signCollabToken(claims(), SECRET, NOW)
    const [payload, signature] = token.split('.') as [string, string]
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
    expect(reason(() => verifyCollabToken(`${payload}.${flipped}`, SECRET, { now: NOW }))).toBe('bad-signature')
  })

  it('rejects a token signed with a different secret', () => {
    const token = signCollabToken(claims(), 'another-secret-that-is-also-long-enough-1234', NOW)
    expect(reason(() => verifyCollabToken(token, SECRET, { now: NOW }))).toBe('bad-signature')
  })

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'abc', '.', 'a.', '.b', 'a.b.c']) {
      expect(reason(() => verifyCollabToken(bad, SECRET, { now: NOW }))).toBe('malformed')
    }
  })

  it('rejects a correctly signed payload whose claims are invalid', () => {
    const payload = Buffer.from(JSON.stringify({ userId: 'u', deckId: DECK, role: 'superadmin', name: 'x', image: null, exp: 9e12 })).toString('base64url')
    const signature = createHmac('sha256', SECRET).update(payload).digest('base64url')
    expect(reason(() => verifyCollabToken(`${payload}.${signature}`, SECRET, { now: NOW }))).toBe('invalid-claims')
  })

  it('refuses to sign or verify with a short secret', () => {
    expect(() => signCollabToken(claims(), 'short', NOW)).toThrow(/at least 32/)
    expect(() => verifyCollabToken('a.b', 'short', { now: NOW })).toThrow(/at least 32/)
  })
})

// Personal access tokens, MCP audit rows and one-time export links, against real Postgres.
// Skips with a message when the database is not reachable.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from './client.ts'
import { apiTokens, exportJobs } from './schema/index.ts'
import { connectOrNull, makeDeck, makeUser, removeUsers } from './testing.ts'
import {
  DEFAULT_TOKEN_DAYS,
  LAST_USED_THROTTLE_MS,
  TOKEN_PREFIX,
  createApiToken,
  hashSecret,
  listApiTokens,
  listMcpAudit,
  normalizeTokenInput,
  recordMcpAudit,
  revokeApiToken,
  tokenAllowsDeck,
  tokenHasScope,
  verifyApiToken,
} from './api-tokens.ts'
import { createExportJob, markExportDone } from './export-jobs.ts'
import { consumeExportLink, findExportByLink, issueExportLink } from './export-links.ts'

let db: Db | null = null
const users: string[] = []
const DAY = 24 * 60 * 60 * 1000

beforeAll(async () => {
  db = await connectOrNull()
})

afterAll(async () => {
  if (db) {
    await removeUsers(db, users)
    await db.$client.end({ timeout: 1 })
  }
})

async function person(label: string) {
  const u = await makeUser(db!, label)
  users.push(u.id)
  return u
}

describe('token secrets and hashes', () => {
  it('uses the sleid_pat_ prefix and 32 random bytes in base64url', async () => {
    if (!db) return
    const u = await person('tok-format')
    const { secret } = await createApiToken(db, { userId: u.id, name: 'format', scopes: ['decks:read'], deckIds: null })
    expect(secret.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(secret.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('stores only the SHA-256 of the secret, and the hint is its last six characters', async () => {
    if (!db) return
    const u = await person('tok-hash')
    const { secret, token } = await createApiToken(db, { userId: u.id, name: 'hash', scopes: ['decks:read'], deckIds: null })
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, token.id))
    expect(row!.tokenHash).toBe(hashSecret(secret))
    expect(row!.tokenHash).not.toContain(secret)
    expect(token.hint).toBe(secret.slice(-6))
    expect(JSON.stringify(row)).not.toContain(secret)
  })

  it('defaults to a 90 day expiry', async () => {
    if (!db) return
    const u = await person('tok-expiry-default')
    const now = new Date('2026-01-01T00:00:00Z')
    const { token } = await createApiToken(db, { userId: u.id, name: 'd', scopes: ['decks:read'], deckIds: null, now })
    expect(token.expiresAt.getTime() - now.getTime()).toBe(DEFAULT_TOKEN_DAYS * DAY)
  })
})

describe('input rules', () => {
  it('rejects bad names, empty or unknown scopes, bad deck ids and out-of-range expiry', () => {
    expect(() => normalizeTokenInput({ userId: 'x', name: '  ', scopes: ['ai'], deckIds: null })).toThrow(/name/)
    expect(() => normalizeTokenInput({ userId: 'x', name: 'n', scopes: [], deckIds: null })).toThrow(/scope/)
    expect(() => normalizeTokenInput({ userId: 'x', name: 'n', scopes: ['admin'], deckIds: null })).toThrow(/Unknown scope/)
    expect(() => normalizeTokenInput({ userId: 'x', name: 'n', scopes: ['ai'], deckIds: ['nope'] })).toThrow(/UUID/)
    expect(() => normalizeTokenInput({ userId: 'x', name: 'n', scopes: ['ai'], deckIds: [] })).toThrow(/deck/)
    expect(() => normalizeTokenInput({ userId: 'x', name: 'n', scopes: ['ai'], deckIds: null, expiresInDays: 366 })).toThrow(/1 to 365/)
    expect(() => normalizeTokenInput({ userId: 'x', name: 'n', scopes: ['ai'], deckIds: null, expiresInDays: 0 })).toThrow(/1 to 365/)
  })

  it('dedupes scopes and deck ids', () => {
    const out = normalizeTokenInput({
      userId: 'x',
      name: ' n ',
      scopes: ['ai', 'ai', 'exports'],
      deckIds: [randomUUID(), 'A0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000000'],
    })
    expect(out.name).toBe('n')
    expect(out.scopes).toEqual(['ai', 'exports'])
    expect(out.deckIds).toHaveLength(2)
  })
})

describe('verify, expiry, revoke', () => {
  it('verifies a live token and returns its owner, scopes and allowlist', async () => {
    if (!db) return
    const u = await person('tok-verify')
    const deck = randomUUID()
    const { secret, token } = await createApiToken(db, { userId: u.id, name: 'v', scopes: ['decks:read', 'ai'], deckIds: [deck] })
    const verified = await verifyApiToken(db, secret)
    expect(verified).toMatchObject({ tokenId: token.id, userId: u.id, userEmail: u.email, scopes: ['decks:read', 'ai'], deckIds: [deck] })
  })

  it('refuses unknown, malformed and foreign-prefix secrets', async () => {
    if (!db) return
    expect(await verifyApiToken(db, 'sleid_pat_' + 'A'.repeat(43))).toBeNull()
    expect(await verifyApiToken(db, 'not-a-token')).toBeNull()
    expect(await verifyApiToken(db, 'sleid_pat_' + 'x'.repeat(300))).toBeNull()
  })

  it('refuses an expired token, and accepts it again only through a later clock (the check uses the given time)', async () => {
    if (!db) return
    const u = await person('tok-expired')
    const now = new Date('2026-02-01T00:00:00Z')
    const { secret } = await createApiToken(db, { userId: u.id, name: 'e', scopes: ['decks:read'], deckIds: null, expiresInDays: 1, now })
    expect(await verifyApiToken(db, secret, new Date(now.getTime() + DAY / 2))).not.toBeNull()
    expect(await verifyApiToken(db, secret, new Date(now.getTime() + DAY + 1000))).toBeNull()
  })

  it('refuses a revoked token at once, and only its owner can revoke it', async () => {
    if (!db) return
    const owner = await person('tok-revoke-owner')
    const other = await person('tok-revoke-other')
    const { secret, token } = await createApiToken(db, { userId: owner.id, name: 'r', scopes: ['decks:read'], deckIds: null })
    expect(await revokeApiToken(db, other.id, token.id)).toBe(false)
    expect(await verifyApiToken(db, secret)).not.toBeNull()
    expect(await revokeApiToken(db, owner.id, token.id)).toBe(true)
    expect(await verifyApiToken(db, secret)).toBeNull()
    expect(await revokeApiToken(db, owner.id, token.id)).toBe(false)
    const listed = (await listApiTokens(db, owner.id)).find((t) => t.id === token.id)
    expect(listed?.revokedAt).toBeInstanceOf(Date)
  })

  it('writes last_used_at, but not on every call (throttled)', async () => {
    if (!db) return
    const u = await person('tok-used')
    const start = new Date('2026-03-01T00:00:00Z')
    const { secret, token } = await createApiToken(db, { userId: u.id, name: 'u', scopes: ['decks:read'], deckIds: null, now: start })
    await verifyApiToken(db, secret, start)
    await new Promise((r) => setTimeout(r, 50))
    const first = (await listApiTokens(db, u.id)).find((t) => t.id === token.id)!.lastUsedAt
    expect(first?.getTime()).toBe(start.getTime())
    // A call a moment later does not move the timestamp.
    await verifyApiToken(db, secret, new Date(start.getTime() + 1000))
    await new Promise((r) => setTimeout(r, 50))
    const second = (await listApiTokens(db, u.id)).find((t) => t.id === token.id)!.lastUsedAt
    expect(second?.getTime()).toBe(start.getTime())
    // After the throttle window it moves.
    await verifyApiToken(db, secret, new Date(start.getTime() + LAST_USED_THROTTLE_MS + 1000))
    await new Promise((r) => setTimeout(r, 50))
    const third = (await listApiTokens(db, u.id)).find((t) => t.id === token.id)!.lastUsedAt
    expect(third!.getTime()).toBe(start.getTime() + LAST_USED_THROTTLE_MS + 1000)
  })
})

describe('scope and deck allowlist helpers', () => {
  it('checks scopes and the allowlist (null allows every deck)', () => {
    const token = { scopes: ['decks:read', 'exports'] as string[], deckIds: null as string[] | null }
    expect(tokenHasScope(token, 'exports')).toBe(true)
    expect(tokenHasScope(token, 'ai')).toBe(false)
    expect(tokenAllowsDeck(token, randomUUID())).toBe(true)
    const deck = randomUUID()
    const limited = { deckIds: [deck] }
    expect(tokenAllowsDeck(limited, deck)).toBe(true)
    expect(tokenAllowsDeck(limited, deck.toUpperCase())).toBe(true)
    expect(tokenAllowsDeck(limited, randomUUID())).toBe(false)
  })
})

describe('audit rows', () => {
  it('records each call with user, token, tool, deck, outcome and time, and truncates long errors', async () => {
    if (!db) return
    const u = await person('audit')
    const { token } = await createApiToken(db, { userId: u.id, name: 'a', scopes: ['decks:read'], deckIds: null })
    const deck = await makeDeck(db, u.id, 'Audit deck')
    await recordMcpAudit(db, { userId: u.id, tokenId: token.id, tool: 'get_deck', deckId: deck, ok: true, ms: 12.4 })
    await recordMcpAudit(db, { userId: u.id, tokenId: token.id, tool: 'apply_ops', deckId: deck, ok: false, ms: 3, error: 'x'.repeat(1000) })
    const rows = await listMcpAudit(db, u.id)
    expect(rows).toHaveLength(2)
    const failed = rows.find((r) => r.tool === 'apply_ops')!
    expect(failed).toMatchObject({ userId: u.id, tokenId: token.id, deckId: deck, ok: false, ms: 3 })
    expect(failed.error!.length).toBe(300)
    const ok = rows.find((r) => r.tool === 'get_deck')!
    expect(ok).toMatchObject({ ok: true, ms: 12 })
  })
})

describe('one-time export links', () => {
  it('a link works once, only on a finished export, and only until it expires', async () => {
    if (!db) return
    const u = await person('export-link')
    const deck = await makeDeck(db, u.id, 'Link deck')
    const exportId = await createExportJob(db, { deckId: deck, userId: u.id, format: 'json', options: {} })
    const now = new Date('2026-04-01T00:00:00Z')
    const { secret, expiresAt } = await issueExportLink(db, exportId, now)
    expect(expiresAt.getTime() - now.getTime()).toBe(15 * 60 * 1000)
    expect(secret.startsWith('sleid_dl_')).toBe(true)

    // Not finished yet: the link is kept and is not consumed.
    expect(await consumeExportLink(db, exportId, secret, now)).toBeNull()
    expect(await findExportByLink(db, exportId, secret, now)).not.toBeNull()

    await markExportDone(db, exportId, { fileKey: exportId, fileName: 'x.json', contentType: 'application/json', bytes: 2 })
    expect(await consumeExportLink(db, exportId, 'sleid_dl_' + 'a'.repeat(43), now)).toBeNull()
    const first = await consumeExportLink(db, exportId, secret, now)
    expect(first?.id).toBe(exportId)
    expect(await consumeExportLink(db, exportId, secret, now)).toBeNull()
    expect(await findExportByLink(db, exportId, secret, now)).toBeNull()
  })

  it('an expired link is refused', async () => {
    if (!db) return
    const u = await person('export-link-expired')
    const deck = await makeDeck(db, u.id, 'Expired link deck')
    const exportId = await createExportJob(db, { deckId: deck, userId: u.id, format: 'json', options: {} })
    const now = new Date('2026-05-01T00:00:00Z')
    const { secret } = await issueExportLink(db, exportId, now)
    await markExportDone(db, exportId, { fileKey: exportId, fileName: 'x.json', contentType: 'application/json', bytes: 2 })
    const later = new Date(now.getTime() + 16 * 60 * 1000)
    expect(await findExportByLink(db, exportId, secret, later)).toBeNull()
    expect(await consumeExportLink(db, exportId, secret, later)).toBeNull()
  })
})

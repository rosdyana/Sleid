// Personal access tokens for the MCP server, and the MCP audit log.
//
// A token is `sleid_pat_<32 random bytes, base64url>`. Only its SHA-256 (hex) is stored, so a database
// read does not reveal a usable token. Verification looks the token up by that hash (a unique index), then
// checks revocation and expiry. Scopes and the deck allowlist are returned to the caller, which checks them
// per call together with the user's current deck role.
import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import type { Db } from './client.ts'
import { apiTokens, mcpAudit, user } from './schema/index.ts'

export const TOKEN_PREFIX = 'sleid_pat_'
export const TOKEN_SCOPES = ['decks:read', 'decks:write', 'decks:create', 'exports', 'ai'] as const
export type TokenScope = (typeof TOKEN_SCOPES)[number]

export const DEFAULT_TOKEN_DAYS = 90
export const MAX_TOKEN_DAYS = 365
/** `last_used_at` is written at most this often, so a busy agent does not write on every call. */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** A new token secret. Shown once; only its hash is stored. */
export function generateTokenSecret(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

export interface TokenRecord {
  id: string
  name: string
  hint: string
  scopes: TokenScope[]
  /** Null means every deck the user can access. */
  deckIds: string[] | null
  expiresAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

export interface CreateTokenInput {
  userId: string
  name: string
  scopes: readonly string[]
  /** Null for all decks. Otherwise a non-empty list of deck ids. */
  deckIds: readonly string[] | null
  /** Days until expiry. Default 90, at most 365. */
  expiresInDays?: number
  now?: Date
}

/** Checks the input and returns it in its stored form. Throws with a message the user can read. */
export function normalizeTokenInput(input: CreateTokenInput): { name: string; scopes: TokenScope[]; deckIds: string[] | null; expiresInDays: number } {
  const name = input.name.trim()
  if (name.length < 1 || name.length > 80) throw new Error('The token name must be 1 to 80 characters.')
  const scopes = [...new Set(input.scopes)]
  if (scopes.length === 0) throw new Error('Choose at least one scope.')
  for (const scope of scopes) {
    if (!(TOKEN_SCOPES as readonly string[]).includes(scope)) throw new Error(`Unknown scope: ${scope}`)
  }
  let deckIds: string[] | null = null
  if (input.deckIds !== null) {
    deckIds = [...new Set(input.deckIds.map((id) => id.toLowerCase()))]
    if (deckIds.length === 0) throw new Error('Pick at least one deck, or allow all decks.')
    if (!deckIds.every((id) => UUID.test(id))) throw new Error('Deck ids must be UUIDs.')
  }
  const days = input.expiresInDays ?? DEFAULT_TOKEN_DAYS
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) throw new Error(`Expiry must be 1 to ${MAX_TOKEN_DAYS} days.`)
  return { name, scopes: scopes as TokenScope[], deckIds, expiresInDays: days }
}

/** Creates a token. The returned `secret` is the only copy; the caller must show it now. */
export async function createApiToken(db: Db, input: CreateTokenInput): Promise<{ secret: string; token: TokenRecord }> {
  const normalized = normalizeTokenInput(input)
  const now = input.now ?? new Date()
  const secret = generateTokenSecret()
  const expiresAt = new Date(now.getTime() + normalized.expiresInDays * 24 * 60 * 60 * 1000)
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: input.userId,
      name: normalized.name,
      hint: secret.slice(-6),
      tokenHash: hashSecret(secret),
      scopes: normalized.scopes,
      deckIds: normalized.deckIds,
      expiresAt,
      createdAt: now,
    })
    .returning()
  if (!row) throw new Error('could not create the token')
  return { secret, token: toRecord(row) }
}

function toRecord(row: typeof apiTokens.$inferSelect): TokenRecord {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    scopes: row.scopes as TokenScope[],
    deckIds: row.deckIds ?? null,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  }
}

/** The user's tokens, newest first. Revoked and expired ones are included so the list shows them. */
export async function listApiTokens(db: Db, userId: string): Promise<TokenRecord[]> {
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.createdAt))
  return rows.map(toRecord)
}

/** Revokes one of the user's tokens. Returns false when it is not theirs, not found, or already revoked. */
export async function revokeApiToken(db: Db, userId: string, tokenId: string, now = new Date()): Promise<boolean> {
  if (!UUID.test(tokenId)) return false
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id })
  return rows.length > 0
}

export interface VerifiedToken {
  tokenId: string
  userId: string
  userEmail: string
  userName: string
  scopes: TokenScope[]
  /** Null means every deck the user can access. */
  deckIds: string[] | null
  expiresAt: Date
}

/**
 * Checks a presented secret. Returns the token's owner, scopes and deck allowlist, or null for anything wrong:
 * unknown, revoked, expired or malformed. The caller must not tell these apart to the client.
 */
export async function verifyApiToken(db: Db, secret: string, now = new Date()): Promise<VerifiedToken | null> {
  if (!secret.startsWith(TOKEN_PREFIX) || secret.length > 200) return null
  const [row] = await db
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      userEmail: user.email,
      userName: user.name,
      scopes: apiTokens.scopes,
      deckIds: apiTokens.deckIds,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .innerJoin(user, eq(user.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, hashSecret(secret)), isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, now)))
    .limit(1)
  if (!row) return null

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    void db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id)).catch(() => undefined)
  }
  return {
    tokenId: row.id,
    userId: row.userId,
    userEmail: row.userEmail,
    userName: row.userName,
    scopes: row.scopes as TokenScope[],
    deckIds: row.deckIds ?? null,
    expiresAt: row.expiresAt,
  }
}

/** True when the token carries the scope. */
export function tokenHasScope(token: { scopes: readonly string[] }, scope: TokenScope): boolean {
  return token.scopes.includes(scope)
}

/** True when the token's deck allowlist includes the deck (or the token has no allowlist). */
export function tokenAllowsDeck(token: { deckIds: readonly string[] | null }, deckId: string): boolean {
  return token.deckIds === null || token.deckIds.includes(deckId.toLowerCase())
}

export interface AuditEntry {
  userId: string
  tokenId: string | null
  tool: string
  deckId: string | null
  ok: boolean
  ms: number
  error?: string | null
}

/** One row per MCP tool call. Callers should not let a failure here fail the tool call. */
export async function recordMcpAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(mcpAudit).values({
    userId: entry.userId,
    tokenId: entry.tokenId,
    tool: entry.tool,
    deckId: entry.deckId,
    ok: entry.ok,
    ms: Math.max(0, Math.round(entry.ms)),
    error: entry.error ? entry.error.slice(0, 300) : null,
  })
}

/** Recent audit rows for one user, newest first. */
export async function listMcpAudit(db: Db, userId: string, limit = 50) {
  return db
    .select()
    .from(mcpAudit)
    .where(eq(mcpAudit.userId, userId))
    .orderBy(desc(mcpAudit.createdAt), desc(mcpAudit.id))
    .limit(Math.min(Math.max(limit, 1), 500))
}


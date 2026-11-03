// Phone remote: the signed token in a presenter's QR code, and the session rows that make it revocable.
//
// A token is base64url(JSON claims) "." base64url(HMAC-SHA256). The key is derived from COLLAB_TOKEN_SECRET with a
// fixed label, so a remote token is never valid as a collab token (and the other way round), even though one
// secret is configured. Claims: deck, session id (sid), the presenter's user, and an expiry 30 minutes ahead.
// Every command also checks the session row (not revoked) and the user's current role on the deck.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from './client.ts'
import { remoteSessions } from './schema/index.ts'

export const REMOTE_TOKEN_TTL_SECONDS = 30 * 60
export const REMOTE_SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/
const KEY_LABEL = 'sleid-remote-token-v1'
const MIN_SECRET_LENGTH = 32

const ClaimsSchema = z.object({
  deckId: z.uuid(),
  sid: z.string().regex(REMOTE_SESSION_ID),
  userId: z.string().min(1).max(200),
  exp: z.number().int().positive(),
})
export type RemoteClaims = z.infer<typeof ClaimsSchema>

export type RemoteTokenFailure = 'malformed' | 'bad-signature' | 'expired' | 'invalid-claims'

export class RemoteTokenError extends Error {
  readonly reason: RemoteTokenFailure
  constructor(reason: RemoteTokenFailure, message: string) {
    super(message)
    this.name = 'RemoteTokenError'
    this.reason = reason
  }
}

function keyFor(secret: string): Buffer {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`COLLAB_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  return createHmac('sha256', secret).update(KEY_LABEL).digest()
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', keyFor(secret)).update(payloadB64).digest('base64url')
}

export function signRemoteToken(claims: Omit<RemoteClaims, 'exp'> & { exp?: number }, secret: string, now: number = Date.now()): { token: string; expiresAt: number } {
  const exp = claims.exp ?? Math.floor(now / 1000) + REMOTE_TOKEN_TTL_SECONDS
  const full = ClaimsSchema.parse({ ...claims, exp })
  const payloadB64 = Buffer.from(JSON.stringify(full)).toString('base64url')
  return { token: `${payloadB64}.${sign(payloadB64, secret)}`, expiresAt: exp * 1000 }
}

/** Checks the signature, the shape and the expiry. Throws RemoteTokenError with a reason. Never returns partial claims. */
export function verifyRemoteToken(token: string, secret: string, now: number = Date.now()): RemoteClaims {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) throw new RemoteTokenError('malformed', 'token is malformed')
  const payloadB64 = token.slice(0, dot)
  const expected = Buffer.from(sign(payloadB64, secret))
  const actual = Buffer.from(token.slice(dot + 1))
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new RemoteTokenError('bad-signature', 'token signature does not match')

  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    throw new RemoteTokenError('malformed', 'token payload is not JSON')
  }
  const parsed = ClaimsSchema.safeParse(raw)
  if (!parsed.success) throw new RemoteTokenError('invalid-claims', 'token claims are invalid')
  if (parsed.data.exp <= Math.floor(now / 1000)) throw new RemoteTokenError('expired', 'token has expired')
  return parsed.data
}

/**
 * Creates the session row, or re-uses it for the same presenter. Refuses a session that was revoked, or that
 * belongs to another user or deck, so a session id cannot be taken over.
 */
export async function issueRemoteSession(db: Db, input: { id: string; deckId: string; userId: string; now?: Date }): Promise<'created' | 'reused'> {
  const inserted = await db
    .insert(remoteSessions)
    .values({ id: input.id, deckId: input.deckId, userId: input.userId, createdAt: input.now ?? new Date() })
    .onConflictDoNothing({ target: remoteSessions.id })
    .returning({ id: remoteSessions.id })
  if (inserted.length > 0) return 'created'
  const [row] = await db.select().from(remoteSessions).where(eq(remoteSessions.id, input.id)).limit(1)
  if (!row || row.deckId !== input.deckId || row.userId !== input.userId) throw new Error('Session not found')
  if (row.revokedAt) throw new Error('This remote was closed. Open the presenter view again to start a new one.')
  return 'reused'
}

/** Revokes a session the user owns. Returns false when there was nothing to revoke. */
export async function revokeRemoteSession(db: Db, input: { id: string; deckId: string; userId: string; now?: Date }): Promise<boolean> {
  const rows = await db
    .update(remoteSessions)
    .set({ revokedAt: input.now ?? new Date() })
    .where(and(eq(remoteSessions.id, input.id), eq(remoteSessions.deckId, input.deckId), eq(remoteSessions.userId, input.userId), isNull(remoteSessions.revokedAt)))
    .returning({ id: remoteSessions.id })
  return rows.length > 0
}

/** The session row, or null. Revoked sessions are returned too: the caller decides. */
export async function getRemoteSession(db: Db, id: string) {
  const [row] = await db.select().from(remoteSessions).where(eq(remoteSessions.id, id)).limit(1)
  return row ?? null
}

/** Deletes session rows created before `before`. A remote token lasts 30 minutes, so older rows can never be used. */
export async function pruneRemoteSessions(db: Db, before: Date): Promise<number> {
  const rows = await db.delete(remoteSessions).where(lt(remoteSessions.createdAt, before)).returning({ id: remoteSessions.id })
  return rows.length
}

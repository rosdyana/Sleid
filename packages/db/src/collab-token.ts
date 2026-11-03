// Short-lived collab tokens. apps/web signs one per deck after a session and role
// check; apps/collab verifies it in onAuthenticate. Format:
//   base64url(JSON claims) "." base64url(HMAC-SHA256(secret, base64url(JSON claims)))
// Claims: { userId, deckId, role, name, image, exp } with exp in epoch seconds.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { DECK_ROLES, type DeckRole } from './permissions.ts'

export const COLLAB_TOKEN_TTL_SECONDS = 5 * 60
const MIN_SECRET_LENGTH = 32

const ClaimsSchema = z.object({
  userId: z.string().min(1),
  deckId: z.uuid(),
  role: z.enum(DECK_ROLES),
  name: z.string().max(200),
  image: z.string().max(2048).nullable(),
  exp: z.number().int().positive(),
})

export type CollabClaims = z.infer<typeof ClaimsSchema> & { role: DeckRole }

export type CollabTokenFailure = 'malformed' | 'bad-signature' | 'expired' | 'wrong-deck' | 'invalid-claims'

export class CollabTokenError extends Error {
  readonly reason: CollabTokenFailure
  constructor(reason: CollabTokenFailure, message: string) {
    super(message)
    this.name = 'CollabTokenError'
    this.reason = reason
  }
}

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`COLLAB_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url')
}

export function signCollabToken(claims: Omit<CollabClaims, 'exp'> & { exp?: number }, secret: string, now: number = Date.now()): string {
  assertSecret(secret)
  const full = ClaimsSchema.parse({ ...claims, exp: claims.exp ?? Math.floor(now / 1000) + COLLAB_TOKEN_TTL_SECONDS })
  const payloadB64 = Buffer.from(JSON.stringify(full)).toString('base64url')
  return `${payloadB64}.${sign(payloadB64, secret)}`
}

/**
 * Checks signature, expiry and (when given) the deck the token must be for.
 * Throws CollabTokenError with a reason; never returns partially-valid claims.
 */
export function verifyCollabToken(
  token: string,
  secret: string,
  options: { deckId?: string; now?: number } = {},
): CollabClaims {
  assertSecret(secret)
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    throw new CollabTokenError('malformed', 'token is malformed')
  }
  const payloadB64 = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  const expected = Buffer.from(sign(payloadB64, secret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new CollabTokenError('bad-signature', 'token signature does not match')
  }

  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    throw new CollabTokenError('malformed', 'token payload is not JSON')
  }
  const parsed = ClaimsSchema.safeParse(raw)
  if (!parsed.success) throw new CollabTokenError('invalid-claims', 'token claims are invalid')

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  if (parsed.data.exp <= nowSeconds) throw new CollabTokenError('expired', 'token has expired')
  if (options.deckId !== undefined && parsed.data.deckId !== options.deckId) {
    throw new CollabTokenError('wrong-deck', 'token is for a different deck')
  }
  return parsed.data as CollabClaims
}

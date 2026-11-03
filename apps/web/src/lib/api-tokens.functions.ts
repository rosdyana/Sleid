// Server functions for the personal access token settings page. The secret is returned once, by createApiTokenFn.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { createApiToken, listApiTokens, revokeApiToken, TOKEN_SCOPES, MAX_TOKEN_DAYS, getDeckRole, type TokenRecord } from '@sleid/db'
import { requireUser } from '~/lib/session.server'

const CreateTokenInput = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(MAX_TOKEN_DAYS),
  /** Null for every deck the user can access. */
  deckIds: z.array(z.uuid()).min(1).max(500).nullable(),
})

function serialize(token: TokenRecord) {
  const now = Date.now()
  const status = token.revokedAt ? 'revoked' : token.expiresAt.getTime() <= now ? 'expired' : 'active'
  return {
    id: token.id,
    name: token.name,
    hint: token.hint,
    scopes: token.scopes,
    deckIds: token.deckIds,
    expiresAt: token.expiresAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
    status,
  }
}

export const listApiTokensFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  const tokens = await listApiTokens(db, user.id)
  return { tokens: tokens.map(serialize) }
})

/** Creates a token. The response carries the secret, which is not stored and cannot be shown again. */
export const createApiTokenFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => CreateTokenInput.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    if (data.deckIds) {
      // A token can only be limited to decks the user can reach now. Other ids are reported the same as missing ones.
      for (const deckId of data.deckIds) {
        if (!(await getDeckRole(db, user.id, deckId))) throw new Error('Deck not found. Pick decks you can open.')
      }
    }
    const { secret, token } = await createApiToken(db, {
      userId: user.id,
      name: data.name,
      scopes: data.scopes,
      deckIds: data.deckIds,
      expiresInDays: data.expiresInDays,
    })
    return { secret, token: serialize(token) }
  })

export const revokeApiTokenFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ id: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    if (!(await revokeApiToken(db, user.id, data.id))) throw new Error('That token was not found, or it is already revoked.')
    return { ok: true as const }
  })

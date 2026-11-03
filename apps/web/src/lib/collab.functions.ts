import { createServerFn } from '@tanstack/react-start'
import { COLLAB_TOKEN_TTL_SECONDS, signCollabToken } from '@sleid/db'
import { z } from 'zod'
import { requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'

/**
 * A short-lived collab token for one deck, signed with COLLAB_TOKEN_SECRET. Issued after
 * a session and role check. The provider asks for a new one on every (re)connect.
 */
export const getCollabTokenFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ deckId: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await requireDeckRole(user.id, data.deckId, 'viewer')
    const secret = process.env.COLLAB_TOKEN_SECRET
    if (!secret) throw new Error('COLLAB_TOKEN_SECRET is required (see .env.example)')
    const token = signCollabToken(
      { userId: user.id, deckId: data.deckId, role, name: user.name.slice(0, 200), image: user.image },
      secret,
    )
    return { token, expiresAt: Date.now() + COLLAB_TOKEN_TTL_SECONDS * 1000 }
  })

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { REMOTE_SESSION_ID, REMOTE_TOKEN_TTL_SECONDS, issueRemoteSession, revokeRemoteSession, signRemoteToken } from '@sleid/db'
import { getCollabInternalClient } from '~/lib/collab-client.server'
import { requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'

const sessionInput = z.object({ deckId: z.uuid(), sid: z.string().regex(REMOTE_SESSION_ID) })

/**
 * A phone-remote token for this presenter session, for the QR code. Anyone who can present (viewers and up)
 * may create one for their own session. The token lasts 30 minutes; the session row can be revoked earlier.
 */
export const createRemoteSessionFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => sessionInput.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    const secret = process.env.COLLAB_TOKEN_SECRET
    if (!secret) throw new Error('COLLAB_TOKEN_SECRET is required (see .env.example)')
    await issueRemoteSession(db, { id: data.sid, deckId: data.deckId, userId: user.id })
    const { token, expiresAt } = signRemoteToken({ deckId: data.deckId, sid: data.sid, userId: user.id }, secret)
    return { token, expiresAt, path: `/r/${token}`, ttlSeconds: REMOTE_TOKEN_TTL_SECONDS }
  })

/** Closes the remote: the token stops working at once, and the phone is told. Only the presenter who opened it. */
export const closeRemoteSessionFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => sessionInput.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    const closed = await revokeRemoteSession(db, { id: data.sid, deckId: data.deckId, userId: user.id })
    if (closed) {
      try {
        await getCollabInternalClient().broadcast(data.deckId, { channel: `remote:${data.sid}`, type: 'closed' })
      } catch (err) {
        console.warn('[remote] the phone was not told the remote closed', err)
      }
    }
    return { closed }
  })

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { copyDeck, loadDeckState } from '@sleid/db'
import { bytesToBase64 } from '~/lib/base64'
import { requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'

const deckIdSchema = z.object({ deckId: z.uuid() })

/**
 * Full Yjs state of a deck, base64 encoded. Viewers and up. Used by the present
 * route, which reads the persisted state (the last ~2 seconds of live edits may be missing).
 * The editor does not use this: it syncs through the collab service.
 */
export const getDeckStateFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    return { state: bytesToBase64(await loadDeckState(db, data.deckId)) }
  })

/** New deck with a copy of this deck's state. Viewers and up may copy. */
export const copyDeckFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    return copyDeck(db, user.id, data.deckId)
  })

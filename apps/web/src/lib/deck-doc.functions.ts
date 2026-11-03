import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { copyDeck, readDeck } from '@sleid/db'
import { liveDeckSourceFromEnv } from '~/lib/collab-client.server'
import { requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'

const deckIdSchema = z.object({ deckId: z.uuid() })

/** New deck with a copy of this deck's state. Viewers and up may copy. */
export const copyDeckFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    return copyDeck(db, user.id, data.deckId)
  })

/**
 * The deck as JSON for a presentation. Live from the collab service when it is up, so the audience window and the
 * presenter view start with the latest edits and a restored version; the saved state otherwise. Viewers and up.
 */
export const getPresentDeckFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    const { deck } = await readDeck(db, data.deckId, {
      live: liveDeckSourceFromEnv(),
      onFallback: (reason) => console.warn('[present] collab service unavailable; presenting the saved deck', reason),
    })
    return { deckJson: JSON.stringify(deck) }
  })

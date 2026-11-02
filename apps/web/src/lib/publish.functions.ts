import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { canEdit, findPublishedDeck, getPublishState, readDeck, setPublished } from '@sleid/db'
import { liveDeckSourceFromEnv } from '~/lib/collab-client.server'
import { requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'

/** Publish state for the share dialog. Only editors and owners see it; viewers get canManage false. */
export const getPublishStateFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ deckId: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canEdit(role)) return { canManage: false as const, state: null }
    const state = await getPublishState(db, data.deckId)
    return {
      canManage: true as const,
      state: state ? { published: state.published, token: state.token, indexable: state.indexable } : null,
    }
  })

/** Turns "publish to web" on or off, and sets whether search engines may index the page. Editors and owners. */
export const setPublishedFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z.object({ deckId: z.uuid(), published: z.boolean(), indexable: z.boolean().optional() }).parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canEdit(role)) throw new Error('You need editor access to publish this deck')
    const state = await setPublished(db, data.deckId, { published: data.published, indexable: data.indexable })
    return { published: state.published, token: state.token, indexable: state.indexable }
  })

/**
 * The deck behind a public link. No sign-in. Unknown, unpublished and deleted decks all come back as found: false,
 * so the page cannot be used to probe for deck ids.
 */
export const getPublishedDeckFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ token: z.string().min(16).max(128) }).parse(data))
  .handler(async ({ data }) => {
    const published = await findPublishedDeck(db, data.token)
    if (!published) return { found: false as const }
    const { deck } = await readDeck(db, published.deckId, {
      live: liveDeckSourceFromEnv(),
      onFallback: (reason) => console.warn('[publish] collab unavailable; reading the saved deck', reason),
    })
    // Sent as JSON text: the deck's rich text is not a serialisable type for the router.
    return { found: true as const, deckJson: JSON.stringify(deck), indexable: published.indexable }
  })

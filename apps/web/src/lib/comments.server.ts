// Server helpers for comments that need the app database or the collab client from the environment: the current deck
// (live when the collab service is up) and the broadcast after a web write.
import type { Deck } from '@sleid/model'
import { readDeck } from '@sleid/db'
import { db } from '~/db/client'
import { getCollabInternalClient, liveDeckSourceFromEnv } from '~/lib/collab-client.server'
import { announceThreadChange } from '~/lib/comment-placement'

export { anchorFor } from '~/lib/comment-placement'

/** Tells everyone with the deck open that a thread changed. Best effort. */
export async function broadcastCommentChange(deckId: string, threadId: string): Promise<void> {
  let collab
  try {
    collab = getCollabInternalClient()
  } catch (err) {
    console.warn('[comments] the live update was not sent (collab is not configured)', err)
    return
  }
  await announceThreadChange(collab, deckId, threadId)
}

/** The current deck, live when the collab service is up, otherwise the saved state. */
export async function currentDeck(deckId: string): Promise<Deck> {
  const { deck } = await readDeck(db, deckId, {
    live: liveDeckSourceFromEnv(),
    onFallback: (reason) => console.warn('[comments] collab service unavailable; reading the saved deck', reason),
  })
  return deck
}

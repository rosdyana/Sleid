import * as Y from 'yjs'
import { yDocToDeck, type Deck } from '@sleid/model'
import type { Db } from './client.ts'
import { loadDeckState } from './deck-doc.ts'

/** Where the live document is served from: the collab service's internal API. */
export interface LiveDeckSource {
  baseUrl: string
  secret: string
  fetch?: typeof fetch
}

/** The live deck from the collab service. Throws when the service is down or does not have the deck. */
export async function readLiveDeck(live: LiveDeckSource, deckId: string): Promise<Deck> {
  const doFetch = live.fetch ?? fetch
  const response = await doFetch(`${live.baseUrl.replace(/\/$/, '')}/internal/decks/${encodeURIComponent(deckId)}/json`, {
    headers: { 'x-sleid-internal': live.secret },
  })
  if (!response.ok) throw new Error(`collab internal API answered ${response.status}`)
  return (await response.json()) as Deck
}

/**
 * The current deck. Reads the live document from the collab service when it is reachable,
 * and falls back to the persisted state in Postgres otherwise (which can miss the last ~2 seconds of edits).
 * The caller must already have checked the deck role.
 */
export async function readDeck(
  db: Db,
  deckId: string,
  options: { live?: LiveDeckSource; onFallback?: (reason: unknown) => void } = {},
): Promise<{ deck: Deck; source: 'live' | 'database' }> {
  if (options.live) {
    try {
      return { deck: await readLiveDeck(options.live, deckId), source: 'live' }
    } catch (err) {
      options.onFallback?.(err)
    }
  }
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await loadDeckState(db, deckId))
  return { deck: yDocToDeck(doc), source: 'database' }
}

// Where a new comment thread sits, and how the collaborators learn that a thread changed. No database access here,
// so the MCP tools and the web server functions use the same rules, and tests can run without the web server.
import type { Deck } from '@sleid/model'
import type { CommentAnchor } from '@sleid/db'
import type { CollabInternalClient } from '~/lib/collab-client.server'

/**
 * A new thread must sit on a slide that exists, and on an element of that slide when it names one. Without an
 * anchor, the thread is pinned to the middle of the slide. For an element, the pin goes to its top-right corner.
 */
export function anchorFor(deck: Deck, slideId: string, elementId: string | null, anchor: CommentAnchor | null | undefined): { anchor: CommentAnchor; elementId: string | null } {
  const slide = deck.slides.find((s) => s.id === slideId)
  if (!slide) throw new Error('That slide is not in this deck.')
  if (elementId) {
    const element = slide.elements.find((e) => e.id === elementId)
    if (!element) throw new Error('That element is not on this slide.')
    return { elementId, anchor: anchor ?? { x: Math.min(1920, element.x + element.w), y: Math.max(0, element.y) } }
  }
  return { elementId: null, anchor: anchor ?? { x: 960, y: 540 } }
}

/** Tells everyone with the deck open that a thread changed. They fetch that thread again. Best effort. */
export async function announceThreadChange(collab: Pick<CollabInternalClient, 'broadcast'>, deckId: string, threadId: string): Promise<void> {
  try {
    await collab.broadcast(deckId, { channel: 'comments', type: 'comments', threadId })
  } catch (err) {
    console.warn('[comments] the live update was not sent; collaborators see the comment on their next reload', err)
  }
}

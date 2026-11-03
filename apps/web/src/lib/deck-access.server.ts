// Server-side role checks bound to this app's database handle. The rules live in @sleid/db.
import { db } from '~/db/client'
import { getDeckRole as getRoleFor, requireDeckRole as requireRoleFor, type DeckRole } from '@sleid/db'

/** The caller's role on a non-deleted deck, or null when they are not a member. */
export function getDeckRole(userId: string, deckId: string): Promise<DeckRole | null> {
  return getRoleFor(db, userId, deckId)
}

/** Throws "Deck not found" unless the user is a member with at least `minRole`. */
export function requireDeckRole(userId: string, deckId: string, minRole: DeckRole): Promise<DeckRole> {
  return requireRoleFor(db, userId, deckId, minRole)
}

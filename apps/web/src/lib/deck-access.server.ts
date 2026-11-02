import { and, eq, isNull } from 'drizzle-orm'
import { db } from '~/db/client'
import { decks, deckMembers } from '~/db/schema'
import { type DeckRole, roleAtLeast } from '~/lib/permissions'

/** The caller's role on a non-deleted deck, or null when they are not a member. */
export async function getDeckRole(userId: string, deckId: string): Promise<DeckRole | null> {
  const [row] = await db
    .select({ role: deckMembers.role })
    .from(deckMembers)
    .innerJoin(decks, eq(decks.id, deckMembers.deckId))
    .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId), isNull(decks.deletedAt)))
    .limit(1)
  return row?.role ?? null
}

/**
 * Throws unless the user is a member with at least `minRole`.
 * Missing and forbidden decks give the same error so deck ids cannot be probed.
 */
export async function requireDeckRole(userId: string, deckId: string, minRole: DeckRole): Promise<DeckRole> {
  const role = await getDeckRole(userId, deckId)
  if (!role || !roleAtLeast(role, minRole)) throw new Error('Deck not found')
  return role
}

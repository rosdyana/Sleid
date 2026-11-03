import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from './client.ts'
import { decks, deckMembers, shareLinks } from './schema/index.ts'
import { type DeckRole, roleAtLeast } from './permissions.ts'

/**
 * The caller's role on a non-deleted deck, or null when they are not a member. A membership that came through a
 * share link counts only while that link is active (not revoked, not expired), so restricting a link ends access
 * at the next check, with no separate cleanup needed.
 */
export async function getDeckRole(db: Db, userId: string, deckId: string): Promise<DeckRole | null> {
  const [row] = await db
    .select({
      role: deckMembers.role,
      via: deckMembers.via,
      linkId: shareLinks.id,
      linkRevokedAt: shareLinks.revokedAt,
      linkExpiresAt: shareLinks.expiresAt,
    })
    .from(deckMembers)
    .innerJoin(decks, eq(decks.id, deckMembers.deckId))
    .leftJoin(shareLinks, eq(shareLinks.id, deckMembers.shareLinkId))
    .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId), isNull(decks.deletedAt)))
    .limit(1)
  if (!row) return null
  if (row.via === 'link') {
    const live = row.linkId !== null && row.linkRevokedAt === null && (row.linkExpiresAt === null || row.linkExpiresAt > new Date())
    if (!live) return null
  }
  return row.role
}

/**
 * Throws unless the user is a member with at least `minRole`.
 * Missing and forbidden decks give the same error so deck ids cannot be probed.
 */
export async function requireDeckRole(db: Db, userId: string, deckId: string, minRole: DeckRole): Promise<DeckRole> {
  const role = await getDeckRole(db, userId, deckId)
  if (!role || !roleAtLeast(role, minRole)) throw new Error('Deck not found')
  return role
}

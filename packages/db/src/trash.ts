import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { Db } from './client.ts'
import { assets, decks, deckMembers, exportJobs } from './schema/index.ts'

/**
 * Only the owner (a member with role 'owner') may trash, restore or delete a deck. This reads membership directly, not
 * through getDeckRole, because getDeckRole hides deleted decks and restore has to find them.
 */
async function isOwner(db: Db, userId: string, deckId: string): Promise<boolean> {
  const [row] = await db
    .select({ deckId: deckMembers.deckId })
    .from(deckMembers)
    .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId), eq(deckMembers.role, 'owner')))
    .limit(1)
  return row !== undefined
}

/** Soft delete: sets deletedAt. Returns false when the caller is not the owner or the deck is already in the trash. */
export async function trashDeck(db: Db, userId: string, deckId: string): Promise<boolean> {
  if (!(await isOwner(db, userId, deckId))) return false
  const rows = await db
    .update(decks)
    .set({ deletedAt: new Date() })
    .where(and(eq(decks.id, deckId), isNull(decks.deletedAt)))
    .returning({ id: decks.id })
  return rows.length > 0
}

/** Undoes trashDeck. Returns false when the caller is not the owner or the deck is not in the trash. */
export async function restoreDeck(db: Db, userId: string, deckId: string): Promise<boolean> {
  if (!(await isOwner(db, userId, deckId))) return false
  const rows = await db
    .update(decks)
    .set({ deletedAt: null })
    .where(and(eq(decks.id, deckId), isNotNull(decks.deletedAt)))
    .returning({ id: decks.id })
  return rows.length > 0
}

/** The decks the user owns that are in the trash, newest deletion first. */
export async function listTrashedDecks(db: Db, userId: string): Promise<Array<{ id: string; title: string; deletedAt: Date }>> {
  const rows = await db
    .select({ id: decks.id, title: decks.title, deletedAt: decks.deletedAt })
    .from(deckMembers)
    .innerJoin(decks, eq(decks.id, deckMembers.deckId))
    .where(and(eq(deckMembers.userId, userId), eq(deckMembers.role, 'owner'), isNotNull(decks.deletedAt)))
    .orderBy(desc(decks.deletedAt))
    .limit(200)
  return rows.flatMap((r) => (r.deletedAt ? [{ id: r.id, title: r.title, deletedAt: r.deletedAt }] : []))
}

/**
 * Permanent delete. Owner only, and only for a deck already in the trash. The deck row goes in one transaction; its
 * members, comments, snapshots, updates, share links, invites, exports, asset rows and remote sessions cascade with it.
 * Wizard runs and import jobs keep their rows with deckId cleared (set null). The caller removes the returned asset
 * files from storage, since the database cannot reach them.
 */
export type PurgeResult =
  | { ok: true; assetIds: string[]; exportKeys: string[] }
  | { ok: false; reason: 'not-owner' | 'not-in-trash'; assetIds: []; exportKeys: [] }

/** Deletes a trashed deck for good. Returns the stored files (asset ids, export file keys) the caller must remove. */
export async function purgeDeck(db: Db, userId: string, deckId: string): Promise<PurgeResult> {
  if (!(await isOwner(db, userId, deckId))) return { ok: false, reason: 'not-owner', assetIds: [], exportKeys: [] }
  return db.transaction(async (tx) => {
    // Locks the row so an upload cannot add an asset between the read and the delete.
    const [deck] = await tx
      .select({ id: decks.id })
      .from(decks)
      .where(and(eq(decks.id, deckId), isNotNull(decks.deletedAt)))
      .limit(1)
      .for('update')
    if (!deck) return { ok: false as const, reason: 'not-in-trash' as const, assetIds: [] as [], exportKeys: [] as [] }
    const rows = await tx.select({ id: assets.id }).from(assets).where(eq(assets.deckId, deckId))
    // Finished export files live in export storage, not in assets. Their rows cascade, the files do not.
    const exportRows = await tx.select({ key: exportJobs.fileKey }).from(exportJobs).where(and(eq(exportJobs.deckId, deckId), isNotNull(exportJobs.fileKey)))
    await tx.delete(decks).where(eq(decks.id, deckId))
    return { ok: true as const, assetIds: rows.map((r) => r.id), exportKeys: exportRows.flatMap((r) => (r.key ? [r.key] : [])) }
  })
}

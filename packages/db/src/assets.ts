import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from './client.ts'
import { assets, decks } from './schema/index.ts'

export interface AssetRow {
  id: string
  deckId: string
  ownerId: string
  mime: string
  bytes: number
  sha256: string
  /** Set when the deck is published (anonymous readers may fetch the asset). */
  publishedToken: string | null
}

export async function insertAsset(
  db: Db,
  input: { id: string; deckId: string; ownerId: string; mime: string; bytes: number; sha256: string },
): Promise<void> {
  await db.insert(assets).values(input)
}

/** An asset with its deck's publish token, for non-deleted decks only. */
export async function getAssetWithDeck(db: Db, assetId: string): Promise<AssetRow | null> {
  const [row] = await db
    .select({
      id: assets.id,
      deckId: assets.deckId,
      ownerId: assets.ownerId,
      mime: assets.mime,
      bytes: assets.bytes,
      sha256: assets.sha256,
      publishedToken: decks.publishedToken,
    })
    .from(assets)
    .innerJoin(decks, eq(decks.id, assets.deckId))
    .where(and(eq(assets.id, assetId), isNull(decks.deletedAt)))
    .limit(1)
  return row ?? null
}

export async function deleteAssetRow(db: Db, assetId: string): Promise<void> {
  await db.delete(assets).where(eq(assets.id, assetId))
}

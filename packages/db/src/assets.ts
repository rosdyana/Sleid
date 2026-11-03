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
  /** Pixel size when known (M11). */
  width: number | null
  height: number | null
}

/** The images stored on one deck, oldest first (M11 MCP tools). The caller must have checked the deck. */
export async function listDeckAssets(db: Db, deckId: string): Promise<Array<{ id: string; mime: string; bytes: number; width: number | null; height: number | null }>> {
  return db
    .select({ id: assets.id, mime: assets.mime, bytes: assets.bytes, width: assets.width, height: assets.height })
    .from(assets)
    .where(eq(assets.deckId, deckId))
    .orderBy(assets.id)
}

export async function insertAsset(
  db: Db,
  input: {
    id: string
    deckId: string
    ownerId: string
    mime: string
    bytes: number
    sha256: string
    width?: number | null
    height?: number | null
  },
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
      width: assets.width,
      height: assets.height,
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

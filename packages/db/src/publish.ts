import { randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from './client.ts'
import { decks } from './schema/index.ts'

export interface PublishState {
  published: boolean
  token: string | null
  publishedAt: Date | null
  indexable: boolean
}

export async function getPublishState(db: Db, deckId: string): Promise<PublishState | null> {
  const [row] = await db
    .select({ token: decks.publishedToken, publishedAt: decks.publishedAt, indexable: decks.publishedIndexable })
    .from(decks)
    .where(and(eq(decks.id, deckId), isNull(decks.deletedAt)))
    .limit(1)
  if (!row) return null
  return { published: row.token !== null, token: row.token, publishedAt: row.publishedAt, indexable: row.indexable }
}

/**
 * Turns "publish to web" on or off. Publishing while already published keeps the token.
 * Unpublishing clears it, so turning publish back on issues a new link. The caller must already
 * have checked editor access.
 */
export async function setPublished(db: Db, deckId: string, input: { published: boolean; indexable?: boolean }): Promise<PublishState> {
  const current = await getPublishState(db, deckId)
  if (!current) throw new Error('Deck not found')
  const indexable = input.indexable ?? current.indexable
  if (input.published) {
    const token = current.token ?? randomBytes(24).toString('base64url')
    const publishedAt = current.publishedAt ?? new Date()
    await db
      .update(decks)
      .set({ publishedToken: token, publishedAt, publishedIndexable: indexable })
      .where(eq(decks.id, deckId))
  } else {
    await db
      .update(decks)
      .set({ publishedToken: null, publishedAt: null, publishedIndexable: indexable })
      .where(eq(decks.id, deckId))
  }
  return (await getPublishState(db, deckId))!
}

/** The deck behind a publish token, or null when the token is unknown, unpublished or the deck is deleted. */
export async function findPublishedDeck(db: Db, token: string): Promise<{ deckId: string; indexable: boolean } | null> {
  if (token.length < 16 || token.length > 128) return null
  const [row] = await db
    .select({ id: decks.id, indexable: decks.publishedIndexable })
    .from(decks)
    .where(and(eq(decks.publishedToken, token), isNull(decks.deletedAt)))
    .limit(1)
  return row ? { deckId: row.id, indexable: row.indexable } : null
}

// Test helpers for suites that run against a real Postgres (compose: 127.0.0.1:5433).
// Not part of the package's public index. Import it as @sleid/db/testing.
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createDb, type Db } from './client.ts'
import { decks, deckMembers, user } from './schema/index.ts'

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sleid:sleid@127.0.0.1:5433/sleid'

/** A connected db handle, or null when Postgres is not reachable (callers then skip). */
export async function connectOrNull(url: string = TEST_DATABASE_URL): Promise<Db | null> {
  const db = createDb(url, { max: 3 })
  try {
    await db.execute(sql`select 1`)
    return db
  } catch (err) {
    console.warn(`[@sleid/db tests] skipped: database not reachable (${err instanceof Error ? err.message : String(err)})`)
    await db.$client.end({ timeout: 1 })
    return null
  }
}

export async function makeUser(db: Db, label: string): Promise<{ id: string; email: string; name: string }> {
  const id = `test-${label}-${randomUUID()}`
  const email = `${id}@example.com`
  await db.insert(user).values({ id, name: label, email })
  return { id, email, name: label }
}

/** A deck with `ownerId` as its owner member. Returns the deck id. */
export async function makeDeck(db: Db, ownerId: string, title = 'Test deck'): Promise<string> {
  const [deck] = await db.insert(decks).values({ ownerId, title }).returning({ id: decks.id })
  if (!deck) throw new Error('could not create test deck')
  await db.insert(deckMembers).values({ deckId: deck.id, userId: ownerId, role: 'owner', via: 'owner' })
  return deck.id
}

/** Deletes users (and, through cascades, their decks, memberships and updates). */
export async function removeUsers(db: Db, ids: string[]): Promise<void> {
  for (const id of ids) await db.delete(user).where(sql`${user.id} = ${id}`)
}

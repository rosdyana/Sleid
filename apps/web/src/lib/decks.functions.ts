import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/db/client'
import { decks, deckMembers, setStarred } from '@sleid/db'
import { getDeckRole, requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'

const deckIdSchema = z.object({ deckId: z.uuid() })
const starSchema = z.object({ deckId: z.uuid(), starred: z.boolean() })

/** Decks the caller is a member of, with their role and their own star. Owners and shared decks alike. */
export const listRecentDecksFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  const rows = await db
    .select({
      id: decks.id,
      title: decks.title,
      starred: deckMembers.starred,
      updatedAt: decks.updatedAt,
      role: deckMembers.role,
    })
    .from(deckMembers)
    .innerJoin(decks, eq(decks.id, deckMembers.deckId))
    .where(and(eq(deckMembers.userId, user.id), isNull(decks.deletedAt)))
    .orderBy(desc(decks.updatedAt))
    .limit(100)
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))
})

export const createBlankDeckFn = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser()
  const id = await db.transaction(async (tx) => {
    const [deck] = await tx.insert(decks).values({ ownerId: user.id }).returning({ id: decks.id })
    if (!deck) throw new Error('Failed to create deck')
    await tx.insert(deckMembers).values({ deckId: deck.id, userId: user.id, role: 'owner' })
    return deck.id
  })
  return { id }
})

/** The deck's metadata for the caller, or null when they are not a member. The document itself loads over the collab socket. */
export const getDeckFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await getDeckRole(user.id, data.deckId)
    if (!role) return null
    const [row] = await db
      .select({ id: decks.id, title: decks.title, starred: deckMembers.starred })
      .from(decks)
      .innerJoin(deckMembers, and(eq(deckMembers.deckId, decks.id), eq(deckMembers.userId, user.id)))
      .where(and(eq(decks.id, data.deckId), isNull(decks.deletedAt)))
      .limit(1)
    if (!row) return null
    return { ...row, role }
  })

/** Stars or unstars a deck for the caller only. Viewers and up. */
export const setStarredFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => starSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    await setStarred(db, user.id, data.deckId, data.starred)
    return { ok: true as const }
  })

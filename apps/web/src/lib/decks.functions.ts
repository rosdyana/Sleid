import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/db/client'
import { decks, deckMembers } from '~/db/schema'
import { getDeckRole, requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'

const deckIdSchema = z.object({ deckId: z.uuid() })
const updateDeckSchema = z.object({
  deckId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  starred: z.boolean().optional(),
})

export const listRecentDecksFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  const rows = await db
    .select({
      id: decks.id,
      title: decks.title,
      starred: decks.starred,
      updatedAt: decks.updatedAt,
      role: deckMembers.role,
    })
    .from(deckMembers)
    .innerJoin(decks, eq(decks.id, deckMembers.deckId))
    .where(and(eq(deckMembers.userId, user.id), isNull(decks.deletedAt)))
    .orderBy(desc(decks.updatedAt))
    .limit(50)
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

export const getDeckFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await getDeckRole(user.id, data.deckId)
    if (!role) return null
    const [deck] = await db
      .select({ id: decks.id, title: decks.title, starred: decks.starred })
      .from(decks)
      .where(and(eq(decks.id, data.deckId), isNull(decks.deletedAt)))
      .limit(1)
    if (!deck) return null
    return { ...deck, role }
  })

export const updateDeckFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => updateDeckSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'editor')
    const patch: { title?: string; starred?: boolean; updatedAt: Date } = { updatedAt: new Date() }
    if (data.title !== undefined) patch.title = data.title
    if (data.starred !== undefined) patch.starred = data.starred
    await db.update(decks).set(patch).where(eq(decks.id, data.deckId))
    return { ok: true as const }
  })

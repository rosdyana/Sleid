// Membership, invites, general access ("share links") and per-user stars.
// Every grant goes through grantMembership, which never lowers an existing role.
import { randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { Db } from './client.ts'
import type { DeckRole, ShareRole } from './permissions.ts'
import { decks, deckMembers, invites, shareLinks, user } from './schema/index.ts'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Numeric rank of a role, as SQL. Matches RANK in permissions.ts. */
function rankSql(expr: ReturnType<typeof sql>) {
  return sql`(case ${expr} when 'viewer' then 1 when 'commenter' then 2 when 'editor' then 3 when 'owner' then 4 else 0 end)`
}

/**
 * Adds a membership, or raises the existing one to `role`. Atomic (ON CONFLICT),
 * so two concurrent grants cannot downgrade each other. Returns the resulting role.
 */
export async function grantMembership(tx: Tx, deckId: string, userId: string, role: DeckRole): Promise<DeckRole> {
  await tx
    .insert(deckMembers)
    .values({ deckId, userId, role })
    .onConflictDoUpdate({
      target: [deckMembers.deckId, deckMembers.userId],
      set: {
        role: sql`case when ${rankSql(sql`excluded.role`)} > ${rankSql(sql`${deckMembers.role}`)} then excluded.role else ${deckMembers.role} end`,
      },
    })
  const [row] = await tx
    .select({ role: deckMembers.role })
    .from(deckMembers)
    .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId)))
    .limit(1)
  if (!row) throw new Error('membership missing after grant')
  return row.role
}

/** Turns every pending invite for this email into a membership. Called on session load. Returns how many were accepted. */
export async function acceptPendingInvites(db: Db, userId: string, email: string): Promise<number> {
  const normalized = email.trim().toLowerCase()
  return db.transaction(async (tx) => {
    const pending = await tx
      .select({ id: invites.id, deckId: invites.deckId, role: invites.role })
      .from(invites)
      .where(and(eq(invites.email, normalized), isNull(invites.acceptedAt)))
    for (const invite of pending) {
      await grantMembership(tx, invite.deckId, userId, invite.role)
      await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id))
    }
    return pending.length
  })
}

/**
 * Invites an email to a deck. If an account with that email already exists it is
 * added at once; otherwise the invite waits for that email to sign in.
 */
export async function createInvite(
  db: Db,
  input: { deckId: string; invitedBy: string; email: string; role: ShareRole },
): Promise<{ accepted: boolean }> {
  const email = input.email.trim().toLowerCase()
  return db.transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.deckId, input.deckId), eq(invites.email, email), isNull(invites.acceptedAt)))
      .limit(1)
    if (pending) {
      await tx.update(invites).set({ role: input.role, invitedBy: input.invitedBy }).where(eq(invites.id, pending.id))
    } else {
      await tx.insert(invites).values({ deckId: input.deckId, email, role: input.role, invitedBy: input.invitedBy })
    }

    const [account] = await tx
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${email}`)
      .limit(1)
    if (!account) return { accepted: false }
    await grantMembership(tx, input.deckId, account.id, input.role)
    await tx.update(invites).set({ acceptedAt: new Date() }).where(and(eq(invites.deckId, input.deckId), eq(invites.email, email), isNull(invites.acceptedAt)))
    return { accepted: true }
  })
}

export async function deleteInvite(db: Db, deckId: string, inviteId: string): Promise<boolean> {
  const removed = await db
    .delete(invites)
    .where(and(eq(invites.id, inviteId), eq(invites.deckId, deckId), isNull(invites.acceptedAt)))
    .returning({ id: invites.id })
  return removed.length > 0
}

export interface PersonRow {
  userId: string
  name: string
  email: string
  image: string | null
  role: DeckRole
}

export interface PendingInviteRow {
  id: string
  email: string
  role: ShareRole
}

export async function listPeople(db: Db, deckId: string): Promise<{ members: PersonRow[]; pending: PendingInviteRow[] }> {
  const members = await db
    .select({ userId: user.id, name: user.name, email: user.email, image: user.image, role: deckMembers.role })
    .from(deckMembers)
    .innerJoin(user, eq(user.id, deckMembers.userId))
    .where(eq(deckMembers.deckId, deckId))
    .orderBy(asc(user.email))
  const pending = await db
    .select({ id: invites.id, email: invites.email, role: invites.role })
    .from(invites)
    .where(and(eq(invites.deckId, deckId), isNull(invites.acceptedAt)))
    .orderBy(asc(invites.email))
  return { members, pending }
}

/** Changes a non-owner member's role. Owners are never changed here. */
export async function setMemberRole(db: Db, deckId: string, userId: string, role: ShareRole): Promise<void> {
  const updated = await db
    .update(deckMembers)
    .set({ role })
    .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId), sql`${deckMembers.role} <> 'owner'`))
    .returning({ userId: deckMembers.userId })
  if (updated.length === 0) throw new Error('Member not found')
}

/** Removes a non-owner member. */
export async function removeMember(db: Db, deckId: string, userId: string): Promise<void> {
  const removed = await db
    .delete(deckMembers)
    .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId), sql`${deckMembers.role} <> 'owner'`))
    .returning({ userId: deckMembers.userId })
  if (removed.length === 0) throw new Error('Member not found')
}

function activeLinkWhere(deckId: string) {
  const now = new Date()
  return and(eq(shareLinks.deckId, deckId), isNull(shareLinks.revokedAt), or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)))
}

/** The deck's current general-access link, or null when access is restricted. */
export async function getGeneralAccess(db: Db, deckId: string): Promise<{ role: ShareRole; token: string } | null> {
  const [link] = await db
    .select({ role: shareLinks.role, token: shareLinks.token })
    .from(shareLinks)
    .where(activeLinkWhere(deckId))
    .orderBy(asc(shareLinks.createdAt))
    .limit(1)
  return link ?? null
}

/**
 * Sets general access. 'restricted' revokes every link. A role keeps the existing
 * token and changes its role, or creates a new link when none is active.
 */
export async function setGeneralAccess(
  db: Db,
  deckId: string,
  actorId: string,
  mode: 'restricted' | ShareRole,
): Promise<{ role: ShareRole; token: string } | null> {
  return db.transaction(async (tx) => {
    if (mode === 'restricted') {
      await tx.update(shareLinks).set({ revokedAt: new Date() }).where(activeLinkWhere(deckId))
      return null
    }
    const updated = await tx.update(shareLinks).set({ role: mode }).where(activeLinkWhere(deckId)).returning({ role: shareLinks.role, token: shareLinks.token })
    if (updated[0]) return updated[0]
    const token = newShareToken()
    await tx.insert(shareLinks).values({ deckId, token, role: mode, createdBy: actorId })
    return { role: mode, token }
  })
}

export function newShareToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Redeems a link for a signed-in user: adds (or keeps the stronger) membership with
 * the link's role. Returns the resulting role, or null when the token is not an
 * active link for this deck.
 */
export async function redeemShareLink(db: Db, userId: string, deckId: string, token: string): Promise<DeckRole | null> {
  const [link] = await db
    .select({ role: shareLinks.role })
    .from(shareLinks)
    .innerJoin(decks, eq(decks.id, shareLinks.deckId))
    .where(and(eq(shareLinks.token, token), eq(shareLinks.deckId, deckId), isNull(decks.deletedAt), activeLinkWhere(deckId)))
    .limit(1)
  if (!link) return null
  return db.transaction((tx) => grantMembership(tx, deckId, userId, link.role))
}

/** Stars or unstars a deck for one user. Returns false when the user is not a member. */
export async function setStarred(db: Db, userId: string, deckId: string, starred: boolean): Promise<boolean> {
  const updated = await db
    .update(deckMembers)
    .set({ starred })
    .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId)))
    .returning({ deckId: deckMembers.deckId })
  return updated.length > 0
}


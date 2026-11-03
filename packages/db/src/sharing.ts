// Membership, invites, general access ("share links") and per-user stars.
// Every grant goes through grantMembership, which never lowers an existing role.
import { randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull, notInArray, or, sql } from 'drizzle-orm'
import type { Db } from './client.ts'
import { higherRole, type DeckRole, type ShareRole } from './permissions.ts'
import { decks, deckMembers, invites, shareLinks, user } from './schema/index.ts'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** How a membership is held. Owner rows come only from creating or copying a deck. */
export type MemberVia = 'owner' | 'invite' | 'link'

/**
 * Adds a membership, or raises the existing one. Never lowers a role. The row is locked for the rest of the
 * transaction, so two concurrent grants serialise. `via`:
 * - an explicit grant ('invite') makes the membership explicit, so restricting a link never removes it. An owner stays owner.
 * - a link grant ('link') is recorded with its link. It does not change an explicit membership, and it moves an
 *   existing link membership to the link that was just redeemed.
 */
export async function grantMembership(
  tx: Tx,
  deckId: string,
  userId: string,
  role: DeckRole,
  via: Exclude<MemberVia, 'owner'> = 'invite',
  shareLinkId: string | null = null,
): Promise<DeckRole> {
  const link = via === 'link' ? shareLinkId : null
  await tx
    .insert(deckMembers)
    .values({ deckId, userId, role, via, shareLinkId: link })
    .onConflictDoNothing({ target: [deckMembers.deckId, deckMembers.userId] })
  const [row] = await tx
    .select({ role: deckMembers.role, via: deckMembers.via, shareLinkId: deckMembers.shareLinkId })
    .from(deckMembers)
    .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId)))
    .for('update')
    .limit(1)
  if (!row) throw new Error('membership missing after grant')

  const nextRole = higherRole(row.role, role)
  let nextVia: MemberVia = row.via
  let nextLink = row.shareLinkId
  if (row.via !== 'owner') {
    if (via === 'link') {
      if (row.via === 'link') nextLink = link
    } else {
      nextVia = 'invite'
      nextLink = null
    }
  }
  if (nextRole !== row.role || nextVia !== row.via || nextLink !== row.shareLinkId) {
    await tx
      .update(deckMembers)
      .set({ role: nextRole, via: nextVia, shareLinkId: nextLink })
      .where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, userId)))
  }
  return nextRole
}

/** Removes the link memberships whose link is no longer active (revoked, expired, or the deck is restricted). */
export async function pruneInactiveLinkMembers(db: Db | Tx, deckId: string): Promise<string[]> {
  const activeLinks = db
    .select({ id: shareLinks.id })
    .from(shareLinks)
    .where(activeLinkWhere(deckId))
  const removed = await db
    .delete(deckMembers)
    .where(
      and(
        eq(deckMembers.deckId, deckId),
        eq(deckMembers.via, 'link'),
        or(isNull(deckMembers.shareLinkId), notInArray(deckMembers.shareLinkId, activeLinks)),
      ),
    )
    .returning({ userId: deckMembers.userId })
  return removed.map((r) => r.userId)
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
  via: MemberVia
}

export interface PendingInviteRow {
  id: string
  email: string
  role: ShareRole
}

export async function listPeople(db: Db, deckId: string): Promise<{ members: PersonRow[]; pending: PendingInviteRow[] }> {
  await pruneInactiveLinkMembers(db, deckId)
  const members = await db
    .select({ userId: user.id, name: user.name, email: user.email, image: user.image, role: deckMembers.role, via: deckMembers.via })
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

/** Changes a non-owner member's role. This is an explicit grant, so a link member becomes an 'invite' member. */
export async function setMemberRole(db: Db, deckId: string, userId: string, role: ShareRole): Promise<void> {
  const updated = await db
    .update(deckMembers)
    .set({ role, via: 'invite', shareLinkId: null })
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
      // People who joined only through a link lose access now. Explicit members stay.
      await pruneInactiveLinkMembers(tx, deckId)
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
    .select({ id: shareLinks.id, role: shareLinks.role })
    .from(shareLinks)
    .innerJoin(decks, eq(decks.id, shareLinks.deckId))
    .where(and(eq(shareLinks.token, token), eq(shareLinks.deckId, deckId), isNull(decks.deletedAt), activeLinkWhere(deckId)))
    .limit(1)
  if (!link) return null
  return db.transaction((tx) => grantMembership(tx, deckId, userId, link.role, 'link', link.id))
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


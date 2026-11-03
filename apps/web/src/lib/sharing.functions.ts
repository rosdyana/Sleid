// Share dialog and invite acceptance. Rules: viewers see the people list; editors and owners
// invite (as editor, commenter or viewer); only the owner changes roles, removes people and
// sets general access. Ownership is never granted through an invite or a link.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import {
  acceptPendingInvites,
  canGrant,
  canInvite,
  canManagePeople,
  createInvite,
  deleteInvite,
  getGeneralAccess,
  listPeople,
  redeemShareLink,
  removeMember,
  SHARE_ROLES,
  setGeneralAccess,
  setMemberRole,
} from '@sleid/db'
import { requireDeckRole } from '~/lib/deck-access.server'
import { revalidateOpenConnections } from '~/lib/collab-revalidate.server'
import { requireUser } from '~/lib/session.server'

const deckIdSchema = z.object({ deckId: z.uuid() })
const shareRole = z.enum(SHARE_ROLES)

/** The people list, pending invites and general access. Each link token is returned only to people who can invite. */
export const listPeopleFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const myRole = await requireDeckRole(user.id, data.deckId, 'viewer')
    const { members, pending } = await listPeople(db, data.deckId)
    const access = await getGeneralAccess(db, data.deckId)
    return {
      myRole,
      members,
      pending,
      access: access ? { role: access.role, token: canInvite(myRole) ? access.token : null } : null,
    }
  })

export const inviteFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: z.uuid(), email: z.email().max(320), role: shareRole }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const myRole = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canGrant(myRole, data.role)) throw new Error('You need editor access to invite people')
    return createInvite(db, { deckId: data.deckId, invitedBy: user.id, email: data.email, role: data.role })
  })

export const removeInviteFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: z.uuid(), inviteId: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const myRole = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canInvite(myRole)) throw new Error('You need editor access to change invites')
    if (!(await deleteInvite(db, data.deckId, data.inviteId))) throw new Error('Invite not found')
    return { ok: true as const }
  })

export const setMemberRoleFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: z.uuid(), userId: z.string().min(1).max(200), role: shareRole }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const myRole = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canManagePeople(myRole)) throw new Error('Only the owner can change roles')
    await setMemberRole(db, data.deckId, data.userId, data.role)
    await revalidateOpenConnections(data.deckId)
    return { ok: true as const }
  })

export const removeMemberFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: z.uuid(), userId: z.string().min(1).max(200) }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const myRole = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canManagePeople(myRole)) throw new Error('Only the owner can remove people')
    await removeMember(db, data.deckId, data.userId)
    await revalidateOpenConnections(data.deckId)
    return { ok: true as const }
  })

/**
 * Sets general access. 'restricted' turns off the link. Owner only.
 * People who joined only through the link lose access (see setGeneralAccess).
 */
export const setGeneralAccessFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: z.uuid(), mode: z.enum(['restricted', ...SHARE_ROLES]) }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const myRole = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canManagePeople(myRole)) throw new Error('Only the owner can change general access')
    const access = await setGeneralAccess(db, data.deckId, user.id, data.mode)
    // Restricting a link removes the people who joined through it. Close their open connections now.
    await revalidateOpenConnections(data.deckId)
    return { access }
  })

/** Redeems a `?share=` link for the signed-in user. Adds the link's role, never lowering an existing one. */
export const redeemShareLinkFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: z.uuid(), token: z.string().min(16).max(128) }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await redeemShareLink(db, user.id, data.deckId, data.token)
    if (!role) throw new Error('This link is no longer valid')
    return { role }
  })

/** Turns pending invites for the signed-in email into memberships. Runs on every authenticated navigation. */
export const acceptInvitesFn = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser()
  const accepted = await acceptPendingInvites(db, user.id, user.email)
  return { accepted }
})

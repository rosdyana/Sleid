// Membership, invites, general access and stars against real Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import type { Db } from './client.ts'
import { deckMembers, invites, shareLinks, user } from './schema/index.ts'
import {
  acceptPendingInvites,
  createInvite,
  getGeneralAccess,
  grantMembership,
  listPeople,
  redeemShareLink,
  removeMember,
  setGeneralAccess,
  setMemberRole,
  setStarred,
} from './sharing.ts'
import { getDeckRole } from './deck-access.ts'

let db: Db | null = null
const created: string[] = []

beforeAll(async () => {
  db = await connectOrNull()
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, created)
  await db.$client.end({ timeout: 1 })
})

async function account(label: string, email?: string) {
  const u = await makeUser(db!, label)
  if (email) await db!.update(user).set({ email }).where(eq(user.id, u.id))
  created.push(u.id)
  return { ...u, email: email ?? u.email }
}

describe('grantMembership', () => {
  it('never lowers an existing role, and raises one when the grant is stronger', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('grant-owner')
    const member = await account('grant-member')
    const deckId = await makeDeck(db, owner.id)
    await db.transaction((tx) => grantMembership(tx, deckId, member.id, 'viewer'))
    expect(await getDeckRole(db, member.id, deckId)).toBe('viewer')
    await db.transaction((tx) => grantMembership(tx, deckId, member.id, 'editor'))
    expect(await getDeckRole(db, member.id, deckId)).toBe('editor')
    await db.transaction((tx) => grantMembership(tx, deckId, member.id, 'viewer'))
    expect(await getDeckRole(db, member.id, deckId)).toBe('editor')
    await db.transaction((tx) => grantMembership(tx, deckId, owner.id, 'editor'))
    expect(await getDeckRole(db, owner.id, deckId)).toBe('owner')
  })

  it('keeps the highest role when grants race each other', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('race-owner')
    const member = await account('race-member')
    const deckId = await makeDeck(db, owner.id)
    const roles = ['viewer', 'commenter', 'editor', 'viewer', 'commenter'] as const
    await Promise.all(roles.map((role) => db!.transaction((tx) => grantMembership(tx, deckId, member.id, role))))
    expect(await getDeckRole(db, member.id, deckId)).toBe('editor')
  })
})

describe('invites', () => {
  it('waits for an email with no account, then accepts it at sign-in (case-insensitive)', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('inv-owner')
    const deckId = await makeDeck(db, owner.id)
    const email = `Invitee.${randomUUID()}@Example.com`
    const result = await createInvite(db, { deckId, invitedBy: owner.id, email, role: 'editor' })
    expect(result).toEqual({ accepted: false })
    const before = await listPeople(db, deckId)
    expect(before.pending).toEqual([expect.objectContaining({ email: email.toLowerCase(), role: 'editor' })])

    // The invitee signs up later with the same address, in a different case.
    const signup = await account('inv-invitee', email.toLowerCase())
    expect(await acceptPendingInvites(db, signup.id, email.toUpperCase())).toBe(1)
    expect(await getDeckRole(db, signup.id, deckId)).toBe('editor')
    expect(await acceptPendingInvites(db, signup.id, email)).toBe(0)
    expect((await listPeople(db, deckId)).pending).toEqual([])
  })

  it('adds an existing account at once', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('inv2-owner')
    const existing = await account('inv2-existing')
    const deckId = await makeDeck(db, owner.id)
    const result = await createInvite(db, { deckId, invitedBy: owner.id, email: existing.email, role: 'viewer' })
    expect(result).toEqual({ accepted: true })
    expect(await getDeckRole(db, existing.id, deckId)).toBe('viewer')
  })

  it('never downgrades an owner or an editor who is invited with a weaker role', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('inv3-owner')
    const editor = await account('inv3-editor')
    const deckId = await makeDeck(db, owner.id)
    await createInvite(db, { deckId, invitedBy: owner.id, email: editor.email, role: 'editor' })
    await createInvite(db, { deckId, invitedBy: owner.id, email: editor.email, role: 'viewer' })
    expect(await getDeckRole(db, editor.id, deckId)).toBe('editor')
    await createInvite(db, { deckId, invitedBy: owner.id, email: owner.email, role: 'viewer' })
    expect(await getDeckRole(db, owner.id, deckId)).toBe('owner')
  })
})

describe('share links', () => {
  it('redeems an active link once per user, and never downgrades an existing role', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('link-owner')
    const viewer = await account('link-viewer')
    const deckId = await makeDeck(db, owner.id)
    const access = await setGeneralAccess(db, deckId, owner.id, 'viewer')
    expect(access?.role).toBe('viewer')
    expect(await getGeneralAccess(db, deckId)).toEqual(access)

    expect(await redeemShareLink(db, viewer.id, deckId, access!.token)).toBe('viewer')
    await db.transaction((tx) => grantMembership(tx, deckId, viewer.id, 'editor'))
    expect(await redeemShareLink(db, viewer.id, deckId, access!.token)).toBe('editor')
    expect(await redeemShareLink(db, owner.id, deckId, access!.token)).toBe('owner')
  })

  it('rejects a token for another deck, an unknown token, and an expired link', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('link2-owner')
    const stranger = await account('link2-stranger')
    const deckA = await makeDeck(db, owner.id)
    const deckB = await makeDeck(db, owner.id)
    const access = await setGeneralAccess(db, deckA, owner.id, 'commenter')
    expect(await redeemShareLink(db, stranger.id, deckB, access!.token)).toBeNull()
    expect(await redeemShareLink(db, stranger.id, deckA, 'not-a-real-token-value-000')).toBeNull()

    await db.update(shareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shareLinks.token, access!.token))
    expect(await redeemShareLink(db, stranger.id, deckA, access!.token)).toBeNull()
    expect(await getDeckRole(db, stranger.id, deckA)).toBeNull()
  })

  it('restricted revokes every link; enabling again issues a new token; a role change keeps the token', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('link3-owner')
    const deckId = await makeDeck(db, owner.id)
    const first = await setGeneralAccess(db, deckId, owner.id, 'viewer')
    const changed = await setGeneralAccess(db, deckId, owner.id, 'editor')
    expect(changed).toEqual({ role: 'editor', token: first!.token })

    expect(await setGeneralAccess(db, deckId, owner.id, 'restricted')).toBeNull()
    expect(await getGeneralAccess(db, deckId)).toBeNull()
    const revoked = await db.select().from(shareLinks).where(eq(shareLinks.deckId, deckId))
    expect(revoked.every((row) => row.revokedAt !== null)).toBe(true)

    const again = await setGeneralAccess(db, deckId, owner.id, 'viewer')
    expect(again?.token).not.toBe(first!.token)
  })
})

describe('members, roles and stars', () => {
  it('owner row cannot be changed or removed through member operations', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('mem-owner')
    const deckId = await makeDeck(db, owner.id)
    await expect(setMemberRole(db, deckId, owner.id, 'viewer')).rejects.toThrow('Member not found')
    await expect(removeMember(db, deckId, owner.id)).rejects.toThrow('Member not found')
    expect(await getDeckRole(db, owner.id, deckId)).toBe('owner')
  })

  it('changes and removes a non-owner member', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('mem2-owner')
    const member = await account('mem2-member')
    const deckId = await makeDeck(db, owner.id)
    await db.transaction((tx) => grantMembership(tx, deckId, member.id, 'editor'))
    await setMemberRole(db, deckId, member.id, 'commenter')
    expect(await getDeckRole(db, member.id, deckId)).toBe('commenter')
    await removeMember(db, deckId, member.id)
    expect(await getDeckRole(db, member.id, deckId)).toBeNull()
  })

  it('stars are per user: starring affects only the caller', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('star-owner')
    const other = await account('star-other')
    const deckId = await makeDeck(db, owner.id)
    await db.transaction((tx) => grantMembership(tx, deckId, other.id, 'viewer'))
    expect(await setStarred(db, other.id, deckId, true)).toBe(true)
    const [mine] = await db.select({ starred: deckMembers.starred }).from(deckMembers).where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, owner.id)))
    const [theirs] = await db.select({ starred: deckMembers.starred }).from(deckMembers).where(and(eq(deckMembers.deckId, deckId), eq(deckMembers.userId, other.id)))
    expect(mine?.starred).toBe(false)
    expect(theirs?.starred).toBe(true)
    expect(await setStarred(db, owner.id, deckId, true)).toBe(true)
    const stranger = await account('star-stranger')
    expect(await setStarred(db, stranger.id, deckId, true)).toBe(false)
  })

  it('pending invite rows are visible to the people list only until accepted', async (ctx) => {
    if (!db) return ctx.skip()
    const owner = await account('pend-owner')
    const deckId = await makeDeck(db, owner.id)
    await createInvite(db, { deckId, invitedBy: owner.id, email: `pending-${randomUUID()}@example.com`, role: 'viewer' })
    const rows = await db.select().from(invites).where(eq(invites.deckId, deckId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.acceptedAt).toBeNull()
  })
})

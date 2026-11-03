// Memberships that came through a share link: they end when the link is restricted, revoked or expires.
// Explicit grants (invite, share dialog role, MCP share_deck) are never removed by that. Against real Postgres.
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from './client.ts'
import { deckMembers, shareLinks } from './schema/index.ts'
import { connectOrNull, makeDeck, makeUser, removeUsers } from './testing.ts'
import { createInvite, getGeneralAccess, listPeople, redeemShareLink, setGeneralAccess, setMemberRole } from './sharing.ts'
import { getDeckRole } from './deck-access.ts'

let db: Db | null = null
const users: string[] = []

beforeAll(async () => {
  db = await connectOrNull()
})
afterAll(async () => {
  if (db) {
    await removeUsers(db, users)
    await db.$client.end({ timeout: 1 })
  }
})

async function person(label: string) {
  const u = await makeUser(db!, label)
  users.push(u.id)
  return u
}

async function membership(deckId: string, userId: string) {
  const rows = await db!.select().from(deckMembers).where(eq(deckMembers.deckId, deckId))
  return rows.find((r) => r.userId === userId) ?? null
}

describe('link-only memberships', () => {
  it('restricting access removes link-only members and keeps explicit ones', async () => {
    if (!db) return
    const owner = await person('lm-owner')
    const linkOnly = await person('lm-link-only')
    const invited = await person('lm-invited')
    const upgraded = await person('lm-upgraded')
    const deck = await makeDeck(db, owner.id, 'Link membership')

    const access = await setGeneralAccess(db, deck, owner.id, 'editor')
    expect(access?.token).toBeTruthy()
    expect(await redeemShareLink(db, linkOnly.id, deck, access!.token)).toBe('editor')
    expect(await redeemShareLink(db, upgraded.id, deck, access!.token)).toBe('editor')
    expect(await membership(deck, linkOnly.id)).toMatchObject({ via: 'link' })

    await createInvite(db, { deckId: deck, invitedBy: owner.id, email: invited.email, role: 'viewer' })
    expect(await membership(deck, invited.id)).toMatchObject({ via: 'invite', role: 'viewer' })

    // Joined by link, then given an explicit role: the membership is explicit now.
    await createInvite(db, { deckId: deck, invitedBy: owner.id, email: upgraded.email, role: 'editor' })
    expect(await membership(deck, upgraded.id)).toMatchObject({ via: 'invite', shareLinkId: null })

    await setGeneralAccess(db, deck, owner.id, 'restricted')
    expect(await membership(deck, linkOnly.id)).toBeNull()
    expect(await membership(deck, invited.id)).toMatchObject({ via: 'invite' })
    expect(await membership(deck, upgraded.id)).toMatchObject({ via: 'invite', role: 'editor' })
    expect(await getDeckRole(db, linkOnly.id, deck)).toBeNull()
    expect(await getDeckRole(db, invited.id, deck)).toBe('viewer')
    expect(await getDeckRole(db, upgraded.id, deck)).toBe('editor')
    // The old link no longer admits anyone.
    const late = await person('lm-late')
    expect(await redeemShareLink(db, late.id, deck, access!.token)).toBeNull()
  })

  it('revoking the link is the same as restricting, and the owner keeps owner', async () => {
    if (!db) return
    const owner = await person('lm-owner-2')
    const joiner = await person('lm-joiner-2')
    const deck = await makeDeck(db, owner.id, 'Revoke')
    const access = await setGeneralAccess(db, deck, owner.id, 'viewer')
    await redeemShareLink(db, joiner.id, deck, access!.token)
    expect(await getGeneralAccess(db, deck)).not.toBeNull()
    await setGeneralAccess(db, deck, owner.id, 'restricted')
    expect(await getDeckRole(db, joiner.id, deck)).toBeNull()
    expect(await getDeckRole(db, owner.id, deck)).toBe('owner')
  })

  it('an expired link ends access at the next check, and the people list drops the member', async () => {
    if (!db) return
    const owner = await person('lm-owner-3')
    const joiner = await person('lm-joiner-3')
    const deck = await makeDeck(db, owner.id, 'Expiry')
    const access = await setGeneralAccess(db, deck, owner.id, 'editor')
    await redeemShareLink(db, joiner.id, deck, access!.token)
    expect(await getDeckRole(db, joiner.id, deck)).toBe('editor')
    await db!.update(shareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shareLinks.deckId, deck))
    expect(await getDeckRole(db, joiner.id, deck)).toBeNull()
    const people = await listPeople(db, deck)
    expect(people.members.map((m) => m.userId)).not.toContain(joiner.id)
  })

  it('an explicit role change on a link member makes the membership explicit', async () => {
    if (!db) return
    const owner = await person('lm-owner-4')
    const joiner = await person('lm-joiner-4')
    const deck = await makeDeck(db, owner.id, 'Set role')
    const access = await setGeneralAccess(db, deck, owner.id, 'editor')
    await redeemShareLink(db, joiner.id, deck, access!.token)
    await setMemberRole(db, deck, joiner.id, 'commenter')
    expect(await membership(deck, joiner.id)).toMatchObject({ via: 'invite', role: 'commenter', shareLinkId: null })
    await setGeneralAccess(db, deck, owner.id, 'restricted')
    expect(await getDeckRole(db, joiner.id, deck)).toBe('commenter')
  })

  it('the people list shows how each person joined', async () => {
    if (!db) return
    const owner = await person('lm-owner-5')
    const joiner = await person('lm-joiner-5')
    const deck = await makeDeck(db, owner.id, 'Labels')
    const access = await setGeneralAccess(db, deck, owner.id, 'viewer')
    await redeemShareLink(db, joiner.id, deck, access!.token)
    const people = await listPeople(db, deck)
    expect(people.members.find((m) => m.userId === joiner.id)?.via).toBe('link')
    expect(people.members.find((m) => m.userId === owner.id)?.via).toBe('owner')
  })
})

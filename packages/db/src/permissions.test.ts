import { describe, expect, it } from 'vitest'
import {
  canEdit,
  canGrant,
  canInvite,
  canManagePeople,
  DECK_ROLES,
  higherRole,
  isReadOnlyRole,
  roleAfterGrant,
  roleAtLeast,
  SHARE_ROLES,
  type DeckRole,
} from './permissions.ts'

describe('roleAtLeast', () => {
  it('orders roles owner > editor > commenter > viewer', () => {
    expect(DECK_ROLES).toEqual(['owner', 'editor', 'commenter', 'viewer'])
  })

  it('allows a role to satisfy its own minimum', () => {
    for (const role of DECK_ROLES) expect(roleAtLeast(role, role)).toBe(true)
  })

  it('lets stronger roles satisfy weaker minimums', () => {
    expect(roleAtLeast('owner', 'viewer')).toBe(true)
    expect(roleAtLeast('editor', 'commenter')).toBe(true)
    expect(roleAtLeast('commenter', 'viewer')).toBe(true)
  })

  it('rejects weaker roles for stronger minimums', () => {
    expect(roleAtLeast('viewer', 'commenter')).toBe(false)
    expect(roleAtLeast('commenter', 'editor')).toBe(false)
    expect(roleAtLeast('editor', 'owner')).toBe(false)
    expect(roleAtLeast('viewer', 'owner')).toBe(false)
  })

  it('is a total order over every pair', () => {
    const ranks = (r: DeckRole) => DECK_ROLES.length - DECK_ROLES.indexOf(r)
    for (const a of DECK_ROLES) {
      for (const b of DECK_ROLES) {
        expect(roleAtLeast(a, b)).toBe(ranks(a) >= ranks(b))
      }
    }
  })
})

describe('role gating', () => {
  it('only owner and editor can change the document', () => {
    expect(DECK_ROLES.filter(canEdit)).toEqual(['owner', 'editor'])
    expect(DECK_ROLES.filter(isReadOnlyRole)).toEqual(['commenter', 'viewer'])
  })

  it('editors and owners can invite, viewers and commenters cannot', () => {
    expect(DECK_ROLES.filter(canInvite)).toEqual(['owner', 'editor'])
  })

  it('only the owner manages people and general access', () => {
    expect(DECK_ROLES.filter(canManagePeople)).toEqual(['owner'])
  })

  it('lets an editor grant editor, commenter or viewer, never owner', () => {
    expect(SHARE_ROLES).toEqual(['editor', 'commenter', 'viewer'])
    for (const target of SHARE_ROLES) expect(canGrant('editor', target)).toBe(true)
    for (const actor of ['commenter', 'viewer'] as const) {
      for (const target of SHARE_ROLES) expect(canGrant(actor, target)).toBe(false)
    }
  })
})

describe('grants never downgrade', () => {
  it('higherRole keeps the stronger of two roles', () => {
    expect(higherRole('viewer', 'editor')).toBe('editor')
    expect(higherRole('editor', 'viewer')).toBe('editor')
    expect(higherRole('owner', 'editor')).toBe('owner')
    expect(higherRole('commenter', 'commenter')).toBe('commenter')
  })

  it('roleAfterGrant gives the granted role to a new member and the stronger role to an existing one', () => {
    expect(roleAfterGrant(null, 'viewer')).toBe('viewer')
    expect(roleAfterGrant('editor', 'viewer')).toBe('editor')
    expect(roleAfterGrant('viewer', 'commenter')).toBe('commenter')
    expect(roleAfterGrant('owner', 'editor')).toBe('owner')
  })
})

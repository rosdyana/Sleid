import { describe, expect, it } from 'vitest'
import { DECK_ROLES, roleAtLeast, type DeckRole } from './permissions'

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

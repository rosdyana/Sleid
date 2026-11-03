import { describe, expect, it } from 'vitest'
import { DeckSchema } from '@sleid/model'
import { demoDeck } from './demo.ts'
import { lintDeck } from './lint.ts'
import { COMPONENT_KINDS } from './components/index.ts'

describe('demo deck', () => {
  const deck = demoDeck()

  it('is a valid deck with ten slides on Paper Navy', () => {
    expect(DeckSchema.safeParse(deck).success).toBe(true)
    expect(deck.slides).toHaveLength(10)
    expect(deck.theme.name).toBe('Paper Navy')
  })

  it('shows every component kind at least once', () => {
    const kinds = new Set(deck.slides.flatMap((s) => s.elements.map((e) => e.component?.kind).filter(Boolean)))
    for (const k of COMPONENT_KINDS) expect(kinds.has(k)).toBe(true)
  })

  it('uses the dark variant on the cover and the ask', () => {
    expect(deck.slides[0]!.variant).toBe('dark')
    expect(deck.slides[9]!.variant).toBe('dark')
    expect(deck.slides[9]!.background?.type).toBe('gradient')
  })

  it('lints with zero errors and zero warnings', () => {
    const issues = lintDeck(deck)
    const bad = issues.filter((i) => i.severity !== 'info')
    expect(bad, JSON.stringify(bad.slice(0, 3), null, 2)).toHaveLength(0)
  })

  it('returns a fresh object each call', () => {
    expect(demoDeck()).not.toBe(demoDeck())
  })
})

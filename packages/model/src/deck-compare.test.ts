import { describe, expect, it } from 'vitest'
import { compareDecks, stableStringify } from './deck-compare.ts'
import { BUILT_IN_THEMES, createDeck, createSlide } from './defaults.ts'

const theme = BUILT_IN_THEMES[0]!

describe('compareDecks', () => {
  it('reports identical decks as unchanged', () => {
    const deck = createDeck('Same')
    expect(compareDecks(deck, structuredClone(deck))).toEqual({ onlyInVersion: 0, onlyInCurrent: 0, changed: 0, unchanged: 1, titleChanged: false })
  })

  it('counts slides only in the version, only in the current deck, and changed slides', () => {
    const base = createDeck('Deck')
    const shared = base.slides[0]!
    const onlyCurrent = createSlide('blank', theme)
    const onlyVersion = createSlide('blank', theme)
    const current = { ...base, slides: [shared, onlyCurrent] }
    const version = { ...base, slides: [{ ...shared, notes: 'older notes' }, onlyVersion] }
    expect(compareDecks(current, version)).toEqual({ onlyInVersion: 1, onlyInCurrent: 1, changed: 1, unchanged: 0, titleChanged: false })
  })

  it('flags a title change', () => {
    const a = createDeck('One')
    const b = { ...structuredClone(a), title: 'Two' }
    expect(compareDecks(a, b).titleChanged).toBe(true)
  })
})

describe('stableStringify', () => {
  it('ignores key order at every level', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(stableStringify({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }))
  })
})

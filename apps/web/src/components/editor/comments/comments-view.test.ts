import { describe, expect, it } from 'vitest'
import type { ThreadView } from '@sleid/db'
import { createDeck, createSlide, BUILT_IN_THEMES } from '@sleid/model'
import { anchorLabel, pinNumbers, pinsFor } from './comment-view'
import { groupByDay } from '../history-model'

function thread(id: string, slideId: string, extra: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    deckId: 'deck',
    slideId,
    elementId: null,
    anchor: { x: 10, y: 20 },
    resolved: false,
    resolvedAt: null,
    resolvedByName: null,
    createdAt: `2026-11-03T09:0${id.length}:00.000Z`,
    createdBy: 'u',
    comments: [],
    ...extra,
  }
}

describe('comment pins', () => {
  it('numbers threads per slide in creation order', () => {
    const threads = [thread('a', 's1'), thread('bb', 's2'), thread('ccc', 's1')]
    expect(Object.fromEntries(pinNumbers(threads))).toEqual({ a: 1, bb: 1, ccc: 2 })
  })

  it('shows open pins on the slide, and resolved ones only when asked', () => {
    const numbers = pinNumbers([thread('a', 's1'), thread('bb', 's1', { resolved: true }), thread('c', 's2')])
    const threads = [thread('a', 's1'), thread('bb', 's1', { resolved: true }), thread('c', 's2')]
    expect(pinsFor(threads, 's1', numbers, null, false).map((p) => p.threadId)).toEqual(['a'])
    expect(pinsFor(threads, 's1', numbers, 'a', true).map((p) => [p.threadId, p.resolved, p.active])).toEqual([
      ['a', false, true],
      ['bb', true, false],
    ])
  })

  it('reads an element that was deleted as "element removed"', () => {
    const slide = { ...createSlide('blank', BUILT_IN_THEMES[0]!), id: 's1', elements: [] }
    const deck = { ...createDeck('D'), slides: [slide] }
    expect(anchorLabel(deck, { slideId: 's1', elementId: 'gone' })).toEqual({ text: 'element removed', removed: true })
    expect(anchorLabel(deck, { slideId: 's1', elementId: null })).toEqual({ text: 'Slide 1', removed: false })
    // A restore can remove the slide a thread was on.
    expect(anchorLabel(deck, { slideId: 'gone-slide', elementId: null })).toEqual({ text: 'slide removed', removed: true })
  })
})

describe('history grouping', () => {
  it('groups automatic versions by day, newest day first, keeping the order inside a day', () => {
    const now = new Date(2026, 10, 3, 15, 0, 0)
    const versions = [
      { id: '1', kind: 'auto' as const, name: null, createdAt: new Date(2026, 10, 3, 14, 0).toISOString(), createdBy: null, editors: [] },
      { id: '2', kind: 'auto' as const, name: null, createdAt: new Date(2026, 10, 3, 9, 0).toISOString(), createdBy: null, editors: [] },
      { id: '3', kind: 'auto' as const, name: null, createdAt: new Date(2026, 10, 2, 22, 0).toISOString(), createdBy: null, editors: [] },
      { id: '4', kind: 'auto' as const, name: null, createdAt: new Date(2026, 9, 20, 10, 0).toISOString(), createdBy: null, editors: [] },
    ]
    const groups = groupByDay(versions, now)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', expect.any(String)])
    expect(groups[0]!.items.map((v) => v.id)).toEqual(['1', '2'])
    expect(groups[1]!.items.map((v) => v.id)).toEqual(['3'])
  })
})

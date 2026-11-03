import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyOps, createDeck, deckToYDoc, yDocToDeck } from './index.ts'

// Two replicas that start from the same state.
function twoReplicas() {
  const a = deckToYDoc(createDeck('Shared'))
  const b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  return { a, b }
}

function sync(a: Y.Doc, b: Y.Doc) {
  const ua = Y.encodeStateAsUpdate(a)
  const ub = Y.encodeStateAsUpdate(b)
  Y.applyUpdate(b, ua)
  Y.applyUpdate(a, ub)
}

const rect = (id: string, x: number) => ({
  id,
  type: 'shape',
  shape: 'rect',
  x,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  locked: false,
  opacity: 1,
  fill: '#000000',
  stroke: '#000000',
  strokeWidth: 1,
})

describe('concurrent edits converge', () => {
  it('addElement on one slide, moveSlide and updateElement on different fields all merge', () => {
    const { a, b } = twoReplicas()
    // Shared starting state: slide s1 (the first slide), with element e1; slide s2 at the end.
    const s1 = yDocToDeck(a).slides[0]!.id
    applyOps(a, [
      { op: 'addSlide', layout: 'blank', slide: { id: 's2' } },
      { op: 'addElement', slideId: s1, element: rect('e1', 0) },
    ])
    sync(a, b)

    // Concurrent, offline from each other.
    applyOps(a, [
      { op: 'addElement', slideId: s1, element: rect('from-a', 100) },
      { op: 'updateElement', slideId: s1, elementId: 'e1', patch: { x: 500 } },
    ])
    applyOps(b, [
      { op: 'addElement', slideId: s1, element: rect('from-b', 200) },
      { op: 'moveSlide', slideId: 's2', toIndex: 0 },
      { op: 'updateElement', slideId: s1, elementId: 'e1', patch: { opacity: 0.5 } },
    ])

    sync(a, b)

    const deckA = yDocToDeck(a)
    expect(yDocToDeck(b)).toEqual(deckA)

    expect(deckA.slides.map((s) => s.id)).toEqual(['s2', s1])
    // Two placeholder elements from createDeck, plus e1, from-a and from-b.
    const ids = deckA.slides[1]!.elements.map((e) => e.id)
    expect(ids).toHaveLength(5)
    expect(ids).toEqual(expect.arrayContaining(['e1', 'from-a', 'from-b']))

    const e1 = deckA.slides[1]!.elements.find((e) => e.id === 'e1')!
    expect(e1.x).toBe(500) // from replica a
    expect(e1.opacity).toBe(0.5) // from replica b
  })

  it('two replicas editing the same field converge on one value', () => {
    const { a, b } = twoReplicas()
    const s1 = yDocToDeck(a).slides[0]!.id
    applyOps(a, [{ op: 'addElement', slideId: s1, element: rect('e1', 0) }])
    sync(a, b)

    applyOps(a, [{ op: 'updateElement', slideId: s1, elementId: 'e1', patch: { x: 1 } }])
    applyOps(b, [{ op: 'updateElement', slideId: s1, elementId: 'e1', patch: { x: 2 } }])
    sync(a, b)

    expect(yDocToDeck(b)).toEqual(yDocToDeck(a))
  })

  it('concurrent edits to slide meta and the title converge', () => {
    const { a, b } = twoReplicas()
    const s1 = yDocToDeck(a).slides[0]!.id
    applyOps(a, [{ op: 'updateSlide', slideId: s1, patch: { transition: 'fade' } }, { op: 'setTitle', title: 'A title' }])
    applyOps(b, [{ op: 'setNotes', slideId: s1, notes: 'B notes' }, { op: 'setTheme', theme: { radius: 2 } }])
    sync(a, b)
    const deck = yDocToDeck(a)
    expect(yDocToDeck(b)).toEqual(deck)
    expect(deck).toMatchObject({ title: 'A title', theme: { radius: 2 } })
    expect(deck.slides[0]).toMatchObject({ transition: 'fade', notes: 'B notes' })
  })

  it('a move and a concurrent element insert on the same slide both survive', () => {
    const { a, b } = twoReplicas()
    applyOps(a, [{ op: 'addSlide', layout: 'blank', slide: { id: 's2' } }])
    sync(a, b)
    applyOps(a, [{ op: 'moveSlide', slideId: 's2', toIndex: 0 }])
    applyOps(b, [{ op: 'addElement', slideId: 's2', element: rect('late', 0) }])
    sync(a, b)
    const deck = yDocToDeck(a)
    expect(yDocToDeck(b)).toEqual(deck)
    expect(deck.slides[0]!.id).toBe('s2')
    expect(deck.slides[0]!.elements.map((e) => e.id)).toContain('late')
  })

  it('a move and a concurrent updateSlide on the same slide both survive', () => {
    const { a, b } = twoReplicas()
    applyOps(a, [{ op: 'addSlide', layout: 'blank', slide: { id: 's2' } }])
    sync(a, b)
    applyOps(a, [{ op: 'moveSlide', slideId: 's2', toIndex: 0 }])
    applyOps(b, [{ op: 'updateSlide', slideId: 's2', patch: { transition: 'fade' } }])
    sync(a, b)
    const deck = yDocToDeck(a)
    expect(yDocToDeck(b)).toEqual(deck)
    expect(deck.slides[0]).toMatchObject({ id: 's2', transition: 'fade' })
  })

  it('two concurrent moves of the same slide leave one copy of it and converge', () => {
    const { a, b } = twoReplicas()
    applyOps(a, [
      { op: 'addSlide', layout: 'blank', slide: { id: 's2' } },
      { op: 'addSlide', layout: 'blank', slide: { id: 's3' } },
    ])
    sync(a, b)
    applyOps(a, [{ op: 'moveSlide', slideId: 's3', toIndex: 0 }])
    applyOps(b, [{ op: 'moveSlide', slideId: 's3', toIndex: 1 }])
    sync(a, b)
    const deck = yDocToDeck(a)
    expect(yDocToDeck(b)).toEqual(deck)
    const ids = deck.slides.map((s) => s.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual(expect.arrayContaining([yDocToDeck(a).slides[0]!.id, 's2', 's3']))
  })

  it('concurrent inserts at the same position both survive, in a stable order', () => {
    const { a, b } = twoReplicas()
    const s1 = yDocToDeck(a).slides[0]!.id
    applyOps(a, [{ op: 'addSlide', layout: 'blank', index: 1, slide: { id: 'x' } }])
    applyOps(b, [{ op: 'addSlide', layout: 'blank', index: 1, slide: { id: 'y' } }])
    sync(a, b)
    const deck = yDocToDeck(a)
    expect(yDocToDeck(b)).toEqual(deck)
    expect(deck.slides.map((s) => s.id)).toEqual([s1, 'x', 'y'])
  })

  it('a move placed between two equal-key neighbours still works (keys are respaced)', () => {
    const { a, b } = twoReplicas()
    const s1 = yDocToDeck(a).slides[0]!.id
    applyOps(a, [{ op: 'addSlide', layout: 'blank', index: 1, slide: { id: 'x' } }])
    applyOps(b, [{ op: 'addSlide', layout: 'blank', index: 1, slide: { id: 'y' } }])
    sync(a, b)
    applyOps(a, [{ op: 'moveSlide', slideId: s1, toIndex: 1 }])
    expect(yDocToDeck(a).slides.map((s) => s.id)).toEqual(['x', s1, 'y'])
  })

  it('a concurrent move and delete of the same slide converge with the slide gone', () => {
    const { a, b } = twoReplicas()
    applyOps(a, [{ op: 'addSlide', layout: 'blank', slide: { id: 's2' } }])
    sync(a, b)
    applyOps(a, [{ op: 'moveSlide', slideId: 's2', toIndex: 0 }])
    applyOps(b, [{ op: 'deleteSlide', slideId: 's2' }])
    sync(a, b)
    const deck = yDocToDeck(a)
    expect(yDocToDeck(b)).toEqual(deck)
    expect(deck.slides.map((s) => s.id)).not.toContain('s2')
  })
})

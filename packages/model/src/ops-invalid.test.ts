// Every op type, with an invalid target placed after a valid setTitle.
// Each batch must throw an OpError at index 1 and leave the doc exactly as it was.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyOps, createDeck, deckToYDoc, OpError, OpSchema, yDocToDeck, type Op } from './index.ts'

const rect = { type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, locked: false, opacity: 1, fill: '#000', stroke: '#000', strokeWidth: 1 }

// Each entry: a human name, and an op that must fail against the fixture deck below.
const invalid: Array<[string, Record<string, unknown>]> = [
  ['addSlide (missing section)', { op: 'addSlide', layout: 'blank', slide: { sectionId: 'nope' } }],
  ['addSlide (duplicate id)', { op: 'addSlide', layout: 'blank', slide: { id: 'S1' } }],
  ['deleteSlide', { op: 'deleteSlide', slideId: 'missing' }],
  ['duplicateSlide', { op: 'duplicateSlide', slideId: 'missing' }],
  ['moveSlide', { op: 'moveSlide', slideId: 'missing', toIndex: 0 }],
  ['updateSlide', { op: 'updateSlide', slideId: 'missing', patch: { notes: 'x' } }],
  ['updateSlide (missing section)', { op: 'updateSlide', slideId: 'S1', patch: { sectionId: 'nope' } }],
  ['addElement', { op: 'addElement', slideId: 'missing', element: rect }],
  ['addElement (duplicate id)', { op: 'addElement', slideId: 'S1', element: { ...rect, id: 'E1' } }],
  ['updateElement', { op: 'updateElement', slideId: 'S1', elementId: 'missing', patch: { x: 1 } }],
  ['updateElement (invalid value)', { op: 'updateElement', slideId: 'S1', elementId: 'E1', patch: { opacity: 5 } }],
  ['deleteElement', { op: 'deleteElement', slideId: 'S1', elementId: 'missing' }],
  ['reorderElement', { op: 'reorderElement', slideId: 'S1', elementId: 'missing', z: 'front' }],
  ['setTheme (invalid value)', { op: 'setTheme', theme: { sizes: { title: -1 } } }],
  ['setTitle (invalid type)', { op: 'setTitle', title: 42 }],
  ['addSection (duplicate id)', { op: 'addSection', id: 'SEC', name: 'again' }],
  ['renameSection', { op: 'renameSection', sectionId: 'missing', name: 'x' }],
  ['deleteSection', { op: 'deleteSection', sectionId: 'missing' }],
  ['setNotes', { op: 'setNotes', slideId: 'missing', notes: 'x' }],
]

function fixture() {
  const deck = createDeck('Fixture')
  deck.sections = [{ id: 'SEC', name: 'Intro' }]
  deck.slides = [
    { ...deck.slides[0]!, id: 'S1', elements: [{ ...rect, id: 'E1', z: 0 } as never] },
  ]
  return { doc: deckToYDoc(deck), before: yDocToDeck(deckToYDoc(deck)) }
}

describe('every op type rejects an invalid target without partial apply', () => {
  it('covers all 15 op types', () => {
    const covered = new Set(invalid.map(([, op]) => op.op as string))
    const all = (OpSchema.options as Array<{ shape: { op: { value: string } } }>).map((o) => o.shape.op.value)
    expect([...covered].sort()).toEqual([...all].sort())
  })

  for (const [name, bad] of invalid) {
    it(name, () => {
      const { doc } = fixture()
      const beforeText = yDocToDeck(doc)
      let updates = 0
      doc.on('update', () => updates++)
      const batch: Op[] | unknown[] = [{ op: 'setTitle', title: 'must not stick' }, bad]
      let thrown: unknown
      try {
        applyOps(doc, batch)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(OpError)
      expect((thrown as OpError).opIndex).toBe(1)
      expect(updates).toBe(0)
      expect(yDocToDeck(doc)).toEqual(beforeText)
      expect(yDocToDeck(doc).title).toBe('Fixture')
    })
  }

  it('a failed batch leaves a Y.Doc encoding identical to before', () => {
    const { doc } = fixture()
    const before = Y.encodeStateAsUpdate(doc)
    const stateBefore = Y.encodeStateVector(doc)
    expect(() => applyOps(doc, [{ op: 'setTitle', title: 'x' }, { op: 'deleteSlide', slideId: 'missing' }])).toThrow(OpError)
    expect(Y.encodeStateVector(doc)).toEqual(stateBefore)
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

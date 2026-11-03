import { describe, expect, it } from 'vitest'
import { applyOps, createDeck, createUndoManager, deckToYDoc, yDocToDeck } from './index.ts'

describe('undo manager', () => {
  it('reverts one applyOps batch as a single step, and redo restores it', () => {
    const doc = deckToYDoc(createDeck('Undo'))
    const um = createUndoManager(doc, ['editor'])
    const before = yDocToDeck(doc)

    applyOps(
      doc,
      [
        { op: 'addSlide', layout: 'blank', slide: { id: 'u1' } },
        { op: 'setTitle', title: 'Changed' },
        { op: 'addElement', slideId: 'u1', element: { id: 'r', type: 'embed', url: 'https://example.com', x: 0, y: 0, w: 1, h: 1, rotation: 0, locked: false, opacity: 1 } },
      ],
      'editor',
    )
    const after = yDocToDeck(doc)
    expect(after.slides).toHaveLength(2)

    um.undo()
    expect(yDocToDeck(doc)).toEqual(before)

    um.redo()
    expect(yDocToDeck(doc)).toEqual(after)
  })

  it('undoes each batch separately and leaves untracked origins alone', () => {
    const doc = deckToYDoc(createDeck('Undo'))
    const um = createUndoManager(doc, ['editor'])

    applyOps(doc, [{ op: 'setTitle', title: 'one' }], 'editor')
    applyOps(doc, [{ op: 'addSlide', layout: 'blank', slide: { id: 'remote-slide' } }], 'remote-peer')
    applyOps(doc, [{ op: 'setTitle', title: 'two' }], 'editor')

    um.undo()
    expect(yDocToDeck(doc).title).toBe('one')
    expect(yDocToDeck(doc).slides.map((s) => s.id)).toContain('remote-slide')

    um.undo()
    expect(yDocToDeck(doc).title).toBe('Undo')
    expect(yDocToDeck(doc).slides.map((s) => s.id)).toContain('remote-slide')
  })
})

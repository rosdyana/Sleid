import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createDeck, createSlide, BUILT_IN_THEMES, deckToYDoc, replaceDeckContent, yDocToDeck, applyOps } from './index.ts'
import { fullDeck } from './fixtures.ts'

describe('replaceDeckContent', () => {
  it('makes the document equal the target deck, in one update', () => {
    const doc = deckToYDoc(createDeck('Current'))
    applyOps(doc, [{ op: 'addSlide', layout: 'blank', slide: { id: 'extra' } }], 'local')
    const target = fullDeck()

    let updates = 0
    doc.on('update', () => updates++)
    replaceDeckContent(doc, target, 'server:restore')
    expect(updates).toBe(1)
    expect(yDocToDeck(doc)).toEqual(target)
  })

  it('runs with the given origin, so local undo tracking does not see it', () => {
    const doc = deckToYDoc(createDeck('A'))
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    replaceDeckContent(doc, createDeck('B'), 'server:restore')
    expect(origins).toEqual(['server:restore'])
  })

  it('refuses an invalid target and leaves the document alone', () => {
    const doc = deckToYDoc(createDeck('Keep'))
    const before = Y.encodeStateVector(doc)
    expect(() => replaceDeckContent(doc, { ...createDeck('x'), slides: 'nope' } as never, 'server:restore')).toThrow()
    expect(Y.encodeStateVector(doc)).toEqual(before)
  })

  it('a concurrent edit on another replica merges with the restore without losing the restore', () => {
    const a = deckToYDoc(createDeck('Shared'))
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    applyOps(b, [{ op: 'setTitle', title: 'typed by b' }], 'local')
    const target = { ...createDeck('Restored'), id: a.getMap('deck').get('id') as string, slides: [createSlide('blank', BUILT_IN_THEMES[0]!)] }
    replaceDeckContent(a, target, 'server:restore')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(yDocToDeck(a)).toEqual(yDocToDeck(b))
    expect(yDocToDeck(a).slides.map((s) => s.id)).toEqual([target.slides[0]!.id])
  })
})

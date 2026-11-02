import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createDeck, DeckSchema, deckToYDoc, getDeckMap, yDocToDeck } from './index.ts'
import { fullDeck } from './fixtures.ts'

describe('yjs binding', () => {
  it('round-trips createDeck through a Y.Doc', () => {
    const deck = createDeck('Round trip')
    expect(yDocToDeck(deckToYDoc(deck))).toEqual(deck)
  })

  it('round-trips a deck that uses every element type and rich-text mark', () => {
    const deck = fullDeck()
    const back = yDocToDeck(deckToYDoc(deck))
    expect(back).toEqual(deck)
    expect(back.slides[1]?.elements.map((e) => e.type)).toEqual([
      'text',
      'shape',
      'image',
      'chart',
      'diagram',
      'table',
      'code',
      'embed',
    ])
  })

  it('round-trips after the doc is re-encoded and applied to a fresh doc', () => {
    const deck = fullDeck()
    const src = deckToYDoc(deck)
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(src))
    expect(yDocToDeck(copy)).toEqual(deck)
  })

  it('stores nested element fields as Y.Maps and rich text as JSON', () => {
    const doc = deckToYDoc(fullDeck())
    const slides = getDeckMap(doc).get('slides') as Y.Array<Y.Map<unknown>>
    const elements = slides.get(1)?.get('elements') as Y.Array<Y.Map<unknown>>
    const text = elements.get(0)
    expect(text?.get('style')).toBeInstanceOf(Y.Map)
    expect(text?.get('content')).not.toBeInstanceOf(Y.Map)
    expect(text?.get('content')).toMatchObject({ type: 'doc' })
  })

  it('rejects an invalid deck before it reaches the doc', () => {
    const bad = { ...createDeck('x'), size: { w: 1280, h: 720 } }
    expect(() => deckToYDoc(bad as never)).toThrow()
  })

  it('yDocToDeck throws on an empty doc', () => {
    expect(() => yDocToDeck(new Y.Doc())).toThrow()
  })

  it('DeckSchema accepts the fixture deck', () => {
    expect(DeckSchema.safeParse(fullDeck()).success).toBe(true)
  })
})

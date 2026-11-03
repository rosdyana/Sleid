import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createDeck, DeckSchema, deckToYDoc, getDeckMap, yDocToDeck, type Deck, type Element } from './index.ts'
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
    const deck = fullDeck()
    const doc = deckToYDoc(deck)
    const slides = getDeckMap(doc).get('slides') as Y.Map<Y.Map<unknown>>
    const elements = slides.get(deck.slides[1]!.id)?.get('elements') as Y.Array<Y.Map<unknown>>
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

// M10. One element of each new kind, using every new field, so the round trip covers all of them.
function m10Deck(): Deck {
  const deck = fullDeck()
  const box = { rotation: 0, locked: false, opacity: 1 }
  const m10: Element[] = [
    {
      ...box,
      id: 'm10-text',
      type: 'text',
      x: 10,
      y: 10,
      w: 800,
      h: 200,
      z: 90,
      animateKey: 'title-key',
      animation: { effect: 'wipe', order: 1 },
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: [{ type: 'textStyle', attrs: { fontWeight: 600, letterSpacing: '0.14em' } }] }] }] },
      style: { align: 'left', valign: 'top', fontWeight: 700, letterSpacing: -0.02, textTransform: 'uppercase' },
      shadow: { x: 1, y: 2, blur: 3, color: '#000000' },
    },
    {
      ...box,
      id: 'm10-shape',
      type: 'shape',
      x: 10,
      y: 220,
      w: 400,
      h: 300,
      z: 91,
      animation: { effect: 'fade-out', order: 2 },
      shape: 'roundRect',
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: 2,
      radius: 20,
      strokeDash: 'dashed',
      gradient: {
        type: 'linear',
        angle: 45,
        stops: [
          { color: '#000000', at: 0 },
          { color: '#ffffff', at: 1 },
        ],
      },
      shadow: { x: 0, y: 4, blur: 10, spread: 1, color: 'rgba(0,0,0,0.2)' },
    },
    {
      ...box,
      id: 'm10-image',
      type: 'image',
      x: 500,
      y: 220,
      w: 400,
      h: 300,
      z: 92,
      src: 'https://example.com/photo.png',
      fit: 'cover',
      radius: 40,
      shadow: { x: 0, y: 6, blur: 12, color: '#000000' },
    },
    {
      ...box,
      id: 'm10-vector',
      type: 'vector',
      x: 950,
      y: 220,
      w: 200,
      h: 200,
      z: 93,
      viewBox: { x: 0, y: 0, w: 24, h: 24 },
      paths: [
        { d: 'M0 0L24 24', fill: '#112233', stroke: 'none', strokeWidth: 0, lineCap: 'round', lineJoin: 'bevel', opacity: 0.5 },
        { d: 'M2 2h20v20H2z', fill: 'none', stroke: '#ff0000', strokeWidth: 2 },
      ],
      preserveAspectRatio: false,
    },
  ]
  const slides = deck.slides.map((s, i) => (i === 1 ? { ...s, elements: [...s.elements, ...m10] } : s))
  return { ...deck, theme: { ...deck.theme, fontImports: ['Inter:wght@400;600;700', 'Playfair Display'] }, slides }
}

describe('yjs binding: M10 fields', () => {
  it('round-trips every M10 field (typography, radius, dash, gradient, shadows, animateKey, vector, fonts)', () => {
    const deck = DeckSchema.parse(m10Deck())
    const back = yDocToDeck(deckToYDoc(deck))
    expect(back).toEqual(deck)
    const els = back.slides[1]!.elements
    expect(els.find((e) => e.id === 'm10-text')).toMatchObject({ animateKey: 'title-key', animation: { effect: 'wipe' } })
    expect(els.find((e) => e.id === 'm10-shape')).toMatchObject({ radius: 20, strokeDash: 'dashed', gradient: { angle: 45 } })
    expect(els.find((e) => e.id === 'm10-vector')).toMatchObject({ type: 'vector', preserveAspectRatio: false })
    expect(back.theme.fontImports).toEqual(['Inter:wght@400;600;700', 'Playfair Display'])
  })

  it('stores a gradient as a nested Y.Map, and its stops as a plain array value', () => {
    const doc = deckToYDoc(DeckSchema.parse(m10Deck()))
    const slides = getDeckMap(doc).get('slides') as Y.Map<Y.Map<unknown>>
    const deck = yDocToDeck(doc)
    const elements = slides.get(deck.slides[1]!.id)?.get('elements') as Y.Array<Y.Map<unknown>>
    const shape = elements.toArray().find((m) => m.get('id') === 'm10-shape')
    expect(shape?.get('gradient')).toBeInstanceOf(Y.Map)
    expect(Array.isArray((shape?.get('gradient') as Y.Map<unknown>).get('stops'))).toBe(true)
  })
})

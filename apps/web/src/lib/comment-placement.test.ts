import { describe, expect, it } from 'vitest'
import { createDeck, createSlide, BUILT_IN_THEMES, type Deck } from '@sleid/model'
import { anchorFor, announceThreadChange } from './comment-placement'

function deckWithElement(): { deck: Deck; slideId: string; elementId: string } {
  const slide = createSlide('blank', BUILT_IN_THEMES[0]!)
  const element = {
    id: 'el-1',
    type: 'shape' as const,
    x: 100,
    y: 200,
    w: 300,
    h: 120,
    rotation: 0,
    z: 1,
    locked: false,
    opacity: 1,
    shape: 'rect' as const,
    fill: '#ffffff',
    stroke: '#000000',
    strokeWidth: 1,
  }
  return { deck: { ...createDeck('Deck'), slides: [{ ...slide, id: 'slide-a', elements: [element] }] }, slideId: 'slide-a', elementId: 'el-1' }
}

describe('comment placement', () => {
  it('pins an element comment to the top-right corner of the element', () => {
    const { deck, slideId, elementId } = deckWithElement()
    expect(anchorFor(deck, slideId, elementId, null)).toEqual({ elementId, anchor: { x: 400, y: 200 } })
  })

  it('pins a slide comment to the centre, unless an anchor is given', () => {
    const { deck, slideId } = deckWithElement()
    expect(anchorFor(deck, slideId, null, null)).toEqual({ elementId: null, anchor: { x: 960, y: 540 } })
    expect(anchorFor(deck, slideId, null, { x: 10, y: 20 })).toEqual({ elementId: null, anchor: { x: 10, y: 20 } })
  })

  it('refuses a slide that is not in the deck, and an element that is not on that slide', () => {
    const { deck, slideId } = deckWithElement()
    expect(() => anchorFor(deck, 'nope', null, null)).toThrow('not in this deck')
    expect(() => anchorFor(deck, slideId, 'missing', null)).toThrow('not on this slide')
  })

  it('announces a changed thread to the collab service as a comments message', async () => {
    const sent: Array<{ deckId: string; payload: Record<string, unknown> }> = []
    await announceThreadChange({ broadcast: async (deckId, payload) => (sent.push({ deckId, payload }), { delivered: 1 }) }, 'deck-1', 'thread-9')
    expect(sent).toEqual([{ deckId: 'deck-1', payload: { channel: 'comments', type: 'comments', threadId: 'thread-9' } }])
  })

  it('does not throw when the announcement fails (the write still stands)', async () => {
    await expect(announceThreadChange({ broadcast: async () => Promise.reject(new Error('down')) }, 'deck-1', 't')).resolves.toBeUndefined()
  })
})

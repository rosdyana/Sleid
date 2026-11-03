import { describe, expect, it } from 'vitest'
import { fullDeck } from './fixtures.ts'
import { DeckImportError, jsonToDeck } from './import-json.ts'
import { DeckSchema, type Deck } from './schema.ts'

describe('jsonToDeck', () => {
  it('imports a native export with fresh ids everywhere, and keeps the content', () => {
    const source = fullDeck()
    const out = jsonToDeck(JSON.stringify(source))
    expect(DeckSchema.safeParse(out).success).toBe(true)
    expect(out.id).not.toBe(source.id)
    expect(out.slides).toHaveLength(source.slides.length)
    const oldSlides = new Set(source.slides.map((s) => s.id))
    const oldElements = new Set(source.slides.flatMap((s) => s.elements.map((e) => e.id)))
    for (const slide of out.slides) {
      expect(oldSlides.has(slide.id)).toBe(false)
      for (const el of slide.elements) expect(oldElements.has(el.id)).toBe(false)
    }
    const ids = out.slides.flatMap((s) => s.elements.map((e) => e.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(out.slides.map((s) => s.elements.map((e) => e.type))).toEqual(source.slides.map((s) => s.elements.map((e) => e.type)))
    expect(out.slides.map((s) => s.notes)).toEqual(source.slides.map((s) => s.notes))
    expect(out.theme).toEqual(source.theme)
  })

  it('remaps section references and drops a reference to a missing section', () => {
    const source = fullDeck()
    const section = { id: 'sec-old', name: 'Intro' }
    const deck = {
      ...source,
      sections: [section],
      slides: source.slides.map((s, i) => ({ ...s, sectionId: i === 0 ? 'sec-old' : i === 1 ? 'missing' : undefined })),
    }
    const out = jsonToDeck(JSON.stringify(deck))
    expect(out.sections[0]!.id).not.toBe('sec-old')
    expect(out.slides[0]!.sectionId).toBe(out.sections[0]!.id)
    expect(out.slides[1]!.sectionId).toBeUndefined()
  })

  it('refuses text that is not JSON', () => {
    expect(() => jsonToDeck('not json at all')).toThrow(DeckImportError)
    expect(() => jsonToDeck('not json at all')).toThrow(/not valid JSON/)
  })

  it('refuses JSON that is not a deck, with the issues summarised', () => {
    expect(() => jsonToDeck(JSON.stringify({ hello: 'world' }))).toThrow(/not a Sleid deck: .*/)
    try {
      jsonToDeck(JSON.stringify({ hello: 'world' }))
    } catch (err) {
      expect((err as Error).message.split(';').length).toBeLessThanOrEqual(4)
    }
  })

  it('refuses a deck with a bad element', () => {
    const deck = fullDeck()
    const broken = { ...deck, slides: [{ ...deck.slides[0]!, elements: [{ type: 'text', id: 'x' }] }, ...deck.slides.slice(1)] }
    expect(() => jsonToDeck(JSON.stringify(broken))).toThrow(DeckImportError)
  })
})

describe('jsonToDeck: animateKey (M10)', () => {
  // A deck where a duplicated pair has been made: the copy keys off the source's old id.
  function pairDeck(): Deck {
    const deck = fullDeck()
    const el = (id: string, animateKey?: string) => ({
      ...deck.slides[0]!.elements[0]!,
      id,
      animateKey,
    })
    const elements = [el('old-a'), el('old-b', 'old-a')]
    return { ...deck, slides: [{ ...deck.slides[0]!, elements }, ...deck.slides.slice(1)] } as Deck
  }

  it('keeps animateKey values and gives the referenced source the old id as its key', () => {
    const out = jsonToDeck(JSON.stringify(pairDeck()))
    const [source, copy] = out.slides[0]!.elements
    expect(copy!.animateKey).toBe('old-a')
    expect(source!.animateKey).toBe('old-a')
    expect(source!.id).not.toBe('old-a')
    expect(copy!.id).not.toBe('old-b')
  })

  it('leaves elements with no key alone when nothing refers to them', () => {
    const out = jsonToDeck(JSON.stringify(fullDeck()))
    for (const slide of out.slides) for (const el of slide.elements) expect(el.animateKey).toBeUndefined()
  })

  it('does not change a source that already has its own key', () => {
    const deck = pairDeck()
    const els = deck.slides[0]!.elements
    els[0] = { ...els[0]!, animateKey: 'own-key' }
    const out = jsonToDeck(JSON.stringify(deck))
    const [source, copy] = out.slides[0]!.elements
    expect(source!.animateKey).toBe('own-key')
    expect(copy!.animateKey).toBe('old-a')
  })
})

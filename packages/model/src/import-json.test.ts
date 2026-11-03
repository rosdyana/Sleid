import { describe, expect, it } from 'vitest'
import { fullDeck } from './fixtures.ts'
import { DeckImportError, jsonToDeck } from './import-json.ts'
import { DeckSchema } from './schema.ts'

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

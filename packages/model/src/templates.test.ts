import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BUILT_IN_THEMES } from './defaults.ts'
import { applyOps } from './ops.ts'
import { deckToYDoc, yDocToDeck } from './ydoc.ts'
import {
  BUILT_IN_TEMPLATES,
  builtInTemplateDeck,
  deckFromBuiltInTemplate,
  isBuiltInTemplateId,
} from './templates.ts'
import { DeckSchema } from './schema.ts'

describe('built-in templates', () => {
  it('ships five templates with 4 to 6 slides, each on a built-in theme', () => {
    expect(BUILT_IN_TEMPLATES).toHaveLength(5)
    const themeNames = new Set(BUILT_IN_THEMES.map((t) => t.name))
    for (const info of BUILT_IN_TEMPLATES) {
      expect(info.slideCount).toBeGreaterThanOrEqual(4)
      expect(info.slideCount).toBeLessThanOrEqual(6)
      expect(themeNames.has(info.themeName)).toBe(true)
      expect(info.id.startsWith('builtin:')).toBe(true)
      expect(isBuiltInTemplateId(info.id)).toBe(true)
    }
  })

  it('every template parses as a deck, with unique slide and element ids', () => {
    for (const info of BUILT_IN_TEMPLATES) {
      const deck = builtInTemplateDeck(info.id)!
      expect(() => DeckSchema.parse(deck)).not.toThrow()
      const slideIds = deck.slides.map((s) => s.id)
      expect(new Set(slideIds).size).toBe(slideIds.length)
      const elementIds = deck.slides.flatMap((s) => s.elements.map((e) => e.id))
      expect(new Set(elementIds).size).toBe(elementIds.length)
      expect(deck.theme.name).toBe(info.themeName)
    }
  })

  it('uses charts and diagrams where they fit (pitch, quarterly review, lesson and kickoff)', () => {
    const kinds = (id: string) => builtInTemplateDeck(id)!.slides.flatMap((s) => s.elements.map((e) => e.type))
    expect(kinds('builtin:pitch')).toEqual(expect.arrayContaining(['chart', 'diagram']))
    expect(kinds('builtin:quarterly-review')).toEqual(expect.arrayContaining(['chart', 'table']))
    expect(kinds('builtin:lesson')).toEqual(expect.arrayContaining(['diagram']))
    expect(kinds('builtin:project-kickoff')).toEqual(expect.arrayContaining(['table', 'diagram']))
  })

  it('returns no deck for an unknown template id', () => {
    expect(builtInTemplateDeck('builtin:nope')).toBeNull()
    expect(deckFromBuiltInTemplate('builtin:nope')).toBeNull()
  })

  it('a deck from a template has fresh ids and no brand reference, and two copies never share ids', () => {
    const a = deckFromBuiltInTemplate('builtin:pitch', 'My pitch')!
    const b = deckFromBuiltInTemplate('builtin:pitch')!
    const template = builtInTemplateDeck('builtin:pitch')!
    expect(a.title).toBe('My pitch')
    expect(a.brand).toBeUndefined()
    const templateSlideIds = new Set(template.slides.map((s) => s.id))
    for (const slide of a.slides) expect(templateSlideIds.has(slide.id)).toBe(false)
    const aIds = new Set(a.slides.flatMap((s) => [s.id, ...s.elements.map((e) => e.id)]))
    for (const slide of b.slides) {
      expect(aIds.has(slide.id)).toBe(false)
      for (const el of slide.elements) expect(aIds.has(el.id)).toBe(false)
    }
  })

  it('a template deck survives the Yjs round trip', () => {
    const deck = deckFromBuiltInTemplate('builtin:lesson')!
    const doc = deckToYDoc(deck)
    expect(yDocToDeck(doc)).toEqual(DeckSchema.parse(deck))
  })

  it('template decks do not mutate the stored copy', () => {
    const first = builtInTemplateDeck('builtin:minimal')!
    first.title = 'changed'
    first.slides.length = 0
    expect(builtInTemplateDeck('builtin:minimal')!.title).toBe('Minimal')
    expect(builtInTemplateDeck('builtin:minimal')!.slides.length).toBeGreaterThan(0)
  })
})

describe('setBrandKit op', () => {
  const kitTheme = {
    name: 'Acme',
    colors: {
      background: '#ffffff',
      surface: '#f0f4ff',
      text: '#102030',
      muted: '#556677',
      accent: '#0055cc',
      accent2: '#00aa66',
      accent3: '#dd7700',
      accent4: '#8844aa',
    },
    fonts: { heading: 'Georgia, serif', body: 'Helvetica, sans-serif', mono: 'Menlo, monospace' },
    sizes: { title: 120, heading: 72, body: 40, small: 28 },
    radius: 4,
    backgroundStyle: 'solid',
  }
  const placement = { corner: 'br', widthPct: 12, margin: 40, slides: 'all-but-title' }
  const logo = { src: '/api/assets/0f9f9d8e-1111-4222-8333-444455556666', placement }

  it('applying a kit replaces the theme, records the kit and the resolved logo', () => {
    const doc = deckToYDoc(deckFromBuiltInTemplate('builtin:pitch')!)
    applyOps(doc, [{ op: 'setBrandKit', brandKitId: 'kit-1', theme: kitTheme, logo }])
    const deck = yDocToDeck(doc)
    expect(deck.theme).toEqual(kitTheme)
    expect(deck.brand).toEqual({
      brandKitId: 'kit-1',
      palette: kitTheme.colors,
      fonts: { heading: kitTheme.fonts.heading, body: kitTheme.fonts.body },
      logo,
    })
  })

  it('a kit without a logo records only the kit id', () => {
    const doc = deckToYDoc(deckFromBuiltInTemplate('builtin:pitch')!)
    applyOps(doc, [{ op: 'setBrandKit', brandKitId: 'kit-1', theme: kitTheme }])
    expect(yDocToDeck(doc).brand).toEqual({
      brandKitId: 'kit-1',
      palette: kitTheme.colors,
      fonts: { heading: kitTheme.fonts.heading, body: kitTheme.fonts.body },
    })
  })

  it('removing the kit keeps the theme and clears the logo', () => {
    const doc = deckToYDoc(deckFromBuiltInTemplate('builtin:pitch')!)
    applyOps(doc, [{ op: 'setBrandKit', brandKitId: 'kit-1', theme: kitTheme, logo }])
    applyOps(doc, [{ op: 'setBrandKit', brandKitId: null }])
    const deck = yDocToDeck(doc)
    expect(deck.brand).toBeUndefined()
    expect(deck.theme).toEqual(kitTheme)
  })

  it('a removal that carries a theme is refused, and nothing changes', () => {
    const doc = deckToYDoc(deckFromBuiltInTemplate('builtin:pitch')!)
    applyOps(doc, [{ op: 'setBrandKit', brandKitId: 'kit-1', theme: kitTheme, logo }])
    const before = Y.encodeStateVector(doc)
    expect(() => applyOps(doc, [{ op: 'setBrandKit', brandKitId: null, theme: kitTheme }])).toThrow(/theme cannot be set/)
    expect(Y.encodeStateVector(doc)).toEqual(before)
    expect(yDocToDeck(doc).brand?.brandKitId).toBe('kit-1')
  })

  it('a logo that is neither an asset URL nor an image data URL is refused', () => {
    const doc = deckToYDoc(deckFromBuiltInTemplate('builtin:pitch')!)
    expect(() =>
      applyOps(doc, [{ op: 'setBrandKit', brandKitId: 'kit-1', theme: kitTheme, logo: { src: 'https://evil.example/x.png', placement } }]),
    ).toThrow()
  })

  it('a placement outside the allowed ranges is refused', () => {
    const doc = deckToYDoc(deckFromBuiltInTemplate('builtin:pitch')!)
    expect(() =>
      applyOps(doc, [{ op: 'setBrandKit', brandKitId: 'kit-1', theme: kitTheme, logo: { src: logo.src, placement: { ...placement, widthPct: 90 } } }]),
    ).toThrow()
  })

  it('a kit id with no theme is refused', () => {
    const doc = deckToYDoc(deckFromBuiltInTemplate('builtin:pitch')!)
    expect(() => applyOps(doc, [{ op: 'setBrandKit', brandKitId: 'kit-1' }])).toThrow(/needs its theme/)
  })
})

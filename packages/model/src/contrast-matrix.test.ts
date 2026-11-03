// Every built-in theme × every layout × light and dark, built through the real op path. Each text element must read
// against every background stop of its slide. A slide's background is its own background when it has one (a gradient
// counts every stop), otherwise the theme's background.
import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, createDeck } from './defaults.ts'
import { contrastRatio, TEXT_MIN_CONTRAST } from './contrast.ts'
import { applyOps } from './ops.ts'
import { gradientStops } from './tokens.ts'
import { SLIDE_LAYOUTS, type Slide, type Theme } from './schema.ts'
import { deckToYDoc, yDocToDeck } from './ydoc.ts'

function backgroundsOf(slide: Slide, theme: Theme): string[] {
  const bg = slide.background
  if (!bg) return [theme.colors.background]
  if (bg.type === 'color') return [bg.value]
  if (bg.type === 'gradient') {
    const stops = gradientStops(bg.value)
    expect(stops.length, `no colour stops in ${bg.value}`).toBeGreaterThan(0)
    return stops
  }
  throw new Error('image backgrounds are not checked by this matrix')
}

// Returns each text element that fails, with its colour and background, so one failing case reads clearly.
function unreadable(slide: Slide, theme: Theme): string[] {
  const backgrounds = backgroundsOf(slide, theme)
  const failures: string[] = []
  for (const el of slide.elements) {
    if (el.type !== 'text') continue
    const color = el.style.color ?? theme.colors.text
    for (const bg of backgrounds) {
      const ratio = contrastRatio(color, bg)
      if (ratio < TEXT_MIN_CONTRAST) failures.push(`${el.id} (${el.role ?? 'text'}) ${color} on ${bg} is ${ratio.toFixed(2)}:1`)
    }
  }
  return failures
}

// The deck as the editor builds it: createDeck, the theme set through setTheme, then a slide added through addSlide.
function deckWithSlide(theme: Theme, layout: (typeof SLIDE_LAYOUTS)[number], variant: 'light' | 'dark') {
  const doc = deckToYDoc(createDeck('Matrix'))
  applyOps(doc, [{ op: 'setTheme', theme }])
  applyOps(doc, [{ op: 'addSlide', layout, slide: { variant } }])
  const deck = yDocToDeck(doc)
  return { deck, slide: deck.slides.at(-1)!, theme: deck.theme }
}

describe('contrast matrix: built-in themes × layouts × variants', () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const layout of SLIDE_LAYOUTS) {
      for (const variant of ['light', 'dark'] as const) {
        it(`${theme.name} × ${layout} × ${variant}`, () => {
          const { slide, theme: built } = deckWithSlide(theme, layout, variant)
          expect(slide.variant).toBe(variant)
          expect(unreadable(slide, built)).toEqual([])
        })
      }
    }
  }

  for (const theme of BUILT_IN_THEMES) {
    it(`${theme.name} × original title slide`, () => {
      const doc = deckToYDoc(createDeck('Matrix'))
      applyOps(doc, [{ op: 'setTheme', theme }])
      const deck = yDocToDeck(doc)
      const title = deck.slides[0]!
      expect(title.layout).toBe('title')
      expect(unreadable(title, deck.theme)).toEqual([])
    })
  }
})

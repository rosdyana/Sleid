import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES } from '@sleid/model'
import { contrastRatio, contrastViolations, enforceThemeContrast, ensureContrast, parseHex, toHex } from './contrast.ts'

describe('contrast', () => {
  it('computes WCAG ratios at the extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(contrastRatio('#000000', '#ffffff'), 10)
  })

  it('parses short and long hex and rejects others', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(toHex(parseHex('#1A73E8'))).toBe('#1a73e8')
    expect(() => parseHex('blue')).toThrow()
  })

  it('moves a light grey text colour until it reaches 4.5:1 on white, keeping its hue', () => {
    const fixed = ensureContrast('#999999', '#ffffff', 4.5)
    expect(contrastRatio(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    // Greys stay grey: the channels are still equal.
    const { r, g, b } = parseHex(fixed)
    expect(r).toBe(g)
    expect(g).toBe(b)
  })

  it('finds a passing shade near the original colour, and falls back to black or white only when none exists', () => {
    // White on white: the nearest grey that passes 4.5:1 is darker than white, and still grey.
    const grey = ensureContrast('#ffffff', '#ffffff', 4.5)
    expect(contrastRatio(grey, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(parseHex(grey).r).toBe(parseHex(grey).b)
    // Mid grey on mid grey: the nearest passing shade is near-black, and it passes.
    expect(contrastRatio(ensureContrast('#777777', '#777777', 4.5), '#777777')).toBeGreaterThanOrEqual(4.5)
    // A saturated colour that no shade can fix falls back to black or white.
    expect(ensureContrast('#ff0000', '#ff0000', 21)).toMatch(/^#(000000|ffffff)$/)
  })

  it('leaves a colour alone when it already passes', () => {
    expect(ensureContrast('#202124', '#ffffff', 4.5)).toBe('#202124')
  })

  it('enforces text 4.5:1 and accents 3:1 on a theme and reports what changed', () => {
    const { colors, adjusted } = enforceThemeContrast({
      background: '#ffffff',
      surface: '#f8f9fa',
      text: '#bbbbbb',
      muted: '#cccccc',
      accent: '#f5f5f5',
      accent2: '#188038',
      accent3: '#e37400',
      accent4: '#a142f4',
    })
    expect(contrastViolations(colors)).toEqual([])
    expect(adjusted.some((line) => line.startsWith('text '))).toBe(true)
    expect(adjusted.some((line) => line.startsWith('accent '))).toBe(true)
  })

  it('leaves the built-in themes alone, except one known accent in Warm Paper', () => {
    // Finding: Warm Paper's accent3 (#c9962b) is below 3:1 on its background. The built-in theme is
    // not changed here (the rule applies to AI-generated themes), and docs/DESIGN.md records it.
    const found: string[] = []
    for (const theme of BUILT_IN_THEMES) {
      const { adjusted } = enforceThemeContrast(theme.colors)
      for (const line of adjusted) found.push(`${theme.name}: ${line.split(' ')[0]}`)
    }
    expect(found).toEqual(['Warm Paper: accent3'])
  })
})

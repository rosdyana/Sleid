import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, DEFAULT_THEME, contrastRatio, deriveDarkVariant, gradientStops, mixHex, resolveTokens, type Theme } from './index.ts'

describe('resolveTokens', () => {
  it('fills every component token from the theme when the theme has none', () => {
    const t = resolveTokens(DEFAULT_THEME)
    expect(t.label).toEqual({ size: 24, weight: 650, letterSpacing: 0.14, textTransform: 'uppercase', color: DEFAULT_THEME.colors.accent })
    expect(t.heading).toEqual({ size: DEFAULT_THEME.sizes.heading, weight: 700, letterSpacing: -0.02, lineHeight: 1.12 })
    expect(t.subtitle).toEqual({ size: 38, weight: 500, color: DEFAULT_THEME.colors.muted })
    expect(t.body).toEqual({ size: DEFAULT_THEME.sizes.body, lineHeight: 1.35 })
    expect(t.small).toEqual({ size: DEFAULT_THEME.sizes.small })
    expect(t.card.fill).toBe(DEFAULT_THEME.colors.surface)
    expect(t.card.radius).toBe(DEFAULT_THEME.radius)
    expect(t.card.shadow).toEqual({ x: 0, y: 10, blur: 29, color: 'rgba(40,38,30,0.06)' })
    expect(t.tileTint).toBe(0.14)
    expect(t.margin).toEqual({ x: 106, y: 82 })
    expect(t.gap).toBe(32)
    expect(t.motion).toEqual({ effect: 'fade-up', stagger: true })
    expect(t.chrome).toEqual({})
  })

  it('takes the card stroke as text mixed 12% into the background', () => {
    const t = resolveTokens(DEFAULT_THEME)
    expect(t.card.stroke).toBe(mixHex(DEFAULT_THEME.colors.text, DEFAULT_THEME.colors.background, 0.88))
    expect(contrastRatio(t.card.stroke, DEFAULT_THEME.colors.background)).toBeGreaterThan(1)
  })

  it('lets theme.components override each field, and keeps the others', () => {
    const theme: Theme = {
      ...DEFAULT_THEME,
      components: {
        label: { size: 30 },
        heading: { weight: 800 },
        motion: { effect: 'zoom-in' },
        gap: 12,
      },
    }
    const t = resolveTokens(theme)
    expect(t.label).toEqual({ size: 30, weight: 650, letterSpacing: 0.14, textTransform: 'uppercase', color: DEFAULT_THEME.colors.accent })
    expect(t.heading.weight).toBe(800)
    expect(t.heading.size).toBe(DEFAULT_THEME.sizes.heading)
    expect(t.motion).toEqual({ effect: 'zoom-in', stagger: true })
    expect(t.gap).toBe(12)
  })

  it('resolves a built-in theme with components (Paper Navy) to its own values', () => {
    const navy = BUILT_IN_THEMES.find((x) => x.name === 'Paper Navy')!
    const t = resolveTokens(navy)
    expect(t.label).toMatchObject({ size: 22, color: '#2d62c9', textTransform: 'uppercase' })
    expect(t.heading.size).toBe(65)
    expect(t.subtitle).toMatchObject({ size: 32, color: '#6c6a64' })
    expect(t.card).toMatchObject({ fill: '#fdfdfc', stroke: '#e6e4df', radius: 22 })
  })
})

describe('deriveDarkVariant', () => {
  it('returns the theme dark variant when it has one', () => {
    const midnight = BUILT_IN_THEMES.find((x) => x.name === 'Midnight')!
    expect(deriveDarkVariant(midnight)).toBe(midnight.dark)
  })

  it('uses the surface as the background for a theme that is dark without a variant of its own', () => {
    // DEFAULT_THEME has its own dark variant, so it is left out here.
    const { dark: _dark, ...plain } = DEFAULT_THEME
    const dark: Theme = { ...plain, colors: { ...plain.colors, background: '#0a0a14', surface: '#15151f', text: '#eeeeee', muted: '#aaaaaa' } }
    const d = deriveDarkVariant(dark)
    expect(d.background).toEqual({ type: 'color', value: '#15151f' })
    expect(d.text).toBe('#eeeeee')
    expect(d.muted).toBe('#aaaaaa')
  })

  it('falls back to the navy default for a light theme without a variant, lifting the accent to read on navy', () => {
    const { dark: _dark, ...plain } = DEFAULT_THEME
    const d = deriveDarkVariant(plain)
    expect(d.background).toMatchObject({ type: 'gradient' })
    expect(d.text).toBe('#f5f7fa')
    expect(d.muted).toBe('#b4bccb')
    expect(contrastRatio(d.accent, '#1b2a47')).toBeGreaterThanOrEqual(3)
  })
})

describe('mixHex and gradientStops', () => {
  it('mixes two hex colours: t 0 is the first, t 1 is the second', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('finds the hex colours of a radial gradient, in order', () => {
    expect(gradientStops('radial-gradient(ellipse at 75% 40%, #2a4170 0%, #1b2a47 55%, #16223b 100%)')).toEqual(['#2a4170', '#1b2a47', '#16223b'])
  })

  it('expands short hex, reads rgb() and drops alpha', () => {
    expect(gradientStops('linear-gradient(90deg, #fff 0%, rgba(0, 0, 0, 0.5) 100%)')).toEqual(['#ffffff', '#000000'])
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Deck, ThemeSchema } from '@sleid/model'
import { deriveStyle, themeFromStyle } from './style.ts'

const KOMPAST_PATH = new URL('../../../apps/web/src/lib/mcp/fixtures/kompast.sleid.json', import.meta.url)
const kompast = JSON.parse(readFileSync(KOMPAST_PATH, 'utf8')) as Deck

describe('deriveStyle on the Kompast fixture', () => {
  const style = deriveStyle(kompast)

  it('finds the heading: 64.8px, weight 700', () => {
    expect(style.typeScale.heading?.size).toBeCloseTo(64.8, 1)
    expect(style.typeScale.heading?.weight).toBe(700)
  })

  it('finds the label: uppercase, #2d62c9', () => {
    expect(style.typeScale.label?.textTransform).toBe('uppercase')
    expect(style.typeScale.label?.color).toBe('#2d62c9')
  })

  it('finds a subtitle under the heading, smaller than it', () => {
    expect(style.typeScale.subtitle?.size).toBeCloseTo(32.4, 1)
    expect(style.typeScale.subtitle!.size).toBeLessThan(style.typeScale.heading!.size)
  })

  it('finds the dark background as a radial gradient containing #1b2a47', () => {
    expect(style.darkVariant?.background.type).toBe('gradient')
    expect(style.darkVariant?.background.value).toContain('radial-gradient')
    expect(style.darkVariant?.background.value).toContain('#1b2a47')
    expect(style.darkVariant?.text).toBeDefined()
    expect(style.darkVariant?.accent).toBe('#8fb0f0')
  })

  it('finds the card: radius 21.6, fill #fdfdfc, stroke #e6e4df', () => {
    expect(style.card?.radius).toBeCloseTo(21.6, 1)
    expect(style.card?.fill).toBe('#fdfdfc')
    expect(style.card?.stroke).toBe('#e6e4df')
  })

  it('finds the margins from the headings and labels', () => {
    expect(style.margins.x).toBeCloseTo(105.6, 1)
    expect(style.margins.y).toBeCloseTo(81.6, 1)
  })

  it('finds the recurring elements: the logo (on 18 slides, with light and dark variants) and the footer', () => {
    const logo = style.recurring.find((r) => r.role === 'logo')
    expect(logo).toBeDefined()
    expect(logo!.type).toBe('image')
    expect(logo!.slides).toBeGreaterThanOrEqual(12)
    expect(logo!.variants?.light).toBeDefined()
    expect(logo!.variants?.dark).toBeDefined()
    expect(logo!.variants!.light).not.toBe(logo!.variants!.dark)
    const footer = style.recurring.find((r) => r.role === 'footer')
    expect(footer?.text).toContain('Confidential')
  })

  it('guesses an archetype for every slide', () => {
    expect(style.archetypes).toHaveLength(kompast.slides.length)
    expect(style.archetypes[0]!.archetype).toBe('cover')
    expect(style.archetypes[15]!.archetype).toBe('timeline')
    expect(style.archetypes[17]!.archetype).toBe('ask')
  })
})

describe('themeFromStyle', () => {
  it('writes the style into components and produces a valid theme', () => {
    const theme = themeFromStyle(deriveStyle(kompast))
    expect(ThemeSchema.safeParse(theme).success).toBe(true)
    expect(theme.components?.heading?.size).toBeCloseTo(64.8, 1)
    expect(theme.components?.heading?.weight).toBe(700)
    expect(theme.components?.label?.color).toBe('#2d62c9')
    expect(theme.components?.card?.radius).toBeCloseTo(21.6, 1)
    expect(theme.components?.margin?.x).toBeCloseTo(105.6, 1)
    expect(theme.components?.motion?.effect).toBeDefined()
  })

  it('takes the dark variant from the inferred style', () => {
    const theme = themeFromStyle(deriveStyle(kompast))
    expect(theme.dark?.background.type).toBe('gradient')
    expect(theme.dark?.background.value).toContain('#1b2a47')
    expect(theme.dark?.accent).toBe('#8fb0f0')
  })

  it('records the chrome: the logo light and dark sources, its box, and the footer text and box', () => {
    const theme = themeFromStyle(deriveStyle(kompast))
    const chrome = theme.components?.chrome
    expect(chrome?.logoLight).toBeDefined()
    expect(chrome?.logoDark).toBeDefined()
    expect(chrome?.logoBox?.w).toBeCloseTo(104.5, 1)
    expect(chrome?.footerText).toContain('Confidential')
    expect(chrome?.footerBox).toBeDefined()
  })
})

// Brand kit tokens (M9): the palette, fonts and optional sizes a kit contributes.
// A kit's tokens become a full Theme (themeFromBrandTokens). Logo and placement
// are stored separately, on the brand kit and, once applied, on the deck.
import { z } from 'zod'
import { BUILT_IN_THEMES } from './defaults.ts'
import type { BrandRef, Deck, Slide, Theme } from './schema.ts'

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
// A CSS font family list made of plain names: letters, digits, spaces, hyphens and commas.
// Anything else (quotes, braces, semicolons) is refused, so a kit can never inject CSS.
const FONT_STACK = /^[A-Za-z0-9 ,-]+$/

const Hex = z.string().regex(HEX_COLOR, 'colours must be six-digit hex, for example #1a2b3c')
const FontStack = z
  .string()
  .min(1)
  .max(160)
  .regex(FONT_STACK, 'font names may contain letters, digits, spaces, hyphens and commas only')

export const BrandPaletteSchema = z.object({
  background: Hex,
  surface: Hex,
  text: Hex,
  muted: Hex,
  accent: Hex,
  accent2: Hex,
  accent3: Hex,
  accent4: Hex,
})
export type BrandPalette = z.infer<typeof BrandPaletteSchema>

export const BrandTokensSchema = z.object({
  palette: BrandPaletteSchema,
  fonts: z.object({
    heading: FontStack,
    body: FontStack,
    mono: FontStack.optional(),
  }),
  sizes: z
    .object({
      title: z.number().positive().max(400),
      heading: z.number().positive().max(400),
      body: z.number().positive().max(400),
      small: z.number().positive().max(400),
    })
    .partial()
    .optional(),
  radius: z.number().min(0).max(200).optional(),
  /** M11. Footer text the kit puts on its slides. */
  footerText: z.string().max(200).optional(),
})
export type BrandTokens = z.infer<typeof BrandTokensSchema>

const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/** The full theme a kit produces. Sizes and radius fall back to Sheets Light where the kit leaves them out. */
export function themeFromBrandTokens(name: string, tokens: BrandTokens): Theme {
  const base = BUILT_IN_THEMES[0]!
  return {
    name,
    colors: { ...tokens.palette },
    fonts: {
      heading: tokens.fonts.heading,
      body: tokens.fonts.body,
      mono: tokens.fonts.mono ?? MONO_FALLBACK,
    },
    sizes: { ...base.sizes, ...(tokens.sizes ?? {}) } as Theme['sizes'],
    radius: tokens.radius ?? base.radius,
    backgroundStyle: 'solid',
  }
}

/** The palette colours (lower-case), in a fixed order. Used by the AI constraint and by tests. */
export function brandPaletteColors(tokens: Pick<BrandTokens, 'palette'>): string[] {
  return Object.values(tokens.palette).map((c) => c.toLowerCase())
}

/** Whether the deck's brand logo is drawn on this slide, by the placement's `slides` rule. */
export function logoAppliesToSlide(slide: Slide, deck: Deck): boolean {
  return logoAppliesToBrand(slide, deck.brand)
}

/** The same rule, for callers that hold only the brand reference (the editor canvas). */
export function logoAppliesToBrand(slide: Slide, brand: BrandRef | undefined): boolean {
  const logo = brand?.logo
  if (!logo) return false
  switch (logo.placement.slides) {
    case 'all':
      return true
    case 'all-but-title':
      return slide.layout !== 'title'
    default:
      return false
  }
}

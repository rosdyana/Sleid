// The brand kit constraint for the AI (M9). When a deck has a brand kit, every proposal from an
// ability is post-processed here:
//   - a colour that is not in the kit palette and is not a neutral (black, white or a grey) is
//     snapped to the nearest palette colour;
//   - a font that is not the kit's heading or body font is replaced with the kit's font for that role
//     (titles and subtitles get the heading font, everything else the body font; mono text gets the body font);
// and each change is listed as a warning. The prompt also states the palette and fonts (see context.ts).
//
// The constraint reads deck.brand.palette and deck.brand.fonts, which are frozen when the kit is applied.
import type { Deck, Op } from '@sleid/model'

export interface BrandConstraint {
  /** Palette colours as lower-case #rrggbb, in the kit's order, without duplicates. */
  palette: string[]
  headingFont: string
  bodyFont: string
}

type Rgb = [number, number, number]

const HEX3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/
const HEX6 = /^#([0-9a-fA-F]{6})$/

/** Parses #rgb or #rrggbb. Anything else (names, rgb(), empty) is not a colour this module can judge. */
export function parseColour(value: string): Rgb | null {
  const short = HEX3.exec(value)
  if (short) return [parseInt(short[1]! + short[1], 16), parseInt(short[2]! + short[2], 16), parseInt(short[3]! + short[3], 16)]
  const long = HEX6.exec(value)
  if (long) {
    const n = parseInt(long[1]!, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return null
}

export function colourToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

/** Black, white and greys: the channels are within a few steps of each other. */
export function isNeutral([r, g, b]: Rgb): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12
}

/** Nearest palette colour by squared distance in RGB. Ties keep the palette's order. */
export function nearestPaletteColor(color: Rgb, palette: readonly string[]): string {
  let best = palette[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of palette) {
    const rgb = parseColour(candidate)!
    const d = (rgb[0] - color[0]) ** 2 + (rgb[1] - color[1]) ** 2 + (rgb[2] - color[2]) ** 2
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return best
}

/**
 * The colour a value must become, or null when it may stay. Only six- and three-digit hex strings are judged;
 * other values are left alone.
 */
export function snapColor(value: string, palette: readonly string[]): string | null {
  const rgb = parseColour(value)
  if (!rgb) return null
  const normal = colourToHex(rgb)
  if (palette.includes(normal)) return null
  if (isNeutral(rgb)) return null
  return nearestPaletteColor(rgb, palette)
}

/** The stack as a comparable list: lower-case family names, quotes and extra spaces removed. */
export function fontFamilies(stack: string): string {
  return stack
    .split(',')
    .map((part) => part.replace(/["']/g, '').trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(',')
}

/** The constraint for a deck, or null when the deck has no brand kit (or no palette recorded). */
export function brandConstraintFor(deck: Deck): BrandConstraint | null {
  const brand = deck.brand
  if (!brand?.palette) return null
  const seen = new Set<string>()
  const palette: string[] = []
  for (const value of Object.values(brand.palette)) {
    const rgb = parseColour(value)
    if (!rgb) continue
    const normal = colourToHex(rgb)
    if (!seen.has(normal)) {
      seen.add(normal)
      palette.push(normal)
    }
  }
  if (palette.length === 0) return null
  return {
    palette,
    headingFont: brand.fonts?.heading ?? deck.theme.fonts.heading,
    bodyFont: brand.fonts?.body ?? deck.theme.fonts.body,
  }
}

export interface ConstrainedOps {
  ops: Op[]
  warnings: string[]
}

type Json = unknown
type Role = string | undefined

/**
 * Applies the constraint to a list of ops. The ops are copied, not changed in place. Ids and the
 * shape of each op stay the same, so the result still passes applyOps.
 */
export function constrainOpsToBrand(ops: readonly Op[], constraint: BrandConstraint): ConstrainedOps {
  const warnings = new Set<string>()
  const colourFor = (value: string): string | null => {
    const next = snapColor(value, constraint.palette)
    if (next) warnings.add(`Colour ${value.toLowerCase()} was changed to the brand colour ${next}.`)
    return next
  }
  const fontFor = (value: string, role: Role, kind: 'heading' | 'body' | 'mono'): string | null => {
    const target = kind === 'heading' || role === 'title' || role === 'subtitle' ? constraint.headingFont : constraint.bodyFont
    if (fontFamilies(value) === fontFamilies(constraint.headingFont) || fontFamilies(value) === fontFamilies(constraint.bodyFont)) return null
    if (fontFamilies(value) === fontFamilies(target)) return null
    warnings.add(`Font "${value}" was replaced with the brand font "${target}".`)
    return target
  }

  // Walks a JSON value. `role` is the role of the nearest element (title, subtitle, body), used to choose
  // between the heading and body fonts. `themeFontKey` is set while inside a theme's `fonts` object.
  const walk = (value: Json, key: string | undefined, role: Role, inFonts: boolean): Json => {
    if (typeof value === 'string') {
      if (inFonts && key) {
        if (key === 'heading' || key === 'body' || key === 'mono') {
          const replaced = fontFor(value, role, key === 'heading' ? 'heading' : key === 'body' ? 'body' : 'mono')
          return replaced ?? value
        }
        return value
      }
      if (key === 'fontFamily') {
        const replaced = fontFor(value, role, 'body')
        return replaced ?? value
      }
      const colour = colourFor(value)
      return colour ?? value
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key, role, inFonts))
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const nextRole = typeof obj.role === 'string' ? obj.role : role
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) {
        // The `fonts` object of a theme: its keys are roles, not fonts to judge by context.
        out[k] = walk(v, k, nextRole, k === 'fonts' || (inFonts && key === 'fonts'))
      }
      return out
    }
    return value
  }

  const out = ops.map((op) => walk(structuredClone(op), undefined, undefined, false) as Op)
  return { ops: out, warnings: [...warnings] }
}

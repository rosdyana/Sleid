// Colour helpers. The model's contrast and mix functions take hex only; slides also use transparent and rgba() colours,
// so these helpers read those and say how opaque they are.
import { contrastRatio, ensureContrast, gradientStops, mixHex, parseHex, toHex } from '@sleid/model'

export interface ParsedColor {
  /** #rrggbb, with alpha dropped. */
  hex: string
  /** 0 (transparent) to 1 (opaque). */
  alpha: number
}

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba(), and 'transparent'. Other values (named colours) are undefined. */
export function parseColor(value: string): ParsedColor | undefined {
  const s = value.trim().toLowerCase()
  if (s === 'transparent' || s === 'none') return { hex: '#000000', alpha: 0 }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    let h = hex[1]!
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    const rgb = `#${h.slice(0, 6)}`
    const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return { hex: rgb, alpha }
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s)
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return undefined
    const nums = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (Number(p.slice(0, -1)) * 255) / 100 : Number(p)))
    if (nums.some((n) => !Number.isFinite(n))) return undefined
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3])
    if (!Number.isFinite(a)) return undefined
    return { hex: toHex({ r: nums[0]!, g: nums[1]!, b: nums[2]! }), alpha: Math.min(1, Math.max(0, a)) }
  }
  return undefined
}

/** The opaque-ish colours of a CSS gradient or colour string, in order. Transparent stops are returned with their alpha. */
export function colorsIn(value: string): ParsedColor[] {
  const out: ParsedColor[] = []
  const re = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])|rgba?\([^)]*\)|transparent/g
  for (const m of value.matchAll(re)) {
    const parsed = parseColor(m[0])
    if (parsed) out.push(parsed)
  }
  return out
}

/** The hex colours of a slide background CSS value, dropping transparent ones. Used for the 'every stop' background check. */
export function opaqueStops(value: string): string[] {
  const found = colorsIn(value).filter((c) => c.alpha >= 0.5).map((c) => c.hex)
  return found.length > 0 ? found : gradientStops(value)
}

/**
 * The colour from `candidates` (in the given order) with the lowest contrast against `text`.
 */
export function worstAgainst(text: string, candidates: string[]): string | undefined {
  let worst: { hex: string; ratio: number } | undefined
  for (const hex of candidates) {
    const ratio = contrastRatio(text, hex)
    if (!worst || ratio < worst.ratio) worst = { hex, ratio }
  }
  return worst?.hex
}

/**
 * A text or icon colour that reaches `min` contrast against every background in `backgrounds` (checked against the worst one).
 * A colour that is not hex is returned unchanged.
 */
export function ink(color: string, backgrounds: string[], min = 4.5): string {
  try {
    parseHex(color)
  } catch {
    return color
  }
  const bgs = backgrounds.filter((b) => {
    try {
      parseHex(b)
      return true
    } catch {
      return false
    }
  })
  const worst = worstAgainst(color, bgs)
  if (!worst) return color
  return ensureContrast(color, worst, min)
}

/**
 * A tint of `colour` mixed into `surface` by `amount` (0 keeps the surface, 1 is the colour). When the surface is not hex
 * (an rgba panel), the colour itself is returned with that alpha.
 */
export function tint(colour: string, surface: string, amount: number): string {
  try {
    return mixHex(surface, colour, amount)
  } catch {
    const c = parseColor(colour)
    if (!c) return colour
    const { r, g, b } = parseHex(c.hex)
    return `rgba(${r},${g},${b},${amount})`
  }
}

/** A colour with an alpha, from a hex colour. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

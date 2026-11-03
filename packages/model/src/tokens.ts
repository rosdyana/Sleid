// Resolved component tokens (M11), dark-slide colours, and the colour helpers they need.
//
// resolveTokens fills every component token from the theme, so a renderer never has to check for a missing value.
// deriveDarkVariant gives the colours for a 'dark' slide: the theme's own dark variant when it has one, otherwise a
// colour set derived from the light palette.
import { ensureContrast, parseHex, relativeLuminance, toHex } from './contrast.ts'
import { ANIMATION_EFFECTS, type ComponentTokens, type DarkVariant, type Shadow, type Theme } from './schema.ts'

/** Dark theme backgrounds are those under this relative luminance. */
const DARK_LUMINANCE = 0.2

// The navy default for a dark variant. Used by themes that have no dark variant of their own and whose
// background is light.
export const NAVY_GRADIENT = 'radial-gradient(ellipse at 75% 40%, #2a4170 0%, #1b2a47 55%, #16223b 100%)'
export const NAVY_TEXT = '#f5f7fa'
export const NAVY_MUTED = '#b4bccb'
export const NAVY_SURFACE = 'rgba(255,255,255,0.06)'
export const NAVY_STROKE = 'rgba(255,255,255,0.14)'
const NAVY_BASE = '#1b2a47'
const NAVY_FALLBACK_ACCENT = '#8ab4f8'

/** Every component token, with no optional fields. What a renderer reads. */
export interface ResolvedTokens {
  label: { size: number; weight: number; letterSpacing: number; textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize'; color: string }
  heading: { size: number; weight: number; letterSpacing: number; lineHeight: number }
  subtitle: { size: number; weight: number; color: string }
  body: { size: number; lineHeight: number }
  small: { size: number }
  card: { fill: string; stroke: string; strokeWidth: number; radius: number; shadow: Shadow }
  tileTint: number
  margin: { x: number; y: number }
  gap: number
  motion: { effect: (typeof ANIMATION_EFFECTS)[number]; stagger: boolean }
  chrome: NonNullable<ComponentTokens['chrome']>
}

/**
 * Mixes two hex colours. t = 0 gives `a`, t = 1 gives `b`. Throws when either is not a hex colour.
 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  })
}

/**
 * The colours of a CSS gradient string, as hex, in the order they appear. Hex colours (3, 6 or 8 digits) and
 * rgb()/rgba() colours are found. An alpha channel is dropped. Named colours are not found.
 */
export function gradientStops(value: string): string[] {
  const out: string[] = []
  const re = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])|rgba?\(([^)]*)\)/g
  for (const m of value.matchAll(re)) {
    if (m[1] !== undefined) {
      const parts = m[1].split(',').map((p) => Number(p.trim()))
      if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) continue
      out.push(toHex({ r: parts[0]!, g: parts[1]!, b: parts[2]! }))
      continue
    }
    const hex = m[0].slice(1)
    if (hex.length === 3) out.push(`#${[...hex].map((c) => c + c).join('')}`)
    else out.push(`#${hex.slice(0, 6)}`)
  }
  return out
}

function isDarkHex(hex: string): boolean {
  try {
    return relativeLuminance(hex) < DARK_LUMINANCE
  } catch {
    return false
  }
}

// A colour step that falls back to `fallback` when the input is not a hex colour, so a theme with unusual colour
// strings still resolves.
function tryColor(fn: () => string, fallback: string): string {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Fills every component token from the theme. A value in `theme.components` wins over the derived default, field by field. */
export function resolveTokens(theme: Theme): ResolvedTokens {
  const { colors, sizes, radius } = theme
  const o = theme.components ?? {}
  const pick = <T extends object>(base: T, over: object | undefined): T => {
    const out: Record<string, unknown> = { ...base } as Record<string, unknown>
    for (const [k, v] of Object.entries(over ?? {})) if (v !== undefined) out[k] = v
    return out as T
  }
  const cardStroke = tryColor(() => mixHex(colors.text, colors.background, 0.88), '#e5e5e5')

  return {
    label: pick(
      {
        size: Math.round(sizes.small * 0.86),
        weight: 650,
        letterSpacing: 0.14,
        textTransform: 'uppercase' as const,
        color: colors.accent,
      },
      o.label,
    ),
    heading: pick({ size: sizes.heading, weight: 700, letterSpacing: -0.02, lineHeight: 1.12 }, o.heading),
    subtitle: pick({ size: Math.round(sizes.body * 0.95), weight: 500, color: colors.muted }, o.subtitle),
    body: pick({ size: sizes.body, lineHeight: 1.35 }, o.body),
    small: pick({ size: sizes.small }, o.small),
    card: pick(
      {
        fill: colors.surface,
        stroke: cardStroke,
        strokeWidth: 1.2,
        radius,
        shadow: { x: 0, y: 10, blur: 29, color: 'rgba(40,38,30,0.06)' },
      },
      o.card,
    ),
    tileTint: o.tileTint ?? 0.14,
    margin: pick({ x: 106, y: 82 }, o.margin),
    gap: o.gap ?? 32,
    motion: pick({ effect: 'fade-up' as const, stagger: true }, o.motion) as ResolvedTokens['motion'],
    chrome: { ...(o.chrome ?? {}) },
  }
}

/**
 * The colours of a dark slide. Uses the theme's own `dark` variant when it has one. Otherwise:
 * - a theme whose background is already dark keeps its text and accent, and uses its surface as the background;
 * - any other theme gets the navy default, with its accent lifted until it reads on navy.
 */
export function deriveDarkVariant(theme: Theme): DarkVariant {
  if (theme.dark) return theme.dark
  const { background, surface, text, muted, accent } = theme.colors
  if (isDarkHex(background)) {
    return {
      background: { type: 'color', value: surface },
      text,
      muted,
      accent,
      surface: tryColor(() => mixHex(surface, '#ffffff', 0.06), surface),
      stroke: tryColor(() => mixHex(text, background, 0.8), '#444444'),
    }
  }
  return {
    background: { type: 'gradient', value: NAVY_GRADIENT },
    text: NAVY_TEXT,
    muted: NAVY_MUTED,
    accent: tryColor(() => ensureContrast(accent, NAVY_BASE, 3), NAVY_FALLBACK_ACCENT),
    surface: NAVY_SURFACE,
    stroke: NAVY_STROKE,
  }
}

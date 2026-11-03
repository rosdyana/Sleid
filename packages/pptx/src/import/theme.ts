// The theme part: colour scheme and font scheme, mapped onto the deck theme.
import { cloneTheme, DEFAULT_THEME, type Theme } from '@sleid/model'
import { attr, child, firstDescendant, kids, local, type XNode } from './xml.ts'

export interface ParsedTheme {
  name?: string
  colors: Record<string, string>
  headingFont?: string
  bodyFont?: string
}

const SCHEME_ALIASES: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }
const SCHEME_NAMES = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']

const HEX6 = /^[0-9a-fA-F]{6}$/

/** `#RRGGBB` for a DrawingML colour node (srgbClr, sysClr). Scheme references need the theme. */
function literalColor(node: XNode | undefined): string | undefined {
  if (!node) return undefined
  if (local(node.name) === 'srgbClr') {
    const v = attr(node, 'val') ?? ''
    return HEX6.test(v) ? `#${v.toUpperCase()}` : undefined
  }
  if (local(node.name) === 'sysClr') {
    const v = attr(node, 'lastClr') ?? ''
    return HEX6.test(v) ? `#${v.toUpperCase()}` : undefined
  }
  return undefined
}

/** The colour of a fill-like wrapper such as `a:solidFill`, resolved through the theme. */
export function colorIn(wrapper: XNode | undefined, theme: ParsedTheme | undefined): string | undefined {
  if (!wrapper) return undefined
  for (const c of kids(wrapper)) {
    const lit = literalColor(c)
    if (lit) return lit
    if (local(c.name) === 'schemeClr' && theme) {
      const raw = attr(c, 'val') ?? ''
      const key = SCHEME_ALIASES[raw] ?? raw
      const resolved = theme.colors[key]
      if (resolved) return resolved
    }
  }
  return undefined
}

export function parseTheme(root: XNode): ParsedTheme {
  const colors: Record<string, string> = {}
  const scheme = firstDescendant(root, 'clrScheme')
  for (const name of SCHEME_NAMES) {
    const slot = child(scheme, name)
    const value = literalColor(kids(slot)[0])
    if (value) colors[name] = value
  }
  const fonts = firstDescendant(root, 'fontScheme')
  const major = firstDescendant(child(fonts, 'majorFont'), 'latin')
  const minor = firstDescendant(child(fonts, 'minorFont'), 'latin')
  return {
    name: attr(root, 'name'),
    colors,
    headingFont: attr(major, 'typeface') || undefined,
    bodyFont: attr(minor, 'typeface') || undefined,
  }
}

/** Maps a parsed theme onto the deck theme. Anything missing keeps the default value. */
export function toDeckTheme(parsed: ParsedTheme | undefined): Theme {
  const theme = cloneTheme(DEFAULT_THEME)
  if (!parsed) return theme
  const c = parsed.colors
  theme.name = parsed.name?.trim() ? parsed.name.trim().slice(0, 80) : 'Imported theme'
  theme.colors = {
    background: c.lt1 ?? theme.colors.background,
    surface: c.lt2 ?? theme.colors.surface,
    text: c.dk1 ?? theme.colors.text,
    muted: c.dk2 ?? theme.colors.muted,
    accent: c.accent1 ?? theme.colors.accent,
    accent2: c.accent2 ?? theme.colors.accent2,
    accent3: c.accent3 ?? theme.colors.accent3,
    accent4: c.accent4 ?? theme.colors.accent4,
  }
  theme.fonts = {
    heading: parsed.headingFont ?? theme.fonts.heading,
    body: parsed.bodyFont ?? theme.fonts.body,
    mono: theme.fonts.mono,
  }
  theme.backgroundStyle = 'solid'
  theme.backgroundValue = undefined
  return theme
}

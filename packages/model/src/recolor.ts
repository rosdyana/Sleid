// Recolouring (M11). When a theme changes, or a slide switches between light and dark, the colours stored on its
// elements are mapped from the old palette to the new one. Only exact matches change: a colour that is not one of the
// old palette's colours is left alone.
import { toHex } from './contrast.ts'
import type { DarkVariant, Element, RichNode, RichText, Theme } from './schema.ts'
import { deriveDarkVariant } from './tokens.ts'

/**
 * A colour in a canonical form, so that two spellings of one colour match: lower case, #abc expanded to #aabbcc,
 * and rgb()/rgba() with alpha 1 written as hex. Other values are only trimmed and lower-cased.
 */
export function colorKey(color: string): string {
  const s = color.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join('')}`
  const m = /^rgba?\((.*)\)$/.exec(s)
  if (m) {
    const parts = m[1]!.split(/\s*,\s*/).map((p) => Number(p))
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n)) && (parts[3] === undefined || parts[3] === 1)) {
      return toHex({ r: parts[0]!, g: parts[1]!, b: parts[2]! })
    }
  }
  return s
}

/** Keys of a token record in priority order, for tokenColorMap. */
export function orderedColors(colors: Theme['colors']): Record<string, string> {
  return {
    text: colors.text,
    muted: colors.muted,
    accent: colors.accent,
    accent2: colors.accent2,
    accent3: colors.accent3,
    accent4: colors.accent4,
    background: colors.background,
    surface: colors.surface,
  }
}

/** The colours of a dark variant, in priority order. */
export function darkColors(dark: DarkVariant): Record<string, string> {
  return { text: dark.text, muted: dark.muted, accent: dark.accent, surface: dark.surface, stroke: dark.stroke }
}

/**
 * The map from old colours to new colours, for two token records with the same keys. Keys are taken in the order
 * of `from`. When two old tokens share a colour, the first key claims it, so the rest of that colour's uses stay
 * with the first token. A pair whose old and new colours are equal is no change.
 */
export function tokenColorMap(from: Record<string, string>, to: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const claimed = new Set<string>()
  for (const key of Object.keys(from)) {
    if (!(key in to)) continue
    const oldColor = colorKey(from[key]!)
    if (claimed.has(oldColor)) continue
    claimed.add(oldColor)
    const newColor = to[key]!
    if (colorKey(newColor) !== oldColor) out[oldColor] = newColor
  }
  return out
}

/** The light-slide token record of a theme (text, muted, accent, surface and background), in priority order. */
export function lightTokens(theme: Theme): Record<string, string> {
  return {
    text: theme.colors.text,
    muted: theme.colors.muted,
    accent: theme.colors.accent,
    surface: theme.colors.surface,
    background: theme.colors.background,
  }
}

/**
 * The same token record for a dark variant. A light background becomes the dark surface, so it stays a panel colour
 * rather than a page colour.
 */
export function darkTokens(dark: DarkVariant): Record<string, string> {
  return { text: dark.text, muted: dark.muted, accent: dark.accent, surface: dark.surface, background: dark.surface }
}

/** The map that moves a light slide's colours to the dark variant of the same theme. */
export function lightToDarkMap(theme: Theme): Record<string, string> {
  return tokenColorMap(lightTokens(theme), darkTokens(deriveDarkVariant(theme)))
}

/** The map that moves a dark slide's colours back to the light palette of the same theme. */
export function darkToLightMap(theme: Theme): Record<string, string> {
  return tokenColorMap(darkTokens(deriveDarkVariant(theme)), lightTokens(theme))
}

type Swap = (color: string | undefined) => string | undefined

function swapFor(map: Record<string, string>): Swap {
  const lookup = new Map(Object.entries(map).map(([k, v]) => [colorKey(k), v]))
  return (color) => {
    if (color === undefined) return color
    return lookup.get(colorKey(color)) ?? color
  }
}

// Rich text: every textStyle mark's colour, at any depth.
function recolorRich<T extends RichNode>(node: T, swap: Swap): T {
  const marks = node.marks?.map((mark) => {
    if (mark.type !== 'textStyle' || !mark.attrs.color) return mark
    const color = swap(mark.attrs.color)
    return color === mark.attrs.color ? mark : { ...mark, attrs: { ...mark.attrs, color } }
  })
  const content = node.content?.map((child) => recolorRich(child, swap))
  return {
    ...node,
    ...(marks ? { marks } : {}),
    ...(content ? { content } : {}),
  }
}

function recolorDoc(doc: RichText, swap: Swap): RichText {
  return recolorRich(doc as RichNode, swap) as RichText
}

function recolorElement(el: Element, swap: Swap): Element {
  switch (el.type) {
    case 'text': {
      const color = swap(el.style.color)
      return {
        ...el,
        content: recolorDoc(el.content, swap),
        style: color === el.style.color ? el.style : { ...el.style, color },
      }
    }
    case 'shape': {
      const next: Element = {
        ...el,
        fill: swap(el.fill) ?? el.fill,
        stroke: swap(el.stroke) ?? el.stroke,
      }
      if (el.gradient) {
        next.gradient = { ...el.gradient, stops: el.gradient.stops.map((s) => ({ ...s, color: swap(s.color) ?? s.color })) }
      }
      if (el.text) next.text = recolorDoc(el.text, swap)
      return next
    }
    case 'vector':
      return {
        ...el,
        paths: el.paths.map((p) => ({ ...p, fill: swap(p.fill) ?? p.fill, stroke: swap(p.stroke) ?? p.stroke })),
      }
    case 'chart': {
      if (!el.options.colors) return el
      return { ...el, options: { ...el.options, colors: el.options.colors.map((c) => swap(c) ?? c) } }
    }
    case 'table': {
      if (!el.style) return el
      const style = Object.fromEntries(
        Object.entries(el.style).map(([k, v]) => [k, typeof v === 'string' ? (swap(v) ?? v) : v]),
      ) as typeof el.style
      return { ...el, style }
    }
    default:
      return el
  }
}

/**
 * The elements with their colours mapped through `map`. Pure: the input is not changed. `map` is keyed by colorKey
 * of the old colour and gives the new colour. Elements with no matching colour come back unchanged.
 */
export function recolorSlideElements(elements: Element[], map: Record<string, string>): Element[] {
  if (Object.keys(map).length === 0) return elements
  const swap = swapFor(map)
  return elements.map((el) => recolorElement(el, swap))
}

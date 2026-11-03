// M10. Style and attribute helpers for drawing elements on the editor canvas and in the thumbnails. Each function
// mirrors one in packages/render/src/render.ts (named in its comment), so the editor draws what the renderer draws.
// Lengths in the model are canvas px; they are multiplied by `scale` here. Pure: no React runtime, so node tests can read it.
import type { CSSProperties, SVGProps } from 'react'
import {
  VECTOR_PATH_D_RE,
  type GradientFill,
  type ImageElement,
  type Shadow,
  type ShapeElement,
  type TextElement,
  type Theme,
  type VectorElement,
  type VectorPath,
} from '@sleid/model'
import { fontStack, num, safeColor, safeFontFamily, safeLength, safeSignedLength } from '@sleid/render'

const ALIGN = new Set(['left', 'center', 'right', 'justify'])
const DASH_STYLES = new Set(['solid', 'dashed', 'dotted'])
const LINE_CAPS = new Set(['butt', 'round', 'square'])
const LINE_JOINS = new Set(['miter', 'round', 'bevel'])

/** A paint value as the renderer reads it (`paintOr` in render.ts): 'none' and unsafe values are transparent. */
export function paintOr(value: string): string {
  return value === 'none' ? 'transparent' : safeColor(value, 'transparent')
}

/** Gradient stops with a usable colour, clamped to 0-1. Fewer than two usable stops means no gradient (`usableStops`). */
function usableStops(g: GradientFill): Array<{ color: string; at: number }> | undefined {
  const stops = g.stops.flatMap((s) => {
    const color = safeColor(s.color, '')
    return color && Number.isFinite(s.at) ? [{ color, at: Math.min(Math.max(s.at, 0), 1) }] : []
  })
  return stops.length >= 2 ? stops : undefined
}

/** CSS gradient for a box background (`gradientCss` in render.ts). */
export function gradientCss(g: GradientFill): string | undefined {
  const stops = usableStops(g)
  if (!stops) return undefined
  const list = stops.map((s) => `${s.color} ${num(s.at * 100)}%`).join(', ')
  return g.type === 'radial' ? `radial-gradient(circle, ${list})` : `linear-gradient(${num(g.angle ?? 180, 180)}deg, ${list})`
}

/** box-shadow (with spread) or text-shadow / drop-shadow (without), in screen px (`shadowList` in html.ts, scaled). */
export function scaledShadow(shadow: Shadow, scale: number, withSpread = true): string {
  const spread = withSpread ? ` ${num((shadow.spread ?? 0) * scale)}px` : ''
  return `${num(shadow.x * scale)}px ${num(shadow.y * scale)}px ${num(shadow.blur * scale)}px${spread} ${safeColor(shadow.color, 'transparent')}`
}

/**
 * The text box's own style (`renderText` in render.ts). Without a font on the element, a title uses the heading font
 * and any other text uses the body font. A line height that is not set is `normal`.
 */
export function textBoxStyle(el: TextElement, theme: Theme, scale: number): CSSProperties {
  const s = el.style
  const family = safeFontFamily(s.fontFamily) ?? (el.role === 'title' ? theme.fonts.heading : theme.fonts.body)
  const valign = s.valign === 'middle' ? 'center' : s.valign === 'bottom' ? 'flex-end' : 'flex-start'
  return {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: valign,
    textAlign: ALIGN.has(s.align) ? s.align : 'left',
    fontFamily: fontStack(family, 'sans-serif'),
    fontSize: (s.fontSize ?? theme.sizes.body) * scale,
    color: safeColor(s.color, '') || undefined,
    lineHeight: s.lineHeight ?? 'normal',
    fontWeight: s.fontWeight,
    letterSpacing: s.letterSpacing !== undefined ? `${num(s.letterSpacing)}em` : undefined,
    textTransform: s.textTransform,
    textShadow: el.shadow ? scaledShadow(el.shadow, scale, false) : undefined,
    overflowWrap: 'anywhere',
  }
}

/** Corner radius of a box shape (`boxRadius` in render.ts). A roundRect with no radius keeps the legacy 12% corner. */
export function boxRadius(el: ShapeElement, scale: number): string {
  if (el.shape === 'ellipse') return '50%'
  if (el.shape === 'roundRect' && el.radius === undefined) return '12%'
  return `${num(Math.max(el.radius ?? 0, 0) * scale)}px`
}

/** Style of the box div for rect, roundRect and ellipse (`boxShapeHtml` in render.ts). The border sits inside the box. */
export function boxShapeStyle(el: ShapeElement, scale: number): CSSProperties {
  const background = el.gradient ? gradientCss(el.gradient) : undefined
  const style: CSSProperties = { position: 'absolute', inset: 0, boxSizing: 'border-box' }
  if (background) style.background = background
  else style.backgroundColor = paintOr(el.fill)
  if (el.strokeWidth > 0) {
    const dash = el.strokeDash && DASH_STYLES.has(el.strokeDash) ? el.strokeDash : 'solid'
    style.border = `${num(Math.max(el.strokeWidth, 0) * scale)}px ${dash} ${paintOr(el.stroke)}`
  }
  style.borderRadius = boxRadius(el, scale)
  if (el.shadow) style.boxShadow = scaledShadow(el.shadow, scale)
  return style
}

/** Stroke dashes for the SVG shapes (`strokeDashAttr` in render.ts). Lengths are in the already-scaled stroke width. */
function strokeDashProps(dash: ShapeElement['strokeDash'], sw: number): Pick<SVGProps<SVGElement>, 'strokeDasharray' | 'strokeLinecap'> {
  if (sw <= 0) return {}
  if (dash === 'dashed') return { strokeDasharray: `${num(3 * sw)} ${num(2 * sw)}` }
  if (dash === 'dotted') return { strokeDasharray: `0 ${num(2 * sw)}`, strokeLinecap: 'round' }
  return {}
}

/** Paint for the SVG shapes (triangle, arrow, line, star), as the renderer draws them. The first gradient stop is the fill. */
export function shapeSvgPaint(el: ShapeElement, scale: number): Pick<SVGProps<SVGElement>, 'fill' | 'stroke' | 'strokeWidth' | 'strokeDasharray' | 'strokeLinecap'> & { filter?: string } {
  const stops = el.gradient ? usableStops(el.gradient) : undefined
  const sw = Math.max(el.strokeWidth, 0) * scale
  return {
    fill: stops ? stops[0]!.color : safeColor(el.fill, 'none'),
    stroke: safeColor(el.stroke, 'none'),
    strokeWidth: sw,
    ...strokeDashProps(el.strokeDash, sw),
    ...(el.shadow ? { filter: `drop-shadow(${scaledShadow(el.shadow, scale, false)})` } : {}),
  }
}

/** Wrapper style for an image: corner radius with overflow hidden, and a box shadow (`imageWrapAttr` in render.ts). */
export function imageWrapStyle(el: ImageElement, scale: number): CSSProperties {
  const style: CSSProperties = {}
  if (el.radius !== undefined) {
    style.borderRadius = `${num(Math.max(el.radius, 0) * scale)}px`
    style.overflow = 'hidden'
  }
  if (el.shadow) style.boxShadow = scaledShadow(el.shadow, scale)
  return style
}

/** The SVG viewBox string (`renderVector` in render.ts). */
export function vectorViewBox(el: VectorElement): string {
  const vb = el.viewBox
  return `${num(vb.x)} ${num(vb.y)} ${num(vb.w, 1)} ${num(vb.h, 1)}`
}

/** Paths whose `d` passes the path check. The renderer skips the others. */
export function visibleVectorPaths(el: VectorElement): VectorPath[] {
  return el.paths.filter((p) => VECTOR_PATH_D_RE.test(p.d))
}

/** Attributes of one vector path (`renderVector` in render.ts). */
export function vectorPathProps(p: VectorPath): SVGProps<SVGPathElement> {
  return {
    d: p.d,
    fill: paintOr(p.fill),
    stroke: paintOr(p.stroke),
    strokeWidth: Math.max(p.strokeWidth, 0),
    ...(p.lineCap && LINE_CAPS.has(p.lineCap) ? { strokeLinecap: p.lineCap } : {}),
    ...(p.lineJoin && LINE_JOINS.has(p.lineJoin) ? { strokeLinejoin: p.lineJoin } : {}),
    ...(p.opacity !== undefined ? { opacity: Math.min(Math.max(p.opacity, 0), 1) } : {}),
  }
}

/** Inline style for a textStyle mark (`textStyleCss` in rich-text.ts). Values are checked the same way. */
export function textStyleMarkCss(attrs: {
  color?: string | null
  fontSize?: string | null
  fontFamily?: string | null
  fontWeight?: string | number | null
  letterSpacing?: string | null
}): CSSProperties {
  const style: CSSProperties = {}
  const color = safeColor(attrs.color ?? undefined, '')
  if (color) style.color = color
  const size = safeLength(attrs.fontSize ?? undefined)
  if (size) style.fontSize = size
  const family = safeFontFamily(attrs.fontFamily ?? undefined)
  if (family) style.fontFamily = family
  // A weight is a number 100-900, a three-digit numeric string 100-900 (TipTap parseHTML gives strings), or 'bold' or 'normal'.
  const weight = attrs.fontWeight
  const numeric = typeof weight === 'number' ? weight : typeof weight === 'string' && /^\d{3}$/.test(weight) ? Number(weight) : NaN
  if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 900) style.fontWeight = numeric
  else if (weight === 'bold' || weight === 'normal') style.fontWeight = weight
  const spacing = safeSignedLength(attrs.letterSpacing ?? undefined)
  if (spacing) style.letterSpacing = spacing
  return style
}

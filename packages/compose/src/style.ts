// Style inference. Reads an existing deck and says what its type scale, dark variant, card, margins, recurring chrome,
// slide archetypes and motion are, so that new slides can be drawn in the same look (themeFromStyle turns the result into a theme).
import {
  type ComponentTokens,
  deriveDarkVariant,
  type Deck,
  type Element,
  type RichNode,
  relativeLuminance,
  type Shadow,
  type TextElement,
  type Theme,
} from '@sleid/model'
import { parseColor } from './color.ts'

type AnimationEffect = NonNullable<Element['animation']>['effect']
import { plainText } from './rich.ts'
import type { Box } from './regions.ts'

export type TypeRoleName = 'label' | 'heading' | 'subtitle' | 'body' | 'small'
export type TransformName = 'none' | 'uppercase' | 'lowercase' | 'capitalize'

export interface TypeRole {
  size: number
  weight?: number
  color?: string
  letterSpacing?: number
  textTransform?: TransformName
  lineHeight?: number
}

export type RecurringRole = 'logo' | 'footer' | 'page' | 'other'

export interface RecurringElement {
  role: RecurringRole
  type: 'text' | 'image'
  box: Box
  /** The image src (the light one when the picture differs between light and dark slides). */
  src?: string
  text?: string
  style?: Partial<TextStyle>
  /** How many slides it appears on. */
  slides: number
  /** Image sources by variant, when they differ between light and dark slides. */
  variants?: { light?: string; dark?: string }
}

export type Archetype = 'cover' | 'header+cards' | 'header+screenshot' | 'timeline' | 'comparison' | 'ask' | 'demo' | 'other'

export interface ArchetypeGuess {
  slideId: string
  slideIndex: number
  archetype: Archetype
}

export interface DeckStyle {
  theme: Theme
  typeScale: Partial<Record<TypeRoleName, TypeRole>>
  darkVariant?: { background: { type: 'color' | 'gradient'; value: string }; text?: string; muted?: string; accent?: string }
  card?: { fill: string; stroke: string; strokeWidth: number; radius: number; shadow?: Shadow }
  margins: { x: number; y: number }
  recurring: RecurringElement[]
  archetypes: ArchetypeGuess[]
  motion?: { effect: AnimationEffect }
}

type TextStyle = TextElement['style']

interface TextRec {
  el: TextElement
  slideIndex: number
  size: number
  weight: number
  transform: TransformName
  key: string
}

interface Cluster {
  size: number
  weight: number
  transform: TransformName
  items: TextRec[]
}

const FALLBACK_MARGIN = { x: 106, y: 82 }
const CANVAS_W = 1920
const CANVAS_H = 1080

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: { v: T; n: number } | undefined
  for (const [v, n] of counts) if (!best || n > best.n) best = { v, n }
  return best?.v
}

function slideIsDark(deck: Deck, index: number): boolean {
  const slide = deck.slides[index]!
  if (slide.variant === 'dark') return true
  const bg = slide.background
  if (bg?.type === 'gradient') return true
  if (bg?.type === 'color') {
    const c = parseColor(bg.value)
    return c !== undefined && safeLuminance(c.hex) < 0.2
  }
  return false
}

function safeLuminance(hex: string): number {
  try {
    return relativeLuminance(hex)
  } catch {
    return 1
  }
}

function saturation(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return Math.max(r, g, b) - Math.min(r, g, b)
}

function textRecords(deck: Deck): TextRec[] {
  const out: TextRec[] = []
  deck.slides.forEach((slide, slideIndex) => {
    for (const el of slide.elements) {
      if (el.type !== 'text') continue
      const size = el.style.fontSize
      if (!size) continue
      const rounded = Math.round(size * 10) / 10
      const weight = el.style.fontWeight ?? 400
      const transform: TransformName = el.style.textTransform ?? 'none'
      out.push({ el, slideIndex, size: rounded, weight, transform, key: `${rounded}|${weight}|${transform}` })
    }
  })
  return out
}

function clusterize(recs: TextRec[]): Cluster[] {
  const map = new Map<string, Cluster>()
  for (const r of recs) {
    const c = map.get(r.key) ?? { size: r.size, weight: r.weight, transform: r.transform, items: [] }
    c.items.push(r)
    map.set(r.key, c)
  }
  return [...map.values()]
}

function styleOf(c: Cluster): TypeRole {
  const role: TypeRole = { size: c.size, weight: c.weight }
  const color = mostCommon(c.items.map((i) => i.el.style.color).filter((v): v is string => Boolean(v)))
  if (color) role.color = color
  const ls = mostCommon(c.items.map((i) => i.el.style.letterSpacing).filter((v): v is number => v !== undefined))
  if (ls !== undefined) role.letterSpacing = ls
  const lh = mostCommon(c.items.map((i) => i.el.style.lineHeight).filter((v): v is number => v !== undefined))
  if (lh !== undefined) role.lineHeight = lh
  if (c.transform !== 'none') role.textTransform = c.transform
  return role
}

function medianY(items: TextRec[]): number {
  const ys = items.map((i) => i.el.y).sort((a, b) => a - b)
  return ys[Math.floor(ys.length / 2)] ?? 0
}

function mostFrequent(clusters: Cluster[]): Cluster | undefined {
  let best: Cluster | undefined
  for (const c of clusters) if (!best || c.items.length > best.items.length) best = c
  return best
}

/** Type scale: label, heading, subtitle, body and small. */
function typeScaleOf(recs: TextRec[]): Partial<Record<TypeRoleName, TypeRole>> {
  const out: Partial<Record<TypeRoleName, TypeRole>> = {}
  const clusters = clusterize(recs)
  const used = new Set<Cluster>()

  // Label: uppercase, small, near the top. The most frequent one wins.
  const labelCandidates = clusters.filter((c) => c.transform === 'uppercase' && c.size < 40 && medianY(c.items) < 150)
  const label = mostFrequent(labelCandidates)
  if (label) {
    out.label = styleOf(label)
    used.add(label)
  }

  // Heading: role 'title' first; otherwise the largest size that repeats, between 100px and 300px from the top.
  const titled = recs.filter((r) => r.el.role === 'title')
  let heading: Cluster | undefined
  if (titled.length > 0) heading = mostFrequent(clusterize(titled))
  if (!heading) {
    const repeating = clusters.filter((c) => c.size >= 40 && c.items.length >= 2 && c.items.some((i) => i.el.y >= 100 && i.el.y <= 300))
    heading = repeating.sort((a, b) => b.size - a.size || b.items.length - a.items.length)[0]
  }
  if (heading) {
    out.heading = styleOf(heading)
    used.add(heading)
  }

  // Subtitle: the most frequent text just under the heading (on the same slide), smaller than it.
  if (heading) {
    const headingKey = heading.items[0]?.key
    const headingItems = recs.filter((r) => r.key === headingKey)
    const under = recs.filter(
      (r) =>
        r.key !== headingKey &&
        r.size < heading.size &&
        r.transform !== 'uppercase' &&
        !(label && r.key === label.items[0]?.key) &&
        headingItems.some((h) => h.slideIndex === r.slideIndex && r.el.y > h.el.y + 20 && r.el.y < h.el.y + 160),
    )
    const subtitle = mostFrequent(clusterize(under))
    if (subtitle) {
      out.subtitle = styleOf(subtitle)
      used.add(subtitle)
    }
  }

  // Body: the most frequent remaining size at 22px or more. Small: the most frequent remaining size below body.
  const rest = clusters.filter((c) => !used.has(c))
  const body = mostFrequent(rest.filter((c) => c.size >= 22))
  if (body) {
    out.body = styleOf(body)
    used.add(body)
  }
  const bodySize = body?.size ?? Number.POSITIVE_INFINITY
  const small = mostFrequent(rest.filter((c) => c !== body && c.size < bodySize && c.size >= 12))
  if (small) out.small = styleOf(small)
  return out
}

function darkVariantOf(deck: Deck, recs: TextRec[]): DeckStyle['darkVariant'] {
  const darkIdx = deck.slides.map((_, i) => i).filter((i) => slideIsDark(deck, i))
  if (darkIdx.length === 0) return undefined
  const firstSlide = deck.slides[darkIdx[0]!]!
  const bg = firstSlide.background
  const background: { type: 'color' | 'gradient'; value: string } =
    bg?.type === 'gradient' ? { type: 'gradient', value: bg.value } : bg?.type === 'color' ? { type: 'color', value: bg.value } : { type: 'gradient', value: deriveDarkVariant(deck.theme).background.value }
  const colours = recs
    .filter((r) => darkIdx.includes(r.slideIndex) && r.el.style.color)
    .map((r) => parseColor(r.el.style.color!)?.hex)
    .filter((c): c is string => Boolean(c))
  // Accent: the most common saturated colour. Text and muted: the most common light, unsaturated colours, with text the brighter.
  const accent = mostCommon(colours.filter((c) => saturation(c) >= 40))
  const light = colours.filter((c) => saturation(c) < 40 && safeLuminance(c) >= 0.25)
  const ranked = [...new Map(light.map((c) => [c, light.filter((x) => x === c).length])).entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c)
  const brighter = (a: string, b: string) => (safeLuminance(a) >= safeLuminance(b) ? a : b)
  const text = ranked.length === 2 ? brighter(ranked[0]!, ranked[1]!) : ranked[0]
  const muted = ranked.length === 2 ? ranked.find((c) => c !== text) : undefined
  return {
    background,
    ...(text ? { text } : {}),
    ...(muted ? { muted } : {}),
    ...(accent ? { accent } : {}),
  }
}

function cardOf(deck: Deck): DeckStyle['card'] {
  const shapes: Array<{ fill: string; stroke: string; strokeWidth: number; radius: number; shadow?: Shadow }> = []
  for (const slide of deck.slides) {
    for (const el of slide.elements) {
      if (el.type !== 'shape' || el.shape !== 'roundRect' || el.w <= 200 || el.radius === undefined) continue
      if (el.gradient) continue
      shapes.push({
        fill: el.fill,
        stroke: el.stroke,
        strokeWidth: el.strokeWidth,
        radius: el.radius,
        ...(el.shadow ? { shadow: el.shadow } : {}),
      })
    }
  }
  const key = (s: (typeof shapes)[number]) => JSON.stringify(s)
  const best = mostCommon(shapes.map(key))
  if (!best) return undefined
  return JSON.parse(best) as (typeof shapes)[number]
}

function marginsOf(recs: TextRec[]): { x: number; y: number } {
  const headings = recs.filter((r) => r.size >= 40 && r.el.y >= 40 && r.el.y <= 300)
  const labels = recs.filter((r) => r.transform === 'uppercase' && r.el.y < 150)
  if (headings.length === 0 && labels.length === 0) return { ...FALLBACK_MARGIN }
  const x = headings.length > 0 ? Math.min(...headings.map((r) => r.el.x)) : FALLBACK_MARGIN.x
  const y = labels.length > 0 ? Math.min(...labels.map((r) => r.el.y)) : Math.min(...headings.map((r) => r.el.y))
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
}

const NEAR_PX = 4

function nearBox(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) <= NEAR_PX && Math.abs(a.y - b.y) <= NEAR_PX && Math.abs(a.w - b.w) <= NEAR_PX && Math.abs(a.h - b.h) <= NEAR_PX
}

function boxOf(el: Element): Box {
  return { x: el.x, y: el.y, w: el.w, h: el.h }
}

function roleOf(type: 'text' | 'image', box: Box, text: string | undefined): RecurringRole {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  if (type === 'image') {
    const cornerX = cx < CANVAS_W / 3 || cx > (CANVAS_W * 2) / 3
    const cornerY = cy < CANVAS_H / 3 || cy > (CANVAS_H * 2) / 3
    return cornerX && cornerY ? 'logo' : 'other'
  }
  if (cy > CANVAS_H * 0.85) {
    if (cx > CANVAS_W * 0.8 && /^\s*\d+\s*$/.test(text ?? '')) return 'page'
    return 'footer'
  }
  return 'other'
}

interface Group {
  type: 'text' | 'image'
  sig: string
  box: Box
  el: Element
  slides: Set<number>
  srcs: Map<string, Set<number>>
}

/** Elements that repeat on at least 60% of the slides: text with the same words, and images in the same box. */
function recurringOf(deck: Deck): RecurringElement[] {
  const groups: Group[] = []
  deck.slides.forEach((slide, si) => {
    const seen = new Set<Group>()
    for (const el of slide.elements) {
      if (el.opacity === 0) continue
      if (el.type !== 'text' && el.type !== 'image') continue
      let sig: string
      if (el.type === 'image') {
        if (!el.src.trim()) continue
        sig = 'image'
      } else {
        sig = plainText(el.content as RichNode).trim()
        if (!sig) continue
      }
      const box = boxOf(el)
      let g = groups.find((c) => c.type === el.type && c.sig === sig && !seen.has(c) && nearBox(c.box, box))
      if (!g) {
        g = { type: el.type, sig, box, el, slides: new Set(), srcs: new Map() }
        groups.push(g)
      }
      seen.add(g)
      g.slides.add(si)
      if (el.type === 'image') {
        const set = g.srcs.get(el.src) ?? new Set<number>()
        set.add(si)
        g.srcs.set(el.src, set)
      }
    }
  })

  const threshold = Math.ceil(deck.slides.length * 0.6)
  const out: RecurringElement[] = []
  for (const g of groups) {
    if (g.slides.size < threshold) continue
    const text = g.type === 'text' ? sigText(g.el) : undefined
    const role = roleOf(g.type, g.box, text)
    if (g.type === 'image') {
      const light = mostSrc(g, false, deck)
      const dark = mostSrc(g, true, deck)
      out.push({
        role,
        type: 'image',
        box: g.box,
        ...(light ?? dark ? { src: (light ?? dark)! } : {}),
        slides: g.slides.size,
        variants: { ...(light ? { light } : {}), ...(dark ? { dark } : {}) },
      })
    } else {
      const el = g.el as TextElement
      out.push({
        role,
        type: 'text',
        box: g.box,
        text,
        style: pickStyle(el),
        slides: g.slides.size,
      })
    }
  }
  return out
}

function sigText(el: Element): string {
  return plainText((el as TextElement).content as RichNode).trim()
}

function pickStyle(el: TextElement): Partial<TextStyle> {
  const s = el.style
  const out: Partial<TextStyle> = {}
  if (s.fontFamily) out.fontFamily = s.fontFamily
  if (s.fontSize !== undefined) out.fontSize = s.fontSize
  if (s.color) out.color = s.color
  if (s.fontWeight !== undefined) out.fontWeight = s.fontWeight
  if (s.letterSpacing !== undefined) out.letterSpacing = s.letterSpacing
  if (s.textTransform) out.textTransform = s.textTransform
  if (s.lineHeight !== undefined) out.lineHeight = s.lineHeight
  out.align = s.align
  out.valign = s.valign
  return out
}

/** The most common src of a group among dark (or light) slides. */
function mostSrc(g: Group, dark: boolean, deck: Deck): string | undefined {
  let best: { src: string; n: number } | undefined
  for (const [src, slides] of g.srcs) {
    const n = [...slides].filter((si) => slideIsDark(deck, si) === dark).length
    if (n > 0 && (!best || n > best.n)) best = { src, n }
  }
  return best?.src
}

function archetypesOf(deck: Deck, recs: TextRec[]): ArchetypeGuess[] {
  return deck.slides.map((slide, slideIndex) => {
    const els = slide.elements
    const texts = els.filter((e): e is TextElement => e.type === 'text')
    const maxSize = Math.max(0, ...texts.map((t) => t.style.fontSize ?? 0))
    const dark = slideIsDark(deck, slideIndex)
    const headerText = recs.some((r) => r.slideIndex === slideIndex && r.size >= 40 && r.el.y >= 40 && r.el.y <= 300)
    const cards = els.filter((e) => e.type === 'shape' && e.shape === 'roundRect' && e.w > 200 && !e.gradient).length
    const ellipses = els.filter((e) => e.type === 'shape' && e.shape === 'ellipse' && Math.abs(e.w - e.h) < 2 && e.w >= 40)
    const rows = new Set(ellipses.map((e) => Math.round(e.y))).size
    const rules = els.filter((e) => e.type === 'shape' && e.shape === 'rect' && e.h <= 2 && e.w > 200).length
    const bigImage = els.some((e) => e.type === 'image' && e.w >= 800)
    let archetype: Archetype = 'other'
    if (maxSize >= 100 && !headerText) archetype = 'cover'
    else if (dark && cards >= 2) archetype = 'ask'
    else if (ellipses.length >= 3 && rows === 1) archetype = 'timeline'
    else if (rules >= 3 && texts.length >= 6) archetype = 'comparison'
    else if (bigImage && headerText) archetype = 'header+screenshot'
    else if (bigImage) archetype = 'demo'
    else if (cards >= 2 && headerText) archetype = 'header+cards'
    return { slideId: slide.id, slideIndex, archetype }
  })
}

/** Reads a deck's style. Every field is inferred from the deck's own elements; absent fields mean the deck does not show them. */
export function deriveStyle(deck: Deck): DeckStyle {
  const recs = textRecords(deck)
  const typeScale = typeScaleOf(recs)
  const darkVariant = darkVariantOf(deck, recs)
  const card = cardOf(deck)
  const margins = marginsOf(recs)
  const recurring = recurringOf(deck)
  const archetypes = archetypesOf(deck, recs)
  const effects = deck.slides.flatMap((s) => s.elements.map((e) => e.animation?.effect).filter((e): e is AnimationEffect => Boolean(e)))
  const effect = mostCommon(effects)
  return {
    theme: deck.theme,
    typeScale,
    ...(darkVariant ? { darkVariant } : {}),
    ...(card ? { card } : {}),
    margins,
    recurring,
    archetypes,
    ...(effect ? { motion: { effect } } : {}),
  }
}

/**
 * The deck's theme with the inferred style written into it: the dark variant (derived from the theme, overridden by the
 * inferred colours), components (label, heading, subtitle, body, small, card, margin, motion) and components.chrome (the logos,
 * footer and their boxes, from the recurring elements).
 */
export function themeFromStyle(style: DeckStyle): Theme {
  const base = style.theme
  const derived = deriveDarkVariant({ ...base, dark: undefined })
  const dv = style.darkVariant
  const dark = {
    background: dv?.background ?? derived.background,
    text: dv?.text ?? derived.text,
    muted: dv?.muted ?? derived.muted,
    accent: dv?.accent ?? derived.accent,
    surface: derived.surface,
    stroke: derived.stroke,
  }

  const components: ComponentTokens = { ...(base.components ?? {}) }
  const ts = style.typeScale
  if (ts.label) {
    components.label = {
      size: ts.label.size,
      ...(ts.label.weight !== undefined ? { weight: ts.label.weight } : {}),
      ...(ts.label.letterSpacing !== undefined ? { letterSpacing: ts.label.letterSpacing } : {}),
      ...(ts.label.textTransform ? { textTransform: ts.label.textTransform } : {}),
      ...(ts.label.color ? { color: ts.label.color } : {}),
    }
  }
  if (ts.heading) {
    components.heading = {
      size: ts.heading.size,
      ...(ts.heading.weight !== undefined ? { weight: ts.heading.weight } : {}),
      ...(ts.heading.letterSpacing !== undefined ? { letterSpacing: ts.heading.letterSpacing } : {}),
      ...(ts.heading.lineHeight !== undefined ? { lineHeight: ts.heading.lineHeight } : {}),
    }
  }
  if (ts.subtitle) {
    components.subtitle = {
      size: ts.subtitle.size,
      ...(ts.subtitle.weight !== undefined ? { weight: ts.subtitle.weight } : {}),
      ...(ts.subtitle.color ? { color: ts.subtitle.color } : {}),
    }
  }
  if (ts.body) components.body = { size: ts.body.size, ...(ts.body.lineHeight !== undefined ? { lineHeight: ts.body.lineHeight } : {}) }
  if (ts.small) components.small = { size: ts.small.size }
  if (style.card) components.card = { ...style.card }
  components.margin = { ...style.margins }
  if (style.motion) components.motion = { effect: style.motion.effect }

  // The chrome the theme already has is the starting point: a logo or footer set in the theme stays when no slide repeats it.
  const chrome: NonNullable<ComponentTokens['chrome']> = { ...(base.components?.chrome ?? {}) }
  const logo = style.recurring.find((r) => r.role === 'logo' && r.type === 'image')
  if (logo) {
    if (logo.variants?.light ?? logo.src) chrome.logoLight = logo.variants?.light ?? logo.src
    if (logo.variants?.dark) chrome.logoDark = logo.variants.dark
    chrome.logoBox = { ...logo.box }
  }
  const footer = style.recurring.find((r) => r.role === 'footer' && r.type === 'text')
  if (footer) {
    if (footer.text) chrome.footerText = footer.text
    chrome.footerBox = { ...footer.box }
    if (footer.style) chrome.footerStyle = { ...footer.style }
  }
  if (style.recurring.some((r) => r.role === 'page')) chrome.pageNumbers = true
  components.chrome = chrome

  return { ...base, dark, components }
}

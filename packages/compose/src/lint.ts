// Deck lint. Checks what a reader would see: text that does not fit its box, text that overlaps other text or pictures, elements
// off the slide, low-contrast text, images without alt text, and missing secondary-language lines.
import { contrastRatio, deriveDarkVariant, type Deck, type Element, type RichNode, type Slide, type TextElement, type Theme } from '@sleid/model'
import { DEFAULT_TEXT_SIZE, measureRich, SHAPE_TEXT_SIZE, textBlock, textHeight } from './measure.ts'
import { opaqueStops, parseColor } from './color.ts'

export type Severity = 'error' | 'warning' | 'info'
export type IssueKind = 'overflow' | 'overlap' | 'off-slide' | 'low-contrast' | 'missing-alt' | 'missing-translation' | 'empty-slide'

export interface Issue {
  severity: Severity
  kind: IssueKind
  slideId: string
  slideIndex: number
  elementId: string
  otherElementId?: string
  message: string
  fix: string
}

export interface LintOptions {
  /** Lint only these slides (by id). Default: all. */
  slideIds?: string[]
}

/** Overlaps smaller than this on both axes are not reported. */
const OVERLAP_TOLERANCE = 4
const OVERFLOW_TOLERANCE = 2
const EDGE_TOLERANCE = 1
const CANVAS_W = 1920
const CANVAS_H = 1080
const TRANSLATABLE_PARTS = new Set(['title', 'heading', 'item', 'text'])

interface Ctx {
  deck: Deck
  slide: Slide
  slideIndex: number
  issues: Issue[]
}

function report(ctx: Ctx, el: Element, o: { severity: Severity; kind: IssueKind; message: string; fix: string; other?: Element }): void {
  ctx.issues.push({
    severity: o.severity,
    kind: o.kind,
    slideId: ctx.slide.id,
    slideIndex: ctx.slideIndex,
    elementId: el.id,
    ...(o.other ? { otherElementId: o.other.id } : {}),
    message: o.message,
    fix: o.fix,
  })
}

function snippet(el: Element): string {
  if (el.type === 'text') {
    const text = plain(el.content as RichNode).replace(/\s+/g, ' ').trim()
    return text.length > 40 ? `${text.slice(0, 40)}…` : text || 'text'
  }
  return el.type
}

function plain(node: RichNode | undefined): string {
  if (!node) return ''
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map((c) => plain(c)).join(' ')
}

/** Lints a deck. Empty when nothing is wrong. Errors come first in the order of the checks, then warnings, then info. */
export function lintDeck(deck: Deck, opts: LintOptions = {}): Issue[] {
  const only = opts.slideIds ? new Set(opts.slideIds) : undefined
  const issues: Issue[] = []
  deck.slides.forEach((slide, slideIndex) => {
    if (only && !only.has(slide.id)) return
    const ctx: Ctx = { deck, slide, slideIndex, issues }
    checkOffSlide(ctx)
    checkOverflow(ctx)
    checkOverlap(ctx)
    checkContrast(ctx)
    checkAlt(ctx)
    checkTranslation(ctx)
    checkEmpty(ctx)
  })
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.slideIndex - b.slideIndex)
}

// ---- off-slide ----

function checkOffSlide(ctx: Ctx): void {
  if (ctx.slide.hidden) return
  for (const el of ctx.slide.elements) {
    if (el.opacity === 0) continue
    const outside =
      el.x < -EDGE_TOLERANCE ||
      el.y < -EDGE_TOLERANCE ||
      el.x + el.w > CANVAS_W + EDGE_TOLERANCE ||
      el.y + el.h > CANVAS_H + EDGE_TOLERANCE
    if (!outside) continue
    report(ctx, el, {
      severity: 'error',
      kind: 'off-slide',
      message: `${el.type} "${snippet(el)}" extends past the ${CANVAS_W}×${CANVAS_H} slide (box ${round(el.x)},${round(el.y)} ${round(el.w)}×${round(el.h)})`,
      fix: 'Move or resize the element so its box stays inside 0,0 to 1920,1080.',
    })
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

// ---- overflow ----

function checkOverflow(ctx: Ctx): void {
  for (const el of ctx.slide.elements) {
    if (el.type === 'text') {
      const need = textHeight(el)
      if (need > el.h + OVERFLOW_TOLERANCE) {
        report(ctx, el, {
          severity: 'error',
          kind: 'overflow',
          message: `Text "${snippet(el)}" needs ${Math.ceil(need)}px but its box is ${round(el.h)}px tall`,
          fix: 'Shorten the text, make the box taller, or set style.autoFit to "grow-box" (or "shrink" for headings).',
        })
      }
    } else if (el.type === 'shape' && el.text) {
      // Shape text is centred in the box with 0.5em padding on every side, at the size the renderer's base font gives.
      const inner = measureRich(el.text, { fontSize: SHAPE_TEXT_SIZE }, el.w - SHAPE_TEXT_SIZE).height
      if (inner > el.h - SHAPE_TEXT_SIZE + OVERFLOW_TOLERANCE) {
        report(ctx, el, {
          severity: 'error',
          kind: 'overflow',
          message: `Shape text needs ${Math.ceil(inner)}px but the shape is ${round(el.h)}px tall`,
          fix: 'Shorten the shape text or make the shape larger.',
        })
      }
    }
  }
}

// ---- overlap ----

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The measured extent of a text element: its box width, and the text block height clipped to the box. */
function textRect(el: TextElement): Rect {
  const block = textBlock(el)
  const top = Math.max(el.y, block.top)
  const bottom = Math.min(el.y + el.h, block.bottom)
  return { x: el.x, y: top, w: el.w, h: Math.max(0, bottom - top) }
}

function intersection(a: Rect, b: Rect): { ox: number; oy: number } {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return { ox, oy }
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

function sameInstance(a: Element, b: Element): boolean {
  return Boolean(a.component && b.component && a.component.instance === b.component.instance)
}

function rectOf(el: Element): Rect {
  return { x: el.x, y: el.y, w: el.w, h: el.h }
}

function checkOverlap(ctx: Ctx): void {
  const texts = ctx.slide.elements.filter((e): e is TextElement => e.type === 'text' && e.opacity > 0)
  const pictures = ctx.slide.elements.filter((e) => (e.type === 'image' || e.type === 'chart' || e.type === 'diagram') && e.opacity > 0)

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!
      const b = texts[j]!
      if (sameInstance(a, b)) continue
      const ra = textRect(a)
      const rb = textRect(b)
      const { ox, oy } = intersection(ra, rb)
      if (ox > OVERLAP_TOLERANCE && oy > OVERLAP_TOLERANCE) {
        report(ctx, a, {
          severity: 'warning',
          kind: 'overlap',
          message: `Text "${snippet(a)}" overlaps text "${snippet(b)}" by ${Math.round(ox)}×${Math.round(oy)}px`,
          fix: 'Move one of the boxes apart, or give the text box room for its measured height.',
          other: b,
        })
      }
    }
  }

  for (const t of texts) {
    const rt = textRect(t)
    for (const pic of pictures) {
      const rp = rectOf(pic)
      const { ox, oy } = intersection(rt, rp)
      if (ox > OVERLAP_TOLERANCE && oy > OVERLAP_TOLERANCE && !contains(rp, rt)) {
        report(ctx, t, {
          severity: 'warning',
          kind: 'overlap',
          message: `Text "${snippet(t)}" runs over ${pic.type} "${pic.id}" without being inside it`,
          fix: 'Move the text off the picture, or place it fully inside the picture box.',
          other: pic,
        })
      }
    }
  }
}

// ---- low contrast ----

interface Stops {
  stops: string[]
}

/**
 * The background the text sits on. The topmost opaque filled shape under the text centre wins; an image under the centre
 * makes the background unknown (the check is skipped). Otherwise the slide background, then the theme background.
 */
function backgroundAt(ctx: Ctx, el: TextElement): Stops | undefined {
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  const below = ctx.slide.elements
    .filter((e) => e.z < el.z && e.id !== el.id && e.opacity > 0)
    .filter((e) => cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h)
    .sort((a, b) => b.z - a.z)
  for (const e of below) {
    if (e.type === 'image') return undefined
    if (e.type !== 'shape' || e.shape === 'line') continue
    const stops = e.gradient
      ? e.gradient.stops.flatMap((s) => {
          const c = parseColor(s.color)
          return c && c.alpha >= 0.5 ? [c.hex] : []
        })
      : (() => {
          const c = parseColor(e.fill)
          return c && c.alpha >= 0.5 ? [c.hex] : []
        })()
    if (stops.length > 0) return { stops }
  }
  return slideBackground(ctx)
}

function slideBackground(ctx: Ctx): Stops | undefined {
  const { slide, deck } = ctx
  const theme: Theme = deck.theme
  const bg = slide.background
  if (bg?.type === 'image') return undefined
  if (bg?.type === 'color') return stopsOrUndefined([parseColor(bg.value)?.hex].filter(Boolean) as string[])
  if (bg?.type === 'gradient') return stopsOrUndefined(opaqueStops(bg.value))
  if (slide.variant === 'dark') {
    const dv = deriveDarkVariant(theme)
    if (dv.background.type === 'color') return stopsOrUndefined([parseColor(dv.background.value)?.hex].filter(Boolean) as string[])
    return stopsOrUndefined(opaqueStops(dv.background.value))
  }
  if (theme.backgroundStyle === 'image') return undefined
  if (theme.backgroundStyle === 'gradient' && theme.backgroundValue) return stopsOrUndefined(opaqueStops(theme.backgroundValue))
  return stopsOrUndefined([theme.colors.background])
}

function stopsOrUndefined(stops: string[]): Stops | undefined {
  return stops.length > 0 ? { stops } : undefined
}

function defaultTextColor(ctx: Ctx): string {
  if (ctx.slide.variant === 'dark') return deriveDarkVariant(ctx.deck.theme).text
  return ctx.deck.theme.colors.text
}

/** Text colours in a text element: its style colour (or the default) and every textStyle mark colour in its content. */
function textColors(ctx: Ctx, el: TextElement): string[] {
  const out = new Set<string>([el.style.color ?? defaultTextColor(ctx)])
  const walk = (node: RichNode | undefined) => {
    if (!node) return
    for (const m of node.marks ?? []) if (m.type === 'textStyle' && m.attrs.color) out.add(m.attrs.color)
    for (const c of node.content ?? []) walk(c)
  }
  walk(el.content as RichNode)
  return [...out]
}

function checkContrast(ctx: Ctx): void {
  for (const el of ctx.slide.elements) {
    if (el.type !== 'text' || el.opacity === 0) continue
    const bg = backgroundAt(ctx, el)
    if (!bg) continue
    const size = el.style.fontSize ?? DEFAULT_TEXT_SIZE
    const weight = el.style.fontWeight ?? 400
    const large = size >= 32 || (size >= 24 && weight >= 700)
    const need = large ? 3 : 4.5
    for (const color of textColors(ctx, el)) {
      const parsed = parseColor(color)
      if (!parsed) continue
      let worst = Number.POSITIVE_INFINITY
      let worstStop = bg.stops[0]!
      for (const stop of bg.stops) {
        const ratio = contrastRatio(parsed.hex, stop)
        if (ratio < worst) {
          worst = ratio
          worstStop = stop
        }
      }
      if (worst < need) {
        report(ctx, el, {
          severity: 'error',
          kind: 'low-contrast',
          message: `Text "${snippet(el)}" in ${parsed.hex} on ${worstStop} is ${worst.toFixed(2)}:1; needs ${need}:1`,
          fix: `Use a text colour with at least ${need}:1 contrast on the background, or change the background behind the text.`,
        })
        break
      }
    }
  }
}

// ---- alt text ----

function checkAlt(ctx: Ctx): void {
  for (const el of ctx.slide.elements) {
    if (el.type === 'image' && el.src.trim() !== '' && !el.alt?.trim()) {
      report(ctx, el, {
        severity: 'warning',
        kind: 'missing-alt',
        message: `Image ${el.id} has no alt text`,
        fix: 'Set alt to a short description of the picture.',
      })
    } else if ((el.type === 'chart' || el.type === 'diagram') && !el.alt?.trim()) {
      report(ctx, el, {
        severity: 'warning',
        kind: 'missing-alt',
        message: `${el.type} ${el.id} has no alt text`,
        fix: 'Set alt to a short description of what the chart or diagram shows.',
      })
    }
  }
}

// ---- empty slides ----

/** A slide with no elements shows a blank page. A warning, so it is seen before the deck is shared. */
function checkEmpty(ctx: Ctx): void {
  if (ctx.slide.elements.length > 0) return
  ctx.issues.push({
    severity: 'warning',
    kind: 'empty-slide',
    slideId: ctx.slide.id,
    slideIndex: ctx.slideIndex,
    elementId: ctx.slide.id,
    message: `Slide ${ctx.slideIndex + 1} has no elements, so it is a blank page`,
    fix: 'Add its content (add_slide with components or a layout), or delete the slide with delete_slide.',
  })
}

// ---- secondary language ----

function checkTranslation(ctx: Ctx): void {
  if (!ctx.deck.secondaryLanguage) return
  const els = ctx.slide.elements
  for (const el of els) {
    const part = el.component?.part
    if (!part) continue
    const cut = part.lastIndexOf('.')
    const last = cut >= 0 ? part.slice(cut + 1) : part
    if (!TRANSLATABLE_PARTS.has(last)) continue
    const group = cut >= 0 ? part.slice(0, cut) : ''
    const secondaryPart = group ? `${group}.secondary` : 'secondary'
    const has = els.some((e) => e.component?.instance === el.component?.instance && e.component?.part === secondaryPart)
    if (!has) {
      report(ctx, el, {
        severity: 'info',
        kind: 'missing-translation',
        message: `${el.component!.kind} "${part}" has no ${ctx.deck.secondaryLanguage} line (part "${secondaryPart}")`,
        fix: `Add the ${ctx.deck.secondaryLanguage} text as the secondary field of this item, or leave it as is.`,
      })
    }
  }
}

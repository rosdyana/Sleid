// The compact view of a deck for agents (get_deck format "compact"), and the data-URL redaction that get_deck_style uses.
// Defaults are dropped, numbers are rounded, rich text becomes markdown, and image bytes and vector paths are summarised.
// Pure: nothing here reads the database.
import type { Deck, Element, RichNode, Slide } from '@sleid/model'
import { selectSlides, type SlideSelection } from './compile.ts'

const DATA_URL = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]*)$/i

/** A data URL as a short description: its type and size, without the bytes. */
export function describeDataUrl(value: string): string | null {
  const match = DATA_URL.exec(value)
  if (!match) return null
  const kb = Math.max(1, Math.round((match[2]!.length * 3) / 4 / 1024))
  return `data:${match[1]} (${kb} KB)`
}

/** A copy of a JSON value with every base64 data URL replaced by its description. Other values are unchanged. */
export function redactDataUrls(value: unknown): unknown {
  if (typeof value === 'string') return describeDataUrl(value) ?? value
  if (Array.isArray(value)) return value.map(redactDataUrls)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) out[key] = redactDataUrls(v)
    return out
  }
  return value
}

/** One decimal place. A small non-zero value keeps three, so letter spacing like -0.02 is not lost. */
function roundNumber(n: number): number {
  const one = Math.round(n * 10) / 10
  if (one === 0 && n !== 0) return Math.round(n * 1000) / 1000
  return one
}

function roundNumbers(value: unknown): unknown {
  if (typeof value === 'number') return roundNumber(value)
  if (Array.isArray(value)) return value.map(roundNumbers)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) out[key] = roundNumbers(v)
    return out
  }
  return value
}

/** Text of a rich-text node as markdown: **bold**, *italic*, and "- " for list items. One line per paragraph. */
export function richToMarkdown(node: unknown): string {
  return blockLines(node as RichNode).join('\n')
}

function inline(node: RichNode): string {
  if (node.type === 'text') {
    let text = node.text ?? ''
    const marks = (node.marks ?? []).map((m) => m.type)
    if (text && marks.includes('bold')) text = `**${text}**`
    if (text && marks.includes('italic')) text = `*${text}*`
    return text
  }
  return (node.content ?? []).map(inline).join('')
}

function blockLines(node: RichNode): string[] {
  switch (node.type) {
    case 'paragraph': {
      const line = inline(node).trim()
      return line ? [line] : []
    }
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? []).flatMap((item) => {
        const lines = (item.content ?? []).flatMap(blockLines)
        return lines.map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`))
      })
    default:
      return (node.content ?? []).flatMap(blockLines)
  }
}

/** Drops the style fields that hold their default value: align left, valign top, and no stroke. */
function compactStyle(style: Record<string, unknown>): Record<string, unknown> {
  const out = { ...style }
  if (out.align === 'left') delete out.align
  if (out.valign === 'top') delete out.valign
  if (out.stroke === 'transparent') delete out.stroke
  if (out.strokeWidth === 0) delete out.strokeWidth
  return out
}

/** Drops the fields that hold their default value. The element's order in the slide is its z-order, so z goes too. */
function compactElement(el: Element, includeVectors: boolean): Record<string, unknown> {
  const raw = structuredClone(el) as unknown as Record<string, unknown>
  delete raw.z
  if (raw.rotation === 0) delete raw.rotation
  if (raw.locked === false) delete raw.locked
  if (raw.opacity === 1) delete raw.opacity
  // An animation is written as "effect/order" (for example "fade-up/3"): the same two facts, in fewer bytes.
  if (el.animation) raw.animation = `${el.animation.effect}/${el.animation.order}`
  if (el.type === 'text') {
    raw.text = richToMarkdown(el.content)
    delete raw.content
    raw.style = compactStyle(raw.style as Record<string, unknown>)
  }
  if (el.type === 'shape') {
    if (el.text) {
      const text = richToMarkdown(el.text)
      if (text) raw.text = text
      else delete raw.text
    }
    if (raw.stroke === 'transparent') delete raw.stroke
    if (raw.strokeWidth === 0) delete raw.strokeWidth
  }
  if (el.type === 'vector' && !includeVectors) raw.paths = { paths: el.paths.length }
  return roundNumbers(redactDataUrls(raw)) as Record<string, unknown>
}

function compactSlide(slide: Slide, includeVectors: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { id: slide.id, layout: slide.layout }
  if (slide.sectionId) out.sectionId = slide.sectionId
  if (slide.variant) out.variant = slide.variant
  if (slide.background) out.background = redactDataUrls(slide.background)
  if (slide.notes) out.notes = slide.notes
  if (slide.transition !== 'none') out.transition = slide.transition
  if (slide.autoAnimate) out.autoAnimate = true
  if (slide.hidden) out.hidden = true
  out.elements = slide.elements.map((el) => compactElement(el, includeVectors))
  return out
}

export interface CompactOptions extends SlideSelection {
  includeVectors?: boolean | undefined
}

/** Shape fields that make up the paint of a shape: the fill, the outline, the corner and the shadow. */
const PAINT_FIELDS = ['fill', 'stroke', 'strokeWidth', 'radius', 'shadow', 'gradient', 'strokeDash'] as const

/**
 * Repeated values, written once in a table at the top of the compact deck and referred to by key: text styles (`styles`,
 * keys s1, s2, ...), shape paint (`paints`, p1, ...) and image sources (`images`, i1, ...). The keys are numbered in the
 * order they first appear, so the same value always has the same key within one read.
 */
function hoistTables(slides: Array<Record<string, unknown>>): { styles: Record<string, unknown>; paints: Record<string, unknown>; images: Record<string, unknown> } {
  const tables = { styles: {} as Record<string, unknown>, paints: {} as Record<string, unknown>, images: {} as Record<string, unknown> }
  const seen = new Map<string, string>()
  const keyOf = (table: keyof typeof tables, prefix: string, value: unknown): string => {
    const json = `${table}:${JSON.stringify(value)}`
    const known = seen.get(json)
    if (known) return known
    const key = `${prefix}${Object.keys(tables[table]).length + 1}`
    tables[table][key] = value
    seen.set(json, key)
    return key
  }
  for (const slide of slides) {
    for (const el of (slide.elements ?? []) as Array<Record<string, unknown>>) {
      if (el.style && typeof el.style === 'object') el.style = keyOf('styles', 's', el.style)
      if (el.type === 'shape') {
        const paint: Record<string, unknown> = {}
        for (const field of PAINT_FIELDS) {
          if (field in el) {
            paint[field] = el[field]
            delete el[field]
          }
        }
        if (Object.keys(paint).length > 0) el.paint = keyOf('paints', 'p', paint)
      }
      if (typeof el.src === 'string') el.src = keyOf('images', 'i', el.src)
    }
  }
  return tables
}

/**
 * The deck for agents: the same document as the json format, smaller. The slide selection works as in the outline. Each
 * slide keeps its deck index in `index`, so a selection still says where its slides are. Repeated text styles, shape paint
 * and image sources are in the `styles`, `paints` and `images` tables at the top, and elements refer to them by key.
 */
export function compactDeck(deck: Deck, opts: CompactOptions = {}): Record<string, unknown> {
  const picks = selectSlides(deck, opts)
  const includeVectors = opts.includeVectors === true
  const slides = picks.map(({ slide, index }) => ({ index, ...compactSlide(slide, includeVectors) }))
  const tables = hoistTables(slides)
  const out: Record<string, unknown> = {
    id: deck.id,
    title: deck.title,
    theme: roundNumbers(redactDataUrls(deck.theme)),
    sections: deck.sections,
  }
  if (Object.keys(tables.styles).length > 0) out.styles = tables.styles
  if (Object.keys(tables.paints).length > 0) out.paints = tables.paints
  if (Object.keys(tables.images).length > 0) out.images = tables.images
  out.slides = slides
  if (deck.secondaryLanguage) out.secondaryLanguage = deck.secondaryLanguage
  if (deck.brand) out.brand = deck.brand
  return out
}

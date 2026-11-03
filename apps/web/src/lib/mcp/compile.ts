// Pure helpers for the MCP tools: they turn simple inputs into deck-ops and summarise decks for agents.
// Nothing here reads or writes the database.
import { randomUUID } from 'node:crypto'
import { BUILT_IN_THEMES, layoutElements, type Deck, type Element, type Slide, type SlideLayout, type TextElement, type Theme } from '@sleid/model'
import { ToolError } from './errors.ts'
import { markdownToRich, plainToRich, richToPlain } from './rich.ts'

/** Where a new title or body box goes when the layout has no placeholder for it (for example a blank slide). */
const TITLE_BOX = { x: 120, y: 72, w: 1680, h: 160 }
const BODY_BOX = { x: 120, y: 272, w: 1680, h: 728 }

export function findSlide(deck: Deck, slideId: string): Slide {
  const slide = deck.slides.find((s) => s.id === slideId)
  if (!slide) throw new ToolError(`No slide with id ${slideId} in this deck. Call get_deck to see the current ids.`)
  return slide
}

/** The slide at a 0-based index, or the one with the given id. Exactly one of the two must be given. */
export function resolveSlide(deck: Deck, input: { slideId?: string | undefined; index?: number | undefined }): Slide {
  if (input.slideId && input.index !== undefined) throw new ToolError('Give either slideId or index, not both.')
  if (input.slideId) return findSlide(deck, input.slideId)
  if (input.index !== undefined) {
    const slide = deck.slides[input.index]
    if (!slide) throw new ToolError(`There is no slide at index ${input.index}. The deck has ${deck.slides.length} slides (0 to ${deck.slides.length - 1}).`)
    return slide
  }
  throw new ToolError('Give slideId, or index (0-based).')
}

export function findElement(deck: Deck, elementId: string): { slide: Slide; element: Element } {
  for (const slide of deck.slides) {
    const element = slide.elements.find((e) => e.id === elementId)
    if (element) return { slide, element }
  }
  throw new ToolError(`No element with id ${elementId} in this deck. Call get_deck to see the current ids.`)
}

/** A text box for a title or body, styled from the theme the same way the layout placeholders are. */
function newTextBox(theme: Theme, role: 'title' | 'body', box: { x: number; y: number; w: number; h: number }, content: unknown): Element {
  const template = layoutElements('title-content', theme, () => randomUUID()).find((e) => e.type === 'text' && e.role === role)
  if (!template) throw new ToolError('The theme has no text style for this box.')
  return { ...template, id: randomUUID(), ...box, content } as unknown as Element
}

export interface SlideBuildInput {
  slideId: string
  layout: SlideLayout
  title?: string | undefined
  body?: string | undefined
  notes?: string | undefined
}

/**
 * The slide for an addSlide op. The layout's placeholders are filled from title and body. The body goes to the
 * first body box (or the subtitle, on a section or title slide). When there is no box for a given title or body,
 * a text box is added.
 */
export function buildSlide(deck: Deck, input: SlideBuildInput): { id: string; notes: string; elements: Element[] } {
  const theme = deck.theme
  const elements = layoutElements(input.layout, theme, () => randomUUID())
  const isText = (e: Element): e is TextElement => e.type === 'text'

  if (input.title) {
    const titleBox = elements.find((e) => isText(e) && e.role === 'title')
    if (titleBox) (titleBox as TextElement).content = plainToRich(input.title) as TextElement['content']
    else elements.push(newTextBox(theme, 'title', TITLE_BOX, plainToRich(input.title)))
  }
  if (input.body) {
    const target = elements.find((e) => isText(e) && e.role === 'body') ?? elements.find((e) => isText(e) && e.role === 'subtitle')
    if (target) (target as TextElement).content = markdownToRich(input.body) as TextElement['content']
    else elements.push(newTextBox(theme, 'body', BODY_BOX, markdownToRich(input.body)))
  }
  return {
    id: input.slideId,
    notes: input.notes ?? '',
    elements: elements.map((e, z) => ({ ...e, z })),
  }
}

/** Replacement content for a text box or a shape's text. Other element types cannot take text. */
export function textPatchFor(element: Element, text: string): { patch: Record<string, unknown> } {
  if (element.type === 'text') return { patch: { content: markdownToRich(text) } }
  if (element.type === 'shape') return { patch: { text: markdownToRich(text) } }
  throw new ToolError(`Element ${element.id} is a ${element.type}, not a text box. update_text works on text boxes and shapes.`)
}

/** Built-in theme by name, ignoring case and surrounding spaces. */
export function builtInTheme(name: string): Theme | undefined {
  const wanted = name.trim().toLowerCase()
  return BUILT_IN_THEMES.find((t) => t.name.toLowerCase() === wanted)
}

export function builtInThemeNames(): string[] {
  return BUILT_IN_THEMES.map((t) => t.name)
}

/** Summary of one element for an outline. Text is shortened; data stays out. */
export function summarizeElement(el: Element): Record<string, unknown> {
  const base = { id: el.id, type: el.type, x: Math.round(el.x), y: Math.round(el.y), w: Math.round(el.w), h: Math.round(el.h) }
  switch (el.type) {
    case 'text':
      return { ...base, role: el.role ?? null, text: clip(richToPlain(el.content), 160) }
    case 'shape':
      return { ...base, shape: el.shape, text: clip(richToPlain(el.text), 160) }
    case 'image':
      return { ...base, alt: el.alt ?? null, src: el.src.startsWith('data:') ? 'data: URL' : clip(el.src, 120) }
    case 'chart':
      return { ...base, chartType: el.chartType, title: el.options.title ?? null, columns: el.data.columns, rows: el.data.rows.length }
    case 'diagram':
      return { ...base, firstLine: clip(el.source.split('\n')[0] ?? '', 120) }
    case 'table':
      return { ...base, rows: el.rows.length, header: el.header }
    case 'code':
      return { ...base, language: el.language, firstLine: clip(el.code.split('\n')[0] ?? '', 120) }
    case 'embed':
      return { ...base, url: clip(el.url, 200) }
  }
}

/** The outline an agent reads first: slides by 0-based index, with ids, layout, title and a summary of each element. */
export function outlineOf(deck: Deck): Record<string, unknown> {
  return {
    deckId: deck.id,
    title: deck.title,
    theme: deck.theme.name,
    slideCount: deck.slides.length,
    slides: deck.slides.map((slide, index) => {
      const title = slide.elements.find((e) => e.type === 'text' && e.role === 'title')
      return {
        index,
        id: slide.id,
        layout: slide.layout,
        hidden: slide.hidden,
        section: slide.sectionId ?? null,
        title: title && title.type === 'text' ? clip(richToPlain(title.content), 160) : null,
        notes: clip(slide.notes, 300),
        elements: slide.elements.map(summarizeElement),
      }
    }),
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((b, i) => bytes[i] === b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

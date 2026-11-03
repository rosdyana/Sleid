// Pure view helpers for comments: pin numbers, what a thread is attached to, and the pins on a slide. No server
// imports, so the tests can run them without the web server.
import type { ThreadView } from '@sleid/db'
import type { Deck, Element } from '@sleid/model'

export interface Pin {
  threadId: string
  number: number
  x: number
  y: number
  resolved: boolean
  active: boolean
}

/** Pin numbers: per slide, in creation order. The same number shows on the canvas. */
export function pinNumbers(threads: ThreadView[]): Map<string, number> {
  const numbers = new Map<string, number>()
  const perSlide = new Map<string, number>()
  for (const thread of threads) {
    const n = (perSlide.get(thread.slideId) ?? 0) + 1
    perSlide.set(thread.slideId, n)
    numbers.set(thread.id, n)
  }
  return numbers
}

export function slideNumber(deck: Deck, slideId: string): number {
  const i = deck.slides.findIndex((s) => s.id === slideId)
  return i < 0 ? 0 : i + 1
}

const ELEMENT_NAMES: Record<string, string> = {
  text: 'Text box',
  shape: 'Shape',
  image: 'Image',
  chart: 'Chart',
  diagram: 'Diagram',
  table: 'Table',
  code: 'Code',
  embed: 'Embed',
}

/** A short name for an element, as the comments show it: "Title", "Chart", and so on. */
export function elementName(element: Element): string {
  if (element.type === 'text' && element.role) return element.role === 'title' ? 'Title' : element.role === 'subtitle' ? 'Subtitle' : 'Text'
  return ELEMENT_NAMES[element.type] ?? 'Element'
}

/** What a thread is attached to. An element deleted since then reads "element removed". */
export function anchorLabel(deck: Deck, thread: Pick<ThreadView, 'slideId' | 'elementId'>): { text: string; removed: boolean } {
  const slide = deck.slides.find((s) => s.id === thread.slideId)
  if (!slide) return { text: 'slide removed', removed: true }
  if (!thread.elementId) return { text: `Slide ${slideNumber(deck, thread.slideId)}`, removed: false }
  const element = slide.elements.find((e) => e.id === thread.elementId)
  if (!element) return { text: 'element removed', removed: true }
  return { text: elementName(element), removed: false }
}


export function pinsFor(threads: ThreadView[], slideId: string, numbers: Map<string, number>, activeId: string | null, showResolved: boolean): Pin[] {
  return threads
    .filter((t) => t.slideId === slideId && t.anchor && (showResolved || !t.resolved))
    .map((t) => ({ threadId: t.id, number: numbers.get(t.id) ?? 0, x: t.anchor!.x, y: t.anchor!.y, resolved: t.resolved, active: t.id === activeId }))
}

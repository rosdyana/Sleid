// Yjs binding for a deck.
//
// Layout of the doc (root Y.Map 'deck'):
//   id, title, version              primitives
//   size, theme                     Y.Map (fields merge one by one)
//   sections                        Y.Array<Y.Map { id, name }>
//   slides                          Y.Map<slideId, Y.Map>. Each slide Y.Map has its
//                                   meta fields, an `order` string (fractional index,
//                                   see fractional-indexing) and elements: Y.Array<Y.Map>
//   Element fields are Y.Maps. Nested plain objects (style, background, crop,
//   animation...) become nested Y.Maps, so two users editing different keys
//   of the same element both survive a merge.
//
// Slide order: the slide's position is only its `order` key. Moving a slide
// writes one string, so it never re-creates the slide's content. Two users
// moving the same slide leave one `order` value (last writer wins), and two
// users inserting between the same neighbours get equal keys, which sort by
// slide id. Plain Deck objects (schema.ts) keep `slides` as an ordered array.
//
// Opaque fields are stored as JSON values, not as Y.Maps:
//   text.content, shape.text (rich text), chart.data, chart.echartsOverride.
//   M2 moves rich text to Y.XmlFragment for y-prosemirror. Callers go through
//   yDocToDeck / applyOps and never touch the raw map, so that change stays
//   inside this file and ops.ts.
import * as Y from 'yjs'
import { generateNKeysBetween } from 'fractional-indexing'
import { DeckSchema, type Deck, type Element, type Slide } from './schema.ts'
import { writeFields, type PlainObject } from './patch.ts'

export const DECK_ROOT = 'deck'

export type YSlides = Y.Map<Y.Map<unknown>>
export type YElements = Y.Array<Y.Map<unknown>>
export type YSections = Y.Array<Y.Map<unknown>>

// Fields of an element that are stored as JSON, and replaced whole on update.
export function opaqueElementKeys(type: string): ReadonlySet<string> {
  switch (type) {
    case 'text':
      return new Set(['content'])
    case 'shape':
      return new Set(['text'])
    case 'chart':
      return new Set(['data', 'echartsOverride'])
    default:
      return new Set()
  }
}

export function getDeckMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(DECK_ROOT)
}

// Writes a slide's meta fields, elements and order key into a (new or existing) slide map.
export function writeSlideInto(target: Y.Map<unknown>, slide: Slide, order: string): void {
  const { elements, ...meta } = slide
  writeFields(target, meta as PlainObject)
  target.set('order', order)
  const arr: YElements = new Y.Array<Y.Map<unknown>>()
  target.set('elements', arr)
  for (const el of elements) appendElement(arr, el)
}

export function appendElement(elements: YElements, el: Element): void {
  const m = new Y.Map<unknown>()
  elements.push([m])
  writeFields(m, el as PlainObject, opaqueElementKeys(el.type))
}

export function deckToYDoc(deck: Deck): Y.Doc {
  const parsed = DeckSchema.parse(deck)
  const doc = new Y.Doc()
  doc.transact(() => {
    const root = getDeckMap(doc)
    root.set('id', parsed.id)
    root.set('title', parsed.title)
    root.set('version', parsed.version)

    const size = new Y.Map<unknown>()
    root.set('size', size)
    writeFields(size, parsed.size)

    const theme = new Y.Map<unknown>()
    root.set('theme', theme)
    writeFields(theme, parsed.theme)

    const sections: YSections = new Y.Array<Y.Map<unknown>>()
    root.set('sections', sections)
    for (const s of parsed.sections) {
      const m = new Y.Map<unknown>()
      sections.push([m])
      writeFields(m, s as PlainObject)
    }

    const slides: YSlides = new Y.Map<Y.Map<unknown>>()
    root.set('slides', slides)
    const orders = generateNKeysBetween(null, null, parsed.slides.length)
    parsed.slides.forEach((s, i) => {
      const m = new Y.Map<unknown>()
      slides.set(s.id, m)
      writeSlideInto(m, s, orders[i]!)
    })
  })
  return doc
}

export interface SlideEntry {
  id: string
  order: string
  map: Y.Map<unknown>
}

// Slide maps in deck order: by `order`, then by id for ties.
export function slideEntriesInOrder(slides: YSlides): SlideEntry[] {
  const entries: SlideEntry[] = []
  slides.forEach((map, id) => {
    const order = map.get('order')
    entries.push({ id, order: typeof order === 'string' ? order : '', map })
  })
  return entries.sort((a, b) => (a.order !== b.order ? (a.order < b.order ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// Reads the doc back into the plain Deck form, validated by zod.
export function yDocToDeck(doc: Y.Doc): Deck {
  const root = getDeckMap(doc)
  const slidesMap = root.get('slides')
  const slides =
    slidesMap instanceof Y.Map
      ? slideEntriesInOrder(slidesMap as YSlides).map(({ map }) => {
          const { order: _order, ...slide } = map.toJSON() as Record<string, unknown>
          return slide
        })
      : undefined
  const raw = root.toJSON() as Record<string, unknown>
  return DeckSchema.parse({ ...raw, slides })
}

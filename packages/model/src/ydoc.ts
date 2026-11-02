// Yjs binding for a deck.
//
// Layout of the doc (root Y.Map 'deck'):
//   id, title, version              primitives
//   size, theme                     Y.Map (fields merge one by one)
//   sections                        Y.Array<Y.Map { id, name }>
//   slides                          Y.Array<Y.Map>, each with meta fields and
//                                   elements: Y.Array<Y.Map>
//   Element fields are Y.Maps. Nested plain objects (style, background, crop,
//   animation...) become nested Y.Maps, so two users editing different keys
//   of the same element both survive a merge.
//
// Opaque fields are stored as JSON values, not as Y.Maps:
//   text.content, shape.text (rich text), chart.data, chart.echartsOverride.
//   M2 moves rich text to Y.XmlFragment for y-prosemirror. Callers go through
//   yDocToDeck / applyOps and never touch the raw map, so that change stays
//   inside this file and ops.ts.
//
// Known limitation: slides live in an array, so a move re-creates the slide's
// Y.Map. An edit to that slide made concurrently with a move can be lost, and
// two concurrent moves of one slide can leave a duplicate that yDocToDeck
// drops (it keeps the first occurrence by id). Both replicas still converge.
import * as Y from 'yjs'
import { DeckSchema, type Deck, type Element, type Slide } from './schema.ts'
import { writeFields, type PlainObject } from './patch.ts'

export const DECK_ROOT = 'deck'

export type YSlides = Y.Array<Y.Map<unknown>>
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

export function writeSlideInto(target: Y.Map<unknown>, slide: Slide): void {
  const { elements, ...meta } = slide
  writeFields(target, meta as PlainObject)
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

    const slides: YSlides = new Y.Array<Y.Map<unknown>>()
    root.set('slides', slides)
    for (const s of parsed.slides) {
      const m = new Y.Map<unknown>()
      slides.push([m])
      writeSlideInto(m, s)
    }
  })
  return doc
}

// Reads the doc back into the plain Deck form, validated by zod. Slides that
// share an id (possible after concurrent moves) are reduced to the first one.
export function yDocToDeck(doc: Y.Doc): Deck {
  const raw = getDeckMap(doc).toJSON() as Record<string, unknown>
  const slides = Array.isArray(raw.slides) ? dedupeById(raw.slides as Array<{ id: string }>) : raw.slides
  return DeckSchema.parse({ ...raw, slides })
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

// Deck-ops: the only way to change a deck. The UI, the AI assistant and the
// MCP server all call applyOps(doc, ops, origin).
//
// No partial apply. applyOps works in two passes:
//   1. Parse every op with zod and fill in ids that must be known before the
//      batch runs (new slide, new element, new section, duplicate target).
//   2. Dry run: apply the whole batch to a scratch copy of the doc. Any invalid
//      target, duplicate id or failed validation throws OpError here, and the
//      real doc has not been touched.
//   3. Real run: apply the same batch to the real doc inside one
//      doc.transact(fn, origin). Since the dry run passed on the same state,
//      this run does not fail.
//
// Ids: a batch can refer to what an earlier op in it created. addSlide,
// addElement, addSection and duplicateSlide therefore get their ids in step 1.
// Placeholder elements from a layout get ids `${slideId}-${index}`.
import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import { layoutElements } from './defaults.ts'
import { mergePatch, writeFields, type PlainObject } from './patch.ts'
import {
  BrandLogoSchema,
  ElementInputSchema,
  ElementSchema,
  SLIDE_LAYOUTS,
  SectionSchema,
  SlideBackgroundSchema,
  SlideMetaSchema,
  SlideSchema,
  ThemeSchema,
  type Element,
  type Theme,
} from './schema.ts'
import {
  appendElement,
  getDeckMap,
  opaqueElementKeys,
  slideEntriesInOrder,
  writeSlideInto,
  type SlideEntry,
  type YElements,
  type YSections,
  type YSlides,
} from './ydoc.ts'

// ---------------------------------------------------------------------------
// Op schemas (JSON-serialisable, so MCP and LLM callers can send them)
// ---------------------------------------------------------------------------

const Id = z.string().min(1)

const SlideInputSchema = SlideMetaSchema.omit({ layout: true })
  .partial()
  .extend({
    id: Id.optional(),
    elements: z.array(ElementInputSchema).optional(),
  })

const SlidePatchSchema = SlideMetaSchema.partial().extend({
  sectionId: Id.nullish(),
  background: SlideBackgroundSchema.nullish(),
})

export const OpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('addSlide'),
    index: z.number().int().min(0).optional(),
    layout: z.enum(SLIDE_LAYOUTS),
    slide: SlideInputSchema.optional(),
  }),
  z.object({ op: z.literal('deleteSlide'), slideId: Id }),
  z.object({ op: z.literal('duplicateSlide'), slideId: Id, newSlideId: Id.optional() }),
  z.object({ op: z.literal('moveSlide'), slideId: Id, toIndex: z.number().int().min(0) }),
  z.object({ op: z.literal('updateSlide'), slideId: Id, patch: SlidePatchSchema }),
  z.object({ op: z.literal('addElement'), slideId: Id, element: ElementInputSchema }),
  z.object({
    op: z.literal('updateElement'),
    slideId: Id,
    elementId: Id,
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({ op: z.literal('deleteElement'), slideId: Id, elementId: Id }),
  z.object({
    op: z.literal('reorderElement'),
    slideId: Id,
    elementId: Id,
    z: z.enum(['front', 'back', 'forward', 'backward']),
  }),
  z.object({ op: z.literal('setTheme'), theme: z.record(z.string(), z.unknown()) }),
  // M9. brandKitId null removes the kit (theme kept, logo cleared). Otherwise theme is the kit's full theme.
  z.object({
    op: z.literal('setBrandKit'),
    brandKitId: Id.nullable(),
    theme: ThemeSchema.optional(),
    logo: BrandLogoSchema.nullish(),
  }),
  z.object({ op: z.literal('setTitle'), title: z.string() }),
  z.object({
    op: z.literal('addSection'),
    id: Id.optional(),
    name: z.string(),
    index: z.number().int().min(0).optional(),
  }),
  z.object({ op: z.literal('renameSection'), sectionId: Id, name: z.string() }),
  z.object({ op: z.literal('deleteSection'), sectionId: Id }),
  z.object({ op: z.literal('setNotes'), slideId: Id, notes: z.string() }),
])

export type Op = z.infer<typeof OpSchema>
export type OpName = Op['op']

// ---------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------

export interface OpResult {
  ok: true
  id?: string
}

export interface ApplyResult {
  results: OpResult[]
}

export class OpError extends Error {
  readonly opIndex: number
  readonly opName: string
  readonly reason: string

  constructor(opIndex: number, opName: string, reason: string) {
    super(`deck-op ${opIndex} (${opName}) failed: ${reason}`)
    this.name = 'OpError'
    this.opIndex = opIndex
    this.opName = opName
    this.reason = reason
  }
}

// Thrown by helpers. runOps turns it into an OpError with the op's index.
function fail(reason: string): never {
  throw new Error(reason)
}

function describeOp(raw: unknown): string {
  return typeof raw === 'object' && raw !== null && 'op' in raw ? String(raw.op) : '?'
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

// ---------------------------------------------------------------------------
// Parsing and id assignment
// ---------------------------------------------------------------------------

function normalize(op: Op): Op {
  switch (op.op) {
    case 'addSlide': {
      const slideIn = op.slide ?? {}
      const elements = slideIn.elements?.map((el) => ({ ...el, id: el.id ?? nanoid() }))
      return { ...op, slide: { ...slideIn, id: slideIn.id ?? nanoid(), ...(elements ? { elements } : {}) } }
    }
    case 'addElement':
      return { ...op, element: { ...op.element, id: op.element.id ?? nanoid() } }
    case 'addSection':
      return { ...op, id: op.id ?? nanoid() }
    case 'duplicateSlide':
      return { ...op, newSlideId: op.newSlideId ?? nanoid() }
    default:
      return op
  }
}

export function parseOps(input: readonly unknown[]): Op[] {
  return input.map((raw, index) => {
    const parsed = OpSchema.safeParse(raw)
    if (!parsed.success) throw new OpError(index, describeOp(raw), formatIssues(parsed.error))
    return normalize(parsed.data)
  })
}

// ---------------------------------------------------------------------------
// Doc helpers
// ---------------------------------------------------------------------------

function slidesOf(doc: Y.Doc): YSlides {
  const slides = getDeckMap(doc).get('slides')
  if (!(slides instanceof Y.Map)) fail('deck is not initialised')
  return slides as YSlides
}

function sectionsOf(doc: Y.Doc): YSections {
  const sections = getDeckMap(doc).get('sections')
  if (!(sections instanceof Y.Array)) fail('deck is not initialised')
  return sections as YSections
}

function themeOf(doc: Y.Doc): Y.Map<unknown> {
  const theme = getDeckMap(doc).get('theme')
  if (!(theme instanceof Y.Map)) fail('deck is not initialised')
  return theme as Y.Map<unknown>
}

function readTheme(doc: Y.Doc): Theme {
  return ThemeSchema.parse(themeOf(doc).toJSON())
}

function slideAt(doc: Y.Doc, slideId: string): { slides: YSlides; map: Y.Map<unknown> } {
  const slides = slidesOf(doc)
  const map = slides.get(slideId)
  if (!(map instanceof Y.Map)) fail(`slide not found: ${slideId}`)
  return { slides, map: map as Y.Map<unknown> }
}

// A slide's plain fields, without the storage-only order key.
function slideJson(map: Y.Map<unknown>): PlainObject {
  const { order: _order, ...rest } = map.toJSON() as PlainObject
  return rest
}

// Order key for a slide placed at `index` among `others` (every other slide, in
// order). Equal neighbour keys can happen after concurrent inserts, so in that
// case the others are respaced first, so that a key fits between them.
function orderAt(others: SlideEntry[], index: number): string {
  const prev = others[index - 1]
  const next = others[index]
  if (prev && next && prev.order >= next.order) {
    const keys = generateNKeysBetween(null, null, others.length)
    others.forEach((entry, i) => {
      entry.map.set('order', keys[i]!)
      entry.order = keys[i]!
    })
    return generateKeyBetween(others[index - 1]?.order ?? null, others[index]?.order ?? null)
  }
  return generateKeyBetween(prev?.order ?? null, next?.order ?? null)
}

function elementsOf(slideMap: Y.Map<unknown>): YElements {
  const elements = slideMap.get('elements')
  if (!(elements instanceof Y.Array)) fail('slide has no elements list')
  return elements as YElements
}

function indexOfElement(elements: YElements, elementId: string): number {
  return elements.toArray().findIndex((m) => m.get('id') === elementId)
}

function elementAt(doc: Y.Doc, slideId: string, elementId: string): Y.Map<unknown> {
  const { map } = slideAt(doc, slideId)
  const elements = elementsOf(map)
  const index = indexOfElement(elements, elementId)
  if (index < 0) fail(`element not found: ${elementId} on slide ${slideId}`)
  return elements.get(index) as Y.Map<unknown>
}

function indexOfSection(sections: YSections, sectionId: string): number {
  return sections.toArray().findIndex((m) => m.get('id') === sectionId)
}

function requireSection(doc: Y.Doc, sectionId: string): void {
  if (indexOfSection(sectionsOf(doc), sectionId) < 0) fail(`section not found: ${sectionId}`)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// zod strips unknown keys when it parses the merged result. Reject unknown
// top-level keys here so they cannot be written to the doc and then silently
// dropped. Keys set to null are deletions, so they are allowed.
function assertKnownKeys(patch: PlainObject, parsed: PlainObject): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    if (!(key in parsed)) fail(`unknown field: ${key}`)
  }
}

function ok(id?: string): OpResult {
  return id === undefined ? { ok: true } : { ok: true, id }
}

// ---------------------------------------------------------------------------
// Op implementations. Each one validates before it writes.
// ---------------------------------------------------------------------------

function addSlide(doc: Y.Doc, op: Extract<Op, { op: 'addSlide' }>): OpResult {
  const slides = slidesOf(doc)
  const slideIn = op.slide ?? {}
  const id = slideIn.id ?? fail('internal: slide id missing')
  if (slides.has(id)) fail(`slide id already exists: ${id}`)
  if (slideIn.sectionId !== undefined) requireSection(doc, slideIn.sectionId)

  const theme = readTheme(doc)
  const elements = (slideIn.elements ?? layoutElements(op.layout, theme, (i) => `${id}-${i}`)) as Element[]
  const withZ = elements.map((el, i) => ({ ...el, z: el.z ?? i }))

  const slide = SlideSchema.parse({
    id,
    layout: op.layout,
    sectionId: slideIn.sectionId,
    background: slideIn.background,
    notes: slideIn.notes ?? '',
    transition: slideIn.transition ?? 'none',
    autoAnimate: slideIn.autoAnimate ?? false,
    hidden: slideIn.hidden ?? false,
    elements: withZ,
  })
  assertUniqueElementIds(slide.elements)

  const others = slideEntriesInOrder(slides)
  const index = clamp(op.index ?? others.length, 0, others.length)
  const order = orderAt(others, index)
  const m = new Y.Map<unknown>()
  slides.set(id, m)
  writeSlideInto(m, slide, order)
  return ok(id)
}

function assertUniqueElementIds(elements: Element[]): void {
  const seen = new Set<string>()
  for (const el of elements) {
    if (seen.has(el.id)) fail(`duplicate element id in slide: ${el.id}`)
    seen.add(el.id)
  }
}

function deleteSlide(doc: Y.Doc, op: Extract<Op, { op: 'deleteSlide' }>): OpResult {
  const { slides } = slideAt(doc, op.slideId)
  slides.delete(op.slideId)
  return ok()
}

function duplicateSlide(doc: Y.Doc, op: Extract<Op, { op: 'duplicateSlide' }>): OpResult {
  const { slides, map } = slideAt(doc, op.slideId)
  const newId = op.newSlideId ?? fail('internal: new slide id missing')
  if (slides.has(newId)) fail(`slide id already exists: ${newId}`)

  const source = SlideSchema.parse(slideJson(map))
  const copy = SlideSchema.parse({
    ...source,
    id: newId,
    elements: source.elements.map((el) => ({ ...el, id: nanoid() })),
  })
  const others = slideEntriesInOrder(slides)
  const sourceIndex = others.findIndex((e) => e.id === op.slideId)
  const order = orderAt(others, sourceIndex + 1)
  const m = new Y.Map<unknown>()
  slides.set(newId, m)
  writeSlideInto(m, copy, order)
  return ok(newId)
}

// toIndex is the final position of the slide, clamped to the list. Only the
// `order` key is written, so the slide's content is never re-created.
function moveSlide(doc: Y.Doc, op: Extract<Op, { op: 'moveSlide' }>): OpResult {
  const { slides, map } = slideAt(doc, op.slideId)
  const entries = slideEntriesInOrder(slides)
  const from = entries.findIndex((e) => e.id === op.slideId)
  const target = clamp(op.toIndex, 0, entries.length - 1)
  if (from === target) return ok()

  const others = entries.filter((e) => e.id !== op.slideId)
  map.set('order', orderAt(others, target))
  return ok()
}

function updateSlide(doc: Y.Doc, op: Extract<Op, { op: 'updateSlide' }>): OpResult {
  const { map } = slideAt(doc, op.slideId)
  const { id: _id, elements: _elements, ...meta } = slideJson(map)
  const patch = op.patch as PlainObject
  if (typeof patch.sectionId === 'string') requireSection(doc, patch.sectionId)

  const parsed = SlideMetaSchema.parse(mergePatch(meta, patch))
  assertKnownKeys(patch, parsed)
  writeFields(map, patch)
  return ok()
}

function addElement(doc: Y.Doc, op: Extract<Op, { op: 'addElement' }>): OpResult {
  const { map } = slideAt(doc, op.slideId)
  const elements = elementsOf(map)
  const id = op.element.id ?? fail('internal: element id missing')
  if (indexOfElement(elements, id) >= 0) fail(`element id already exists: ${id}`)

  const zValues = elements.toArray().map((m) => Number(m.get('z')))
  const z = op.element.z ?? (zValues.length === 0 ? 0 : Math.max(...zValues) + 1)
  const el = ElementSchema.parse({ ...op.element, id, z })
  appendElement(elements, el)
  return ok(id)
}

function updateElement(doc: Y.Doc, op: Extract<Op, { op: 'updateElement' }>): OpResult {
  const patch = op.patch
  if ('id' in patch || 'type' in patch) fail('id and type cannot be changed by updateElement')

  const elMap = elementAt(doc, op.slideId, op.elementId)
  const current = elMap.toJSON() as PlainObject
  const opaque = opaqueElementKeys(String(current.type))
  const parsed = ElementSchema.parse(mergePatch(current, patch, opaque))
  assertKnownKeys(patch, parsed)
  writeFields(elMap, patch, opaque)
  return ok()
}

function deleteElement(doc: Y.Doc, op: Extract<Op, { op: 'deleteElement' }>): OpResult {
  const { map } = slideAt(doc, op.slideId)
  const elements = elementsOf(map)
  const index = indexOfElement(elements, op.elementId)
  if (index < 0) fail(`element not found: ${op.elementId} on slide ${op.slideId}`)
  elements.delete(index, 1)
  return ok()
}

// z-order is a number per element. front/back move past the extremes.
// forward/backward swap z with the nearest neighbour, if there is one.
function reorderElement(doc: Y.Doc, op: Extract<Op, { op: 'reorderElement' }>): OpResult {
  const elMap = elementAt(doc, op.slideId, op.elementId)
  const { map } = slideAt(doc, op.slideId)
  const siblings = elementsOf(map)
    .toArray()
    .map((m) => ({ map: m, z: Number(m.get('z')) }))
  const current = Number(elMap.get('z'))

  switch (op.z) {
    case 'front':
      elMap.set('z', Math.max(...siblings.map((s) => s.z)) + 1)
      break
    case 'back':
      elMap.set('z', Math.min(...siblings.map((s) => s.z)) - 1)
      break
    case 'forward': {
      const above = siblings.filter((s) => s.z > current).sort((a, b) => a.z - b.z)[0]
      if (above) {
        above.map.set('z', current)
        elMap.set('z', above.z)
      }
      break
    }
    case 'backward': {
      const below = siblings.filter((s) => s.z < current).sort((a, b) => b.z - a.z)[0]
      if (below) {
        below.map.set('z', current)
        elMap.set('z', below.z)
      }
      break
    }
  }
  return ok()
}

function setTheme(doc: Y.Doc, op: Extract<Op, { op: 'setTheme' }>): OpResult {
  const themeMap = themeOf(doc)
  const parsed = ThemeSchema.parse(mergePatch(themeMap.toJSON() as PlainObject, op.theme))
  assertKnownKeys(op.theme, parsed)
  writeFields(themeMap, op.theme)
  return ok()
}

// Applies a brand kit: replaces the theme with the kit's theme and records the kit and its logo in the deck.
// The theme is replaced whole (not merged), so no token of the previous theme survives.
function setBrandKit(doc: Y.Doc, op: Extract<Op, { op: 'setBrandKit' }>): OpResult {
  const root = getDeckMap(doc)
  if (op.brandKitId === null) {
    if (op.theme) fail('a theme cannot be set when a brand kit is removed')
    root.delete('brand')
    return ok()
  }
  if (!op.theme) fail('applying a brand kit needs its theme')
  const themeMap = themeOf(doc)
  for (const key of [...themeMap.keys()]) themeMap.delete(key)
  writeFields(themeMap, op.theme as PlainObject)

  root.delete('brand')
  const brand = new Y.Map<unknown>()
  root.set('brand', brand)
  writeFields(brand, {
    brandKitId: op.brandKitId,
    palette: { ...op.theme.colors },
    fonts: { heading: op.theme.fonts.heading, body: op.theme.fonts.body },
    ...(op.logo ? { logo: op.logo } : {}),
  })
  return ok()
}

function setTitle(doc: Y.Doc, op: Extract<Op, { op: 'setTitle' }>): OpResult {
  getDeckMap(doc).set('title', op.title)
  return ok()
}

function addSection(doc: Y.Doc, op: Extract<Op, { op: 'addSection' }>): OpResult {
  const sections = sectionsOf(doc)
  const id = op.id ?? fail('internal: section id missing')
  if (indexOfSection(sections, id) >= 0) fail(`section id already exists: ${id}`)
  const section = SectionSchema.parse({ id, name: op.name })
  const index = clamp(op.index ?? sections.length, 0, sections.length)
  const m = new Y.Map<unknown>()
  sections.insert(index, [m])
  writeFields(m, section)
  return ok(id)
}

function renameSection(doc: Y.Doc, op: Extract<Op, { op: 'renameSection' }>): OpResult {
  const sections = sectionsOf(doc)
  const index = indexOfSection(sections, op.sectionId)
  if (index < 0) fail(`section not found: ${op.sectionId}`)
  ;(sections.get(index) as Y.Map<unknown>).set('name', op.name)
  return ok()
}

// Slides in the deleted section keep their slide and lose sectionId.
function deleteSection(doc: Y.Doc, op: Extract<Op, { op: 'deleteSection' }>): OpResult {
  const sections = sectionsOf(doc)
  const index = indexOfSection(sections, op.sectionId)
  if (index < 0) fail(`section not found: ${op.sectionId}`)
  sections.delete(index, 1)
  for (const slide of slidesOf(doc).values()) {
    if (slide.get('sectionId') === op.sectionId) slide.delete('sectionId')
  }
  return ok()
}

function setNotes(doc: Y.Doc, op: Extract<Op, { op: 'setNotes' }>): OpResult {
  const { map } = slideAt(doc, op.slideId)
  map.set('notes', op.notes)
  return ok()
}

function applyOne(doc: Y.Doc, op: Op): OpResult {
  switch (op.op) {
    case 'addSlide':
      return addSlide(doc, op)
    case 'deleteSlide':
      return deleteSlide(doc, op)
    case 'duplicateSlide':
      return duplicateSlide(doc, op)
    case 'moveSlide':
      return moveSlide(doc, op)
    case 'updateSlide':
      return updateSlide(doc, op)
    case 'addElement':
      return addElement(doc, op)
    case 'updateElement':
      return updateElement(doc, op)
    case 'deleteElement':
      return deleteElement(doc, op)
    case 'reorderElement':
      return reorderElement(doc, op)
    case 'setTheme':
      return setTheme(doc, op)
    case 'setBrandKit':
      return setBrandKit(doc, op)
    case 'setTitle':
      return setTitle(doc, op)
    case 'addSection':
      return addSection(doc, op)
    case 'renameSection':
      return renameSection(doc, op)
    case 'deleteSection':
      return deleteSection(doc, op)
    case 'setNotes':
      return setNotes(doc, op)
  }
}

function runOps(doc: Y.Doc, ops: readonly Op[]): OpResult[] {
  return ops.map((op, index) => {
    try {
      return applyOne(doc, op)
    } catch (err) {
      throw new OpError(index, op.op, err instanceof Error ? err.message : String(err))
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function applyOps(doc: Y.Doc, ops: readonly unknown[], origin: unknown = null): ApplyResult {
  const parsed = parseOps(ops)

  // Dry run on a scratch copy. Any invalid target throws here, before the real doc is touched.
  const scratch = new Y.Doc()
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc))
    scratch.transact(() => {
      runOps(scratch, parsed)
    })
  } finally {
    scratch.destroy()
  }

  let results: OpResult[] = []
  doc.transact(() => {
    results = runOps(doc, parsed)
  }, origin)
  return { results }
}

// Tracks changes made under the given origins. Each applyOps call is one undo
// step. captureTimeout 0 keeps consecutive batches separate. A UI that wants
// typing to merge can pass a larger value.
export function createUndoManager(
  doc: Y.Doc,
  trackedOrigins: readonly unknown[] = [null],
  options: { captureTimeout?: number } = {},
): Y.UndoManager {
  return new Y.UndoManager(getDeckMap(doc), {
    trackedOrigins: new Set(trackedOrigins),
    captureTimeout: options.captureTimeout ?? 0,
  })
}

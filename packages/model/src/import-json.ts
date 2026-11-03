// Native JSON deck import. The file is normalised (missing fields that have a safe default are filled in), checked
// with the deck schema, then every id is replaced, so an imported deck never shares ids with the deck it was exported from.
import { ANIMATE_KEY_RE, DeckSchema, type Deck } from './schema.ts'
import { cloneTheme, DEFAULT_THEME, newId } from './defaults.ts'
import { isPlainObject, type PlainObject } from './patch.ts'

/** A refusal whose message is safe to show to the user. */
export class DeckImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeckImportError'
  }
}

/** One problem with a JSON deck: where it is (`slides[3].elements[2].style.align`, or '' for the whole file) and what is wrong. */
export interface DeckJsonIssue {
  path: string
  message: string
}

const MAX_LISTED_ISSUES = 10

// `slides[3].elements[2].style.align`. Numbers go in brackets, names are joined with dots.
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = ''
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`
    else out += out === '' ? String(part) : `.${String(part)}`
  }
  return out
}

// Fills `key` with `value` when it is absent (undefined). A present value, even a wrong one, is left for the schema to judge.
function fillMissing(obj: PlainObject, key: string, value: unknown): PlainObject {
  return obj[key] === undefined ? { ...obj, [key]: value } : obj
}

/**
 * An element with the documented defaults filled in: id, rotation, locked, opacity, text align and valign, shape stroke
 * and strokeWidth, image fit, chart options. z is filled only when `index` is given (the element's place in a slide's
 * list). A single addElement leaves z absent, so the op puts the element on top. A present value is never overwritten.
 */
export function normalizeElementInput(raw: unknown, index?: number): unknown {
  if (!isPlainObject(raw)) return raw
  let el = fillMissing(raw, 'id', newId())
  el = fillMissing(el, 'rotation', 0)
  if (index !== undefined) el = fillMissing(el, 'z', index)
  el = fillMissing(el, 'locked', false)
  el = fillMissing(el, 'opacity', 1)
  if (el.type === 'text') {
    const style = el.style === undefined ? {} : el.style
    if (isPlainObject(style)) {
      el = { ...el, style: fillMissing(fillMissing(style, 'align', 'left'), 'valign', 'top') }
    }
  }
  if (el.type === 'shape') {
    el = fillMissing(fillMissing(el, 'stroke', 'transparent'), 'strokeWidth', 0)
  }
  if (el.type === 'image') el = fillMissing(el, 'fit', 'contain')
  if (el.type === 'chart') el = fillMissing(el, 'options', { legend: true })
  return el
}

function normalizeSlide(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw
  let slide = fillMissing(raw, 'id', newId())
  slide = fillMissing(slide, 'layout', 'blank')
  slide = fillMissing(slide, 'notes', '')
  slide = fillMissing(slide, 'transition', 'none')
  slide = fillMissing(slide, 'autoAnimate', false)
  slide = fillMissing(slide, 'hidden', false)
  slide = fillMissing(slide, 'elements', [])
  if (Array.isArray(slide.elements)) slide = { ...slide, elements: slide.elements.map((el, i) => normalizeElementInput(el, i)) }
  return slide
}

/**
 * A JSON deck with the defaults filled in for fields that have a safe one: ids, version, size, sections, title, theme,
 * and per-slide and per-element fields (see the field-level rules below). A present value is never overwritten.
 * Anything else is left for DeckSchema to check.
 */
export function normalizeDeckJson(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  let deck = fillMissing(value, 'id', newId())
  deck = fillMissing(deck, 'version', 1)
  deck = fillMissing(deck, 'size', { w: 1920, h: 1080 })
  deck = fillMissing(deck, 'sections', [])
  deck = fillMissing(deck, 'title', 'Untitled deck')
  deck = fillMissing(deck, 'theme', cloneTheme(DEFAULT_THEME))
  if (Array.isArray(deck.slides)) deck = { ...deck, slides: deck.slides.map(normalizeSlide) }
  return deck
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Checks a JSON deck and returns every problem found, not just the first. A file that is not JSON gives one issue
 * with an empty path.
 */
export function validateDeckJson(text: string): { ok: boolean; issues: DeckJsonIssue[] } {
  const parsed = parseJson(text)
  if (!parsed.ok) return { ok: false, issues: [{ path: '', message: `This file is not valid JSON (${parsed.detail}).` }] }
  const checked = DeckSchema.safeParse(normalizeDeckJson(parsed.value))
  if (checked.success) return { ok: true, issues: [] }
  return {
    ok: false,
    issues: checked.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
  }
}

/**
 * Parses and checks a JSON deck, after normalising it. Throws DeckImportError listing up to 10 issues, each with its path.
 */
export function jsonToDeck(text: string): Deck {
  const parsed = parseJson(text)
  if (!parsed.ok) throw new DeckImportError('This file is not valid JSON.')
  const checked = DeckSchema.safeParse(normalizeDeckJson(parsed.value))
  if (!checked.success) {
    const issues = checked.error.issues
    const listed = issues.slice(0, MAX_LISTED_ISSUES).map((issue) => {
      const path = formatPath(issue.path)
      return path ? `${path}: ${issue.message}` : issue.message
    })
    const rest = issues.length - listed.length
    const tail = rest > 0 ? ` (and ${rest} more)` : ''
    throw new DeckImportError(`This JSON is not a Sleid deck: ${listed.join('; ')}${tail}`)
  }
  return withFreshIds(checked.data)
}

/**
 * The same deck with new ids for the deck, its sections, its slides and its elements.
 *
 * animateKey values are kept. A duplicated slide's copies point their key at the source's old id
 * (see duplicateSlide in ops.ts), and the source has no key of its own. So when a key names another
 * element's old id, that element gets the old id as its key. Both still match after the new ids are
 * assigned, because the renderer uses animateKey ?? id.
 */
export function withFreshIds(deck: Deck): Deck {
  const sectionIds = new Map<string, string>()
  const sections = deck.sections.map((section) => {
    const id = newId()
    sectionIds.set(section.id, id)
    return { ...section, id }
  })
  const allElements = deck.slides.flatMap((slide) => slide.elements)
  const keyed = new Set(allElements.filter((el) => el.animateKey !== undefined).map((el) => el.animateKey))
  // Old ids of elements that some key refers to and that have no key yet.
  const promoted = new Set(
    allElements
      .filter((el) => el.animateKey === undefined && keyed.has(el.id) && ANIMATE_KEY_RE.test(el.id))
      .map((el) => el.id),
  )
  const slides = deck.slides.map((slide) => {
    const { sectionId, ...rest } = slide
    const mapped = sectionId !== undefined ? sectionIds.get(sectionId) : undefined
    return {
      ...rest,
      id: newId(),
      ...(mapped !== undefined ? { sectionId: mapped } : {}),
      elements: slide.elements.map((el) => {
        const animateKey = el.animateKey ?? (promoted.has(el.id) ? el.id : undefined)
        return { ...el, id: newId(), ...(animateKey !== undefined ? { animateKey } : {}) }
      }),
    }
  })
  return { ...deck, id: newId(), sections, slides }
}

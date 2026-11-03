// Native JSON deck import. The file is checked with the deck schema, then every id is replaced,
// so an imported deck never shares ids with the deck it was exported from.
import { ANIMATE_KEY_RE, DeckSchema, type Deck } from './schema.ts'
import { newId } from './defaults.ts'
import { summariseIssues } from './issues.ts'

/** A refusal whose message is safe to show to the user. */
export class DeckImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeckImportError'
  }
}

/** Parses and checks a JSON deck. Throws DeckImportError with the zod issues summarised. */
export function jsonToDeck(text: string): Deck {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new DeckImportError('This file is not valid JSON.')
  }
  const parsed = DeckSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DeckImportError(`This JSON is not a Sleid deck: ${summariseIssues(parsed.error.issues)}`)
  }
  return withFreshIds(parsed.data)
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

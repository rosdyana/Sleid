// Native JSON deck import. The file is checked with the deck schema, then every id is replaced,
// so an imported deck never shares ids with the deck it was exported from.
import { DeckSchema, type Deck } from './schema.ts'
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

/** The same deck with new ids for the deck, its sections, its slides and its elements. */
export function withFreshIds(deck: Deck): Deck {
  const sectionIds = new Map<string, string>()
  const sections = deck.sections.map((section) => {
    const id = newId()
    sectionIds.set(section.id, id)
    return { ...section, id }
  })
  const slides = deck.slides.map((slide) => {
    const { sectionId, ...rest } = slide
    const mapped = sectionId !== undefined ? sectionIds.get(sectionId) : undefined
    return {
      ...rest,
      id: newId(),
      ...(mapped !== undefined ? { sectionId: mapped } : {}),
      elements: slide.elements.map((el) => ({ ...el, id: newId() })),
    }
  })
  return { ...deck, id: newId(), sections, slides }
}

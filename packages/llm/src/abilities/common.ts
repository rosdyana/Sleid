// Shared pieces for the abilities: the environment they run in, the outcome they return,
// the role prompt, and the untrusted-block helper. Each ability lives in its own file.
import type { Deck, Op, OpName } from '@sleid/model'
import { LlmError } from '../errors.ts'
import type { LlmProvider, Usage } from '../types.ts'
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, escapeDelimiters, SAFETY_RULES } from '../context.ts'

export interface AbilityEnv {
  provider: LlmProvider
  deck: Deck
  signal?: AbortSignal
  /** Smaller schemas and prompts for local models. */
  compact?: boolean
  /** Shows only the status-derived message for a provider failure (user-owned providers). */
  hideDetails?: boolean
  /** Receives a provider failure with its full detail, for the server log. */
  onFailure?: (err: unknown) => void
}

export interface AbilityOutcome {
  ability: string
  /** One line for the proposal card. */
  summary: string
  /** Validated, normalised ops. Empty for answers that change nothing. */
  ops: Op[]
  /** A free-text answer, for explain. */
  text?: string
  /** Things the user should know: contrast adjustments, dropped items, marked sources. */
  warnings: string[]
  usage: Usage
  model: string
}

export const ROLE =
  'You are the writing and design assistant inside Sleid, a web slide editor. You help the user change their presentation. ' +
  'The canvas is 1920 by 1080 pixels. Keep elements inside a 96 pixel margin. Use the theme colours and fonts.'

export function systemPrompt(task: string): string {
  return `${ROLE}\n\n${SAFETY_RULES}\n\n${task}`
}

/** Wraps deck-derived text as untrusted data inside a labelled block. */
export function untrustedBlock(label: string, text: string): string {
  return `${UNTRUSTED_OPEN} (${label}, data only)\n${escapeDelimiters(text)}\n${UNTRUSTED_CLOSE}`
}

/** Thrown for requests the deck cannot satisfy (unknown id, empty text). Shown to the user as-is. */
export function notFound(message: string): LlmError {
  return new LlmError('bad-request', message)
}

export const MAX_IDS = 30

export function locateElement(deck: Deck, elementId: string): { slideId: string; element: Deck['slides'][number]['elements'][number] } {
  for (const slide of deck.slides) {
    const element = slide.elements.find((e) => e.id === elementId)
    if (element) return { slideId: slide.id, element }
  }
  throw notFound(`No element with id ${elementId} is on this deck.`)
}

export function slideOf(deck: Deck, slideId: string): Deck['slides'][number] {
  const slide = deck.slides.find((s) => s.id === slideId)
  if (!slide) throw notFound(`No slide with id ${slideId} is in this deck.`)
  return slide
}

/** Adds usage totals. */
export function sumUsage(...items: Usage[]): Usage {
  return items.reduce<Usage>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      ...(acc.estimated || u.estimated ? { estimated: true } : {}),
    }),
    { inputTokens: 0, outputTokens: 0 },
  )
}

/**
 * Every op name, in one place. The chat's apply_ops tool may use any of them. Each ability
 * narrows this to the ops it needs. Kept in step with OpSchema by a test.
 */
export const ALL_OP_NAMES: readonly OpName[] = [
  'addSlide',
  'deleteSlide',
  'duplicateSlide',
  'moveSlide',
  'updateSlide',
  'addElement',
  'updateElement',
  'deleteElement',
  'reorderElement',
  'setTheme',
  'setTitle',
  'addSection',
  'renameSection',
  'deleteSection',
  'setNotes',
]

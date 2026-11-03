// suggestEffects: transitions, auto-animate and element animation orders for the given slides.
// Tasteful defaults: fade or slide transitions, at most MAX_ANIMATIONS animated elements per slide,
// orders renumbered from 0. Only elements that exist on the slide are animated.
//
// The model sees a compact listing only (slide id, layout, element ids and types), never the text, so a
// call stays small. The slides are sent in batches of SUGGEST_BATCH, one request each, and the results
// are merged. Smaller requests finish well inside a proxy's time limit.
import { z } from 'zod'
import { ANIMATION_EFFECTS, type Slide } from '@sleid/model'
import { LlmError } from '../errors.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, MAX_IDS, slideOf, sumUsage, type AbilityEnv, type AbilityOutcome } from './common.ts'
import type { Usage } from '../types.ts'

export const MAX_ANIMATIONS = 4
/** Slides per model request. */
export const SUGGEST_BATCH = 6
const TRANSITIONS = ['none', 'fade', 'slide', 'convex'] as const
// M10. The exit effects and 'wipe' are left out. The prompt asks for entrance effects only, and a model that
// suggests "fade-out" on every key point would hide the content it was meant to show. Authors can still set them by hand.
const NON_ENTRANCE_EFFECTS = new Set<string>(['fade-out', 'current-visible', 'fade-in-then-out', 'semi-fade-out', 'wipe'])
const ENTRANCE_EFFECTS = ANIMATION_EFFECTS.filter((e) => !NON_ENTRANCE_EFFECTS.has(e)) as [
  (typeof ANIMATION_EFFECTS)[number],
  ...(typeof ANIMATION_EFFECTS)[number][],
]

export const SuggestEffectsInput = z.object({
  slideIds: z.array(z.string().min(1)).min(1).max(MAX_IDS),
})
export type SuggestEffectsInput = z.infer<typeof SuggestEffectsInput>

const Output = z.object({
  slides: z.array(
    z.object({
      slideId: z.string().min(1),
      transition: z.enum(TRANSITIONS),
      autoAnimate: z.boolean(),
      animations: z
        .array(z.object({ elementId: z.string().min(1), effect: z.enum(ENTRANCE_EFFECTS), order: z.number().int().min(0).max(50) }))
        .max(12),
    }),
  ),
})

/** One line per slide: its id, layout, and each element's id and type. No text. */
function listingOf(slides: readonly Slide[]): string {
  return slides
    .map((s) => `slide ${s.id} layout=${s.layout}: ${s.elements.map((e) => `${e.id} (${e.type})`).join(', ') || 'no elements'}`)
    .join('\n')
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function suggestEffects(env: AbilityEnv, rawInput: SuggestEffectsInput): Promise<AbilityOutcome> {
  const input = SuggestEffectsInput.parse(rawInput)
  const slides = input.slideIds.map((id) => slideOf(env.deck, id))
  const system = systemPrompt(
    `Task: suggest a transition and animations for each listed slide. Use "fade" or "slide" transitions and "none" for a title or section slide. Animate at most ${MAX_ANIMATIONS} elements per slide, the key points, in reading order. Use "fade-up" or "fade-in" for text, "grow" or "zoom-in" for charts and images. Only use element ids from the listing.`,
  )

  const suggestions: z.infer<typeof Output>['slides'] = []
  const usages: Usage[] = []
  let model = env.provider.model
  for (const batch of batches(slides, SUGGEST_BATCH)) {
    const result = await structured(env.provider, Output, {
      system,
      user: `Slides to work on:\n${listingOf(batch)}`,
      // Reasoning models spend part of this on thinking. 1500 ran out on six slides in the live check.
      maxTokens: 3000,
      temperature: 0.4,
      name: 'effects',
      ...(env.compact !== undefined ? { compact: env.compact } : {}),
      ...(env.signal ? { signal: env.signal } : {}),
    })
    suggestions.push(...result.value.slides)
    usages.push(result.usage)
    model = result.model
  }
  const usage = sumUsage(...usages)

  const allowedSlides = new Set(input.slideIds)
  const warnings: string[] = []
  const raw: unknown[] = []
  for (const suggestion of suggestions) {
    if (!allowedSlides.has(suggestion.slideId)) {
      warnings.push(`Ignored a suggestion for slide ${suggestion.slideId}, which was not requested.`)
      continue
    }
    const slide = slideOf(env.deck, suggestion.slideId)
    raw.push({
      op: 'updateSlide',
      slideId: slide.id,
      patch: { transition: suggestion.transition, autoAnimate: suggestion.autoAnimate },
    })
    const known = new Set(slide.elements.map((e) => e.id))
    const usable = suggestion.animations.filter((a) => {
      if (!known.has(a.elementId)) {
        warnings.push(`Skipped an animation on ${a.elementId}: it is not on slide ${slide.id}.`)
        return false
      }
      return true
    })
    if (usable.length > MAX_ANIMATIONS) warnings.push(`Kept the first ${MAX_ANIMATIONS} animations on slide ${slide.id}.`)
    usable
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_ANIMATIONS)
      .forEach((a, order) => {
        raw.push({ op: 'updateElement', slideId: slide.id, elementId: a.elementId, patch: { animation: { effect: a.effect, order } } })
      })
  }
  if (raw.length === 0) throw new LlmError('invalid-output', 'The assistant did not suggest any changes for these slides.')
  const ops = checkOps(env.deck, raw, allowlist('updateSlide', 'updateElement'), 'suggestEffects')
  return {
    ability: 'suggestEffects',
    summary: `Suggest transitions and animations for ${slides.length} slide${slides.length === 1 ? '' : 's'}`,
    ops,
    warnings,
    usage,
    model,
  }
}

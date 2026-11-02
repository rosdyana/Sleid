// suggestEffects: transitions, auto-animate and element animation orders for the given slides.
// Tasteful defaults: fade or slide transitions, at most MAX_ANIMATIONS animated elements per slide,
// orders renumbered from 0. Only elements that exist on the slide are animated.
import { z } from 'zod'
import { ANIMATION_EFFECTS } from '@sleid/model'
import { describeDeck } from '../context.ts'
import { LlmError } from '../errors.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, MAX_IDS, slideOf, type AbilityEnv, type AbilityOutcome } from './common.ts'

export const MAX_ANIMATIONS = 4
const TRANSITIONS = ['none', 'fade', 'slide', 'convex'] as const

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
        .array(z.object({ elementId: z.string().min(1), effect: z.enum(ANIMATION_EFFECTS), order: z.number().int().min(0).max(50) }))
        .max(12),
    }),
  ),
})

export async function suggestEffects(env: AbilityEnv, rawInput: SuggestEffectsInput): Promise<AbilityOutcome> {
  const input = SuggestEffectsInput.parse(rawInput)
  const slides = input.slideIds.map((id) => slideOf(env.deck, id))
  const listing = slides
    .map((s) => `slide ${s.id}: ${s.elements.map((e) => `${e.id} (${e.type})`).join(', ') || 'no elements'}`)
    .join('\n')
  const result = await structured(env.provider, Output, {
    system: systemPrompt(
      `Task: suggest a transition and animations for each listed slide. Use "fade" or "slide" transitions and "none" for a title or section slide. Animate at most ${MAX_ANIMATIONS} elements per slide, the key points, in reading order. Use "fade-up" or "fade-in" for text, "grow" or "zoom-in" for charts and images. Only use element ids from the listing.`,
    ),
    user: `${describeDeck(env.deck, { maxChars: 4000, selectionIds: input.slideIds }).text}\n\nSlides to work on:\n${listing}`,
    maxTokens: 1500,
    temperature: 0.4,
    name: 'effects',
    ...(env.compact !== undefined ? { compact: env.compact } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
  })

  const allowedSlides = new Set(input.slideIds)
  const warnings: string[] = []
  const raw: unknown[] = []
  for (const suggestion of result.value.slides) {
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
    usage: result.usage,
    model: result.model,
  }
}

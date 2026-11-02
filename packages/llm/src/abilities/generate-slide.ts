// generateSlide: a new slide (addSlide), or the content of an empty slide (addElement).
// The model returns a title, bullets and notes. Layout comes from the model package's placeholders,
// and the layout guard keeps everything inside the margins without overlaps.
import { z } from 'zod'
import { layoutElements, SLIDE_LAYOUTS, type Element, type Op, type SlideLayout } from '@sleid/model'
import { describeDeck, richFromParagraphs } from '../context.ts'
import { LlmError } from '../errors.ts'
import { layoutGuard } from '../layout-guard.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, untrustedBlock, slideOf, type AbilityEnv, type AbilityOutcome } from './common.ts'

// Image layouts need a picture, which the assistant does not supply. They fall back to title-content.
const GENERABLE_LAYOUTS = ['title', 'title-content', 'two-column', 'section', 'quote', 'blank'] as const

export const GenerateSlideInput = z.object({
  prompt: z.string().min(1).max(2000),
  layoutHint: z.enum(SLIDE_LAYOUTS).optional(),
  /** Fill this slide instead of adding one. It must have no elements yet. */
  slideId: z.string().min(1).optional(),
  /** Where a new slide goes (0-based). Default: at the end. */
  index: z.number().int().min(0).optional(),
  /** The slide the user is on. Used for context, and as the focus of the prompt. */
  focusSlideId: z.string().min(1).optional(),
})
export type GenerateSlideInput = z.infer<typeof GenerateSlideInput>

const Output = z.object({
  layout: z.enum(GENERABLE_LAYOUTS),
  title: z.string().min(1).max(160),
  subtitle: z.string().max(300).optional(),
  bullets: z.array(z.string().min(1).max(300)).max(8),
  notes: z.string().max(2000).optional(),
})

function fillPlaceholders(layout: SlideLayout, elements: Element[], out: Pick<z.infer<typeof Output>, 'title' | 'subtitle' | 'bullets'>): Element[] {
  const bodies = elements.filter((e) => e.type === 'text' && e.role === 'body')
  const half = Math.ceil(out.bullets.length / 2)
  const chunks = layout === 'two-column' ? [out.bullets.slice(0, half), out.bullets.slice(half)] : [out.bullets]
  let bodyIndex = 0
  return elements
    .map((el): Element | null => {
      if (el.type !== 'text') return el
      if (el.role === 'title') return { ...el, content: richFromParagraphs([out.title]) }
      if (el.role === 'subtitle') return out.subtitle ? { ...el, content: richFromParagraphs([out.subtitle]) } : null
      if (el.role === 'body') {
        const index = bodies.indexOf(el)
        const items = layout === 'quote' ? [out.bullets[0] ?? out.title] : (chunks[bodyIndex] ?? chunks[index] ?? [])
        bodyIndex++
        if (items.length === 0) return null
        return { ...el, content: richFromParagraphs(items, layout !== 'quote') }
      }
      return el
    })
    .filter((el): el is Element => el !== null)
}

/** The layout guard runs on the boxes; its positions are written back onto the elements. */
function guardElements(elements: Element[]): { elements: Element[]; warnings: string[] } {
  const guarded = layoutGuard(elements.map((el) => ({ ...el })))
  const byId = new Map(guarded.elements.map((el) => [el.id, el]))
  const out = elements.map((el) => {
    const g = byId.get(el.id)
    return g ? ({ ...el, x: g.x, y: g.y, w: g.w, h: g.h } as Element) : el
  })
  // Moves inside the margins are routine for the placeholders, so they are not reported. Shortening and overlaps are.
  return { elements: out, warnings: guarded.warnings.filter((w) => !w.includes('moved inside the safe margins')) }
}

export async function generateSlide(env: AbilityEnv, rawInput: GenerateSlideInput): Promise<AbilityOutcome> {
  const input = GenerateSlideInput.parse(rawInput)
  const focus = input.focusSlideId ?? input.slideId ?? env.deck.slides[0]?.id
  if (input.slideId) {
    const existing = slideOf(env.deck, input.slideId)
    if (existing.elements.length > 0) throw new LlmError('bad-request', 'That slide already has content. Pick an empty slide, or add a new one.')
  }

  const hint = input.layoutHint && input.layoutHint !== 'image-left' ? `Preferred layout: ${input.layoutHint}.` : ''
  const result = await structured(env.provider, Output, {
    system: systemPrompt(
      'Task: design one slide for the request. Choose the layout that fits the content: "title" for a cover, "section" for a divider, "two-column" for two lists, "quote" for one quotation, "title-content" for a title with bullets, "blank" for a title-less slide. Keep bullets short (under 15 words). Notes are what the presenter says aloud.',
    ),
    user: `${describeDeck(env.deck, { ...(focus ? { focusSlideId: focus } : {}), maxChars: 4000 }).text}\n\n${hint}\nRequest:\n${untrustedBlock('request', input.prompt)}`,
    maxTokens: 2000,
    temperature: 0.7,
    name: 'slide',
    ...(env.compact !== undefined ? { compact: env.compact } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
  })

  const { title, subtitle, bullets, notes } = result.value
  const layout = result.value.layout
  const theme = env.deck.theme
  const slideId = input.slideId ?? crypto.randomUUID()
  const placeholders = layoutElements(layout, theme, () => crypto.randomUUID())
  const filled = fillPlaceholders(layout, placeholders, { title, subtitle, bullets })
  const guarded = guardElements(filled)
  const elements = guarded.elements.map((el, i) => ({ ...el, id: crypto.randomUUID(), z: i }) as Element)

  const raw: unknown[] = input.slideId
    ? elements.map((element) => ({ op: 'addElement', slideId, element }))
    : [{ op: 'addSlide', layout, ...(input.index !== undefined ? { index: input.index } : {}), slide: { id: slideId, notes: notes ?? '', elements } }]
  const ops: Op[] = checkOps(env.deck, raw, allowlist('addSlide', 'addElement'), 'generateSlide')

  return {
    ability: 'generateSlide',
    summary: `${input.slideId ? 'Fill slide' : 'Add slide'} "${title.slice(0, 80)}"`,
    ops,
    warnings: guarded.warnings,
    usage: result.usage,
    model: result.model,
  }
}


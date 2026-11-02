// altText: alternative text for images, charts and diagrams (updateElement with `alt`).
// When the provider accepts images and the caller supplies the bytes, the model looks at up to
// MAX_IMAGES of them. Everything else is written from context (the slide text, the chart data),
// and is reported as "auto (no vision)" in the summary and the warnings.
import { z } from 'zod'
import { describeDeck, plainText } from '../context.ts'
import { LlmError } from '../errors.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, MAX_IDS, locateElement, slideOf, type AbilityEnv, type AbilityOutcome } from './common.ts'
import type { Element } from '@sleid/model'
import type { ImagePart } from '../types.ts'

export const MAX_IMAGES = 4
const ALT_TYPES = ['image', 'chart', 'diagram'] as const

export const AltTextInput = z.object({
  elementIds: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  /** Image bytes by element id. Only used when the provider supports images. */
  images: z.record(z.string(), z.object({ mediaType: z.string(), base64: z.string() })).optional(),
})
export type AltTextInput = z.infer<typeof AltTextInput>

const Output = z.object({
  items: z.array(z.object({ elementId: z.string().min(1), alt: z.string().min(1).max(200) })).min(1),
})

function contextFor(slideTitle: string, el: Element): string {
  switch (el.type) {
    case 'image':
      return `image${el.alt ? `, current alt "${el.alt}"` : ''}; slide title "${slideTitle}"`
    case 'chart': {
      const rows = el.data.rows.slice(0, 10).map((r) => r.map((c) => (c === null ? '' : String(c))).join(', '))
      return `${el.chartType} chart titled "${el.options.title ?? ''}", columns ${el.data.columns.join(', ')}; rows: ${rows.join(' / ')}`
    }
    case 'diagram':
      return `diagram: ${el.source.slice(0, 400)}`
    default:
      return el.type
  }
}

export async function altText(env: AbilityEnv, rawInput: AltTextInput): Promise<AbilityOutcome> {
  const input = AltTextInput.parse(rawInput)
  const targets = input.elementIds.map((id) => {
    const found = locateElement(env.deck, id)
    if (!(ALT_TYPES as readonly string[]).includes(found.element.type)) {
      throw new LlmError('bad-request', 'Alt text is written for images, charts and diagrams.')
    }
    const slide = slideOf(env.deck, found.slideId)
    const title = slide.elements.find((e) => e.type === 'text' && e.role === 'title')
    return { element: found.element, slideTitle: title && title.type === 'text' ? plainText(title.content).slice(0, 120) : '' }
  })

  const images: ImagePart[] = []
  const visionIds = new Set<string>()
  if (env.provider.supportsImages && input.images) {
    for (const t of targets) {
      const img = input.images[t.element.id]
      if (img && images.length < MAX_IMAGES) {
        images.push({ mediaType: img.mediaType, base64: img.base64 })
        visionIds.add(t.element.id)
      }
    }
  }
  const visionOrder = [...visionIds]
  const listing = targets
    .map((t) => {
      const picture = visionIds.has(t.element.id) ? `attached as Image ${visionOrder.indexOf(t.element.id) + 1}` : 'no picture attached'
      return `element ${t.element.id}: ${contextFor(t.slideTitle, t.element)} (${picture})`
    })
    .join('\n')

  const result = await structured(env.provider, Output, {
    system: systemPrompt(
      'Task: write alternative text for each listed element, for screen readers. One short sentence, under 25 words, that says what the picture shows or what the chart means. Do not start with "Image of". For charts, state the main finding. Return one item per element id.',
    ),
    user: `${describeDeck(env.deck, { maxChars: 2000, selectionIds: input.elementIds }).text}\n\nElements:\n${listing}`,
    ...(images.length ? { images } : {}),
    maxTokens: 1200,
    temperature: 0.3,
    name: 'alt',
    ...(env.compact !== undefined ? { compact: env.compact } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
  })

  const wanted = new Set(input.elementIds)
  const warnings: string[] = []
  const raw: unknown[] = []
  const autoIds: string[] = []
  for (const item of result.value.items) {
    if (!wanted.has(item.elementId)) {
      warnings.push(`Ignored alt text for ${item.elementId}, which was not requested.`)
      continue
    }
    const found = locateElement(env.deck, item.elementId)
    raw.push({ op: 'updateElement', slideId: found.slideId, elementId: item.elementId, patch: { alt: item.alt } })
    if (!visionIds.has(item.elementId)) autoIds.push(item.elementId)
  }
  if (autoIds.length > 0) warnings.push(`auto (no vision): ${autoIds.length} element${autoIds.length === 1 ? '' : 's'} described from context, not from the picture.`)
  const ops = checkOps(env.deck, raw, allowlist('updateElement'), 'altText')
  return {
    ability: 'altText',
    summary: `Write alt text for ${ops.length} element${ops.length === 1 ? '' : 's'}${visionIds.size > 0 ? ` (${visionIds.size} from the picture)` : ' (auto, no vision)'}`,
    ops,
    warnings,
    usage: result.usage,
    model: result.model,
  }
}

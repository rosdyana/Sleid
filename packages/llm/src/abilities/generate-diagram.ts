// generateDiagram: Mermaid source for a new diagram element, or a new source for an existing one.
// The source is checked cheaply (first keyword, size, no script). A failed check gets one
// corrective request that names the problem. A second failure is an error for the user.
import { z } from 'zod'
import { describeDeck } from '../context.ts'
import { LlmError } from '../errors.ts'
import { cleanMermaid, MERMAID_KEYWORDS, MERMAID_MAX_CHARS, validateMermaid } from '../mermaid.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, untrustedBlock, locateElement, slideOf, type AbilityEnv, type AbilityOutcome } from './common.ts'
import { placeNewElement } from './place-element.ts'
import { DIAGRAM_ASPECT } from '../placement.ts'

export const GenerateDiagramInput = z.object({
  prompt: z.string().min(1).max(1000),
  elementId: z.string().min(1).optional(),
  slideId: z.string().min(1).optional(),
})
export type GenerateDiagramInput = z.infer<typeof GenerateDiagramInput>

const Output = z.object({
  title: z.string().min(1).max(120),
  source: z.string().min(1).max(MERMAID_MAX_CHARS),
})

export async function generateDiagram(env: AbilityEnv, rawInput: GenerateDiagramInput): Promise<AbilityOutcome> {
  const input = GenerateDiagramInput.parse(rawInput)
  let slideId = input.slideId ?? env.deck.slides[0]?.id ?? ''
  if (input.elementId) {
    const found = locateElement(env.deck, input.elementId)
    if (found.element.type !== 'diagram') throw new LlmError('bad-request', 'Select a diagram to change it.')
    slideId = found.slideId
  } else {
    slideOf(env.deck, slideId)
  }

  const system = systemPrompt(
    `Task: write a Mermaid diagram for the request. The first statement must start with one of: ${MERMAID_KEYWORDS.join(', ')}. Use plain labels without HTML, no click handlers, no links. Keep it under 25 nodes.`,
  )
  const user = `${describeDeck(env.deck, { focusSlideId: slideId, maxChars: 2500 }).text}\n\nRequest:\n${untrustedBlock('request', input.prompt)}`
  const options = { ...(env.compact !== undefined ? { compact: env.compact } : {}), ...(env.signal ? { signal: env.signal } : {}) }

  let result = await structured(env.provider, Output, { system, user, maxTokens: 1500, temperature: 0.3, name: 'diagram', ...options })
  let usage = result.usage
  let check = validateMermaid(result.value.source)
  if (!check.ok) {
    // One corrective request for the Mermaid problem only. A second failure is not retried again.
    const again = await structured(env.provider, Output, {
      system,
      user: `${user}\n\nYour previous diagram was rejected because ${check.reason}. Write it again, starting with a valid diagram keyword.`,
      maxTokens: 1500,
      temperature: 0.2,
      name: 'diagram',
      ...options,
    })
    usage = { inputTokens: usage.inputTokens + again.usage.inputTokens, outputTokens: usage.outputTokens + again.usage.outputTokens }
    result = again
    check = validateMermaid(again.value.source)
    if (!check.ok) throw new LlmError('invalid-output', `The diagram was not valid Mermaid: ${check.reason}.`, { issues: [check.reason] })
  }

  const source = cleanMermaid(result.value.source)
  const title = result.value.title
  let raw: unknown[]
  let warnings: string[] = []
  if (input.elementId) {
    raw = [{ op: 'updateElement', slideId, elementId: input.elementId, patch: { source } }]
  } else {
    const placed = placeNewElement(env.deck, slideId, { type: 'diagram', source, rotation: 0, locked: false, opacity: 1, alt: title }, DIAGRAM_ASPECT, title)
    raw = placed.raw
    if (placed.onNewSlide) {
      warnings = [`Slide ${placed.targetNumber} had no free space for the diagram, so it is on a new slide (slide ${placed.slideNumber}).`]
    }
  }
  const ops = checkOps(env.deck, raw, allowlist('addSlide', 'addElement', 'updateElement', 'deleteElement'), 'generateDiagram')
  return {
    ability: 'generateDiagram',
    summary: `${input.elementId ? 'Update diagram' : 'Add diagram'}: ${title.slice(0, 60)}`,
    ops,
    warnings,
    usage,
    model: result.model,
  }
}

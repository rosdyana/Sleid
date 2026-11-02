import { z } from 'zod'
import { describeDeck } from '../context.ts'
import { LlmError } from '../errors.ts'
import { cleanMermaid, MERMAID_KEYWORDS, MERMAID_MAX_CHARS, validateMermaid, type MermaidCheck } from '../mermaid.ts'
import { repairMermaid } from '../mermaid-repair.ts'
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

/** The rules the model must follow. They are in the system prompt, and repeated in the corrective request. */
const MERMAID_RULES = [
  'Mermaid rules (the diagram is checked by the real Mermaid parser):',
  '- Node ids are single words made of letters, digits and underscores, for example ShopAppliances. Never put spaces in an id.',
  '- Put a human label in brackets after the id: ShopAppliances[Shop appliances]. Use the id again, without brackets, in later edges.',
  '- Edge labels go between pipes: A -->|surplus| B.',
  '- No markdown code fences. No HTML tags. No click handlers, links or scripts.',
]

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
    [
      `Task: write a Mermaid diagram for the request. The first statement must start with one of: ${MERMAID_KEYWORDS.join(', ')}.`,
      ...MERMAID_RULES,
      'Plain labels. Keep it under 25 nodes.',
    ].join('\n'),
  )
  const user = `${describeDeck(env.deck, { focusSlideId: slideId, maxChars: 2500 }).text}\n\nRequest:\n${untrustedBlock('request', input.prompt)}`
  const options = { ...(env.compact !== undefined ? { compact: env.compact } : {}), ...(env.signal ? { signal: env.signal } : {}) }

  let result = await structured(env.provider, Output, { system, user, maxTokens: 1500, temperature: 0.3, name: 'diagram', ...options })
  let usage = result.usage
  let source = cleanMermaid(result.value.source)
  let check = await validateMermaid(source)
  if (!check.ok) {
    // One corrective request: the parser's message, the offending line, and the rules again.
    const again = await structured(env.provider, Output, {
      system,
      user: `${user}\n\n${correctionFor(check, source)}`,
      maxTokens: 1500,
      temperature: 0.2,
      name: 'diagram',
      ...options,
    })
    usage = { inputTokens: usage.inputTokens + again.usage.inputTokens, outputTokens: usage.outputTokens + again.usage.outputTokens }
    result = again
    source = cleanMermaid(again.value.source)
    check = await validateMermaid(source)
  }
  if (!check.ok) {
    // Deterministic repair for bare multi-word node names, then the same check again.
    const repaired = repairMermaid(source)
    if (repaired !== source) {
      const recheck = await validateMermaid(repaired)
      if (recheck.ok) {
        source = cleanMermaid(repaired)
        check = recheck
      }
    }
  }
  if (!check.ok) throw new LlmError('invalid-output', `The diagram was not valid Mermaid: ${check.message}.`, { issues: [check.message] })

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

/** The corrective request: what the parser said, the line it named, and the rules. */
function correctionFor(check: Extract<MermaidCheck, { ok: false }>, source: string): string {
  const lines = source.split('\n')
  const offending = check.line !== undefined ? lines[check.line - 1]?.trim() : undefined
  return [
    `Your previous diagram was rejected by the Mermaid parser: ${check.message}.`,
    ...(offending ? [`The line that failed (line ${check.line}) is: ${offending}`] : []),
    'Write the whole diagram again and fix that problem. Follow these rules:',
    ...MERMAID_RULES.slice(1),
    'Reply with one JSON object only.',
  ].join('\n')
}

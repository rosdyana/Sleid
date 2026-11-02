// explain: a plain-text answer about the deck or one element. Changes nothing (no ops).
import { z } from 'zod'
import { describeDeck, plainText } from '../context.ts'
import { LlmError } from '../errors.ts'
import { systemPrompt, untrustedBlock, locateElement, type AbilityEnv, type AbilityOutcome } from './common.ts'
import { sumUsage } from './common.ts'

export const ExplainInput = z.object({
  question: z.string().min(1).max(1000),
  elementId: z.string().min(1).optional(),
  slideId: z.string().min(1).optional(),
})
export type ExplainInput = z.infer<typeof ExplainInput>

export async function explain(env: AbilityEnv, rawInput: ExplainInput): Promise<AbilityOutcome> {
  const input = ExplainInput.parse(rawInput)
  let focus = input.slideId ?? env.deck.slides[0]?.id
  let target = ''
  if (input.elementId) {
    const found = locateElement(env.deck, input.elementId)
    focus = found.slideId
    if (found.element.type === 'text') target = plainText(found.element.content)
    else if (found.element.type === 'chart') target = `chart ${found.element.options.title ?? ''}: ${found.element.data.columns.join(', ')}`
    else if (found.element.type === 'diagram') target = found.element.source
    else target = found.element.type
  }
  if (!focus) throw new LlmError('bad-request', 'The deck has no slides.')
  const result = await env.provider.generate({
    system: systemPrompt('Task: answer the question about the presentation in a few sentences. Plain text, no markdown headings.'),
    messages: [
      {
        role: 'user',
        content: `${describeDeck(env.deck, { focusSlideId: focus, maxChars: 4000 }).text}\n${target ? `\nSelected element:\n${untrustedBlock('element', target)}\n` : ''}\nQuestion:\n${untrustedBlock('question', input.question)}`,
      },
    ],
    maxTokens: 800,
    temperature: 0.3,
    ...(env.signal ? { signal: env.signal } : {}),
  })
  const text = result.text.trim()
  if (!text) throw new LlmError('invalid-output', 'The assistant returned an empty answer.')
  return {
    ability: 'explain',
    summary: 'Explanation',
    text,
    ops: [],
    warnings: [],
    usage: sumUsage(result.usage),
    model: result.model,
  }
}

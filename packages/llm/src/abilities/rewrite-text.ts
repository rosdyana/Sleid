// rewriteText: rewrites one text box. The model returns paragraphs; the ability builds the
// rich-text value itself, so the only op it can produce is updateElement with `content`.
import { z } from 'zod'
import { plainText, richFromParagraphs, describeDeck } from '../context.ts'
import { LlmError } from '../errors.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, untrustedBlock, locateElement, type AbilityEnv, type AbilityOutcome } from './common.ts'

export const REWRITE_MODES = ['improve', 'shorten', 'expand', 'formal', 'casual', 'translate', 'fix-grammar', 'bulletize', 'custom'] as const
export type RewriteMode = (typeof REWRITE_MODES)[number]

export const RewriteTextInput = z.object({
  elementId: z.string().min(1),
  mode: z.enum(REWRITE_MODES),
  /** Target language for translate, for example "Indonesian". */
  language: z.string().min(1).max(40).optional(),
  /** The instruction for custom mode. */
  instruction: z.string().min(1).max(500).optional(),
})
export type RewriteTextInput = z.infer<typeof RewriteTextInput>

const Output = z.object({
  paragraphs: z.array(z.string().min(1).max(1200)).min(1).max(24),
})

const TASKS: Record<Exclude<RewriteMode, 'translate' | 'custom'>, string> = {
  improve: 'Improve clarity, flow and word choice. Keep the meaning and the language.',
  shorten: 'Shorten it to about half the length. Keep the key facts.',
  expand: 'Expand it with concrete detail, to about one and a half times the length. Do not invent statistics or names.',
  formal: 'Rewrite in a formal, professional tone.',
  casual: 'Rewrite in a relaxed, friendly tone.',
  'fix-grammar': 'Fix spelling, grammar and punctuation only. Change nothing else.',
  bulletize: 'Turn it into short bullet points, one idea per bullet.',
}

function taskFor(input: RewriteTextInput): string {
  if (input.mode === 'translate') return `Translate it into ${input.language ?? 'English'}. Keep the formatting.`
  if (input.mode === 'custom') return `Follow this instruction from the user, and only this one: ${input.instruction ?? 'improve it'}`
  return TASKS[input.mode]
}

export async function rewriteText(env: AbilityEnv, rawInput: RewriteTextInput): Promise<AbilityOutcome> {
  const input = RewriteTextInput.parse(rawInput)
  const { slideId, element } = locateElement(env.deck, input.elementId)
  if (element.type !== 'text') throw new LlmError('bad-request', 'Rewrite works on text boxes. Select a text box first.')
  const text = plainText(element.content)
  if (!text.trim()) throw new LlmError('bad-request', 'The text box is empty.')

  const bullets = input.mode === 'bulletize'
  const result = await structured(env.provider, Output, {
    system: systemPrompt(
      `Task: ${taskFor(input)}\nReturn the new text as paragraphs in the "paragraphs" array. Do not add a title, a preamble or quotation marks.`,
    ),
    user: `${describeDeck(env.deck, { focusSlideId: slideId, selectionIds: [input.elementId], maxChars: 3000 }).text}\n\nThe text to work on:\n${untrustedBlock('text box', text)}`,
    maxTokens: 1200,
    temperature: 0.5,
    name: 'rewrite',
    ...(env.compact !== undefined ? { compact: env.compact } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
  })

  const ops = checkOps(
    env.deck,
    [{ op: 'updateElement', slideId, elementId: input.elementId, patch: { content: richFromParagraphs(result.value.paragraphs, bullets) } }],
    allowlist('updateElement'),
    'rewriteText',
  )
  return {
    ability: 'rewriteText',
    summary: input.mode === 'translate' ? `Translate text to ${input.language ?? 'English'}` : `Rewrite text (${input.mode})`,
    ops,
    warnings: [],
    usage: result.usage,
    model: result.model,
  }
}

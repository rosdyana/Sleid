// chat: a free-form assistant. It streams its text. When it wants to change the deck it calls a
// tool. Ability tools each run one ability and return a proposal (ops plus a summary). The
// apply_ops tool takes a raw batch, checked against the same rules. Nothing is applied here:
// the editor shows each proposal as a card, and the user previews, applies or discards it.
import { z } from 'zod'
import type { Deck, Op } from '@sleid/model'
import { describeDeck } from '../context.ts'
import { LlmError } from '../errors.ts'
import { checkOps, allowlist } from '../ops-check.ts'
import type { Message, ToolCall, ToolDef, Usage } from '../types.ts'
import { addUsage, ZERO_USAGE } from '../types.ts'
import { systemPrompt, ALL_OP_NAMES, type AbilityEnv, type AbilityOutcome } from './common.ts'
import { rewriteText, RewriteTextInput } from './rewrite-text.ts'
import { generateSlide, GenerateSlideInput } from './generate-slide.ts'
import { generateChart, GenerateChartInput } from './generate-chart.ts'
import { generateDiagram, GenerateDiagramInput } from './generate-diagram.ts'
import { generateTheme, GenerateThemeInput } from './generate-theme.ts'
import { suggestEffects, SuggestEffectsInput } from './suggest-effects.ts'
import { speakerNotes, SpeakerNotesInput } from './speaker-notes.ts'
import { altText, AltTextInput } from './alt-text.ts'

export const MAX_CHAT_TURNS = 4
export const MAX_CHAT_HISTORY = 12
export const MAX_APPLY_OPS = 40

export interface ChatProposal {
  id: string
  ability: string
  summary: string
  ops: Op[]
  warnings: string[]
  usage: Usage
  model: string
  /** The slide the proposal is about, for the preview. */
  focusSlideId?: string
}

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'proposal'; proposal: ChatProposal }
  | { type: 'error'; message: string }
  | { type: 'done'; usage: Usage; model: string }

export interface ChatInput {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  focusSlideId?: string
  selectionIds?: string[]
}

/** Tool definitions shown to the model. The inputs are validated by the ability's own zod schema. */
export const CHAT_TOOLS: ToolDef[] = [
  {
    name: 'rewrite_text',
    description: 'Rewrite one text box. mode is one of improve, shorten, expand, formal, casual, translate, fix-grammar, bulletize, custom.',
    inputSchema: {
      type: 'object',
      properties: {
        element_id: { type: 'string' },
        mode: { type: 'string', enum: ['improve', 'shorten', 'expand', 'formal', 'casual', 'translate', 'fix-grammar', 'bulletize', 'custom'] },
        language: { type: 'string' },
        instruction: { type: 'string' },
      },
      required: ['element_id', 'mode'],
    },
  },
  {
    name: 'generate_slide',
    description: 'Create a new slide from a request, or fill an empty slide.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, layout: { type: 'string' }, slide_id: { type: 'string' } },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_chart',
    description: 'Add a chart (or change an existing chart when element_id is given). The data comes from the user.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, element_id: { type: 'string' }, chart_type: { type: 'string' } },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_diagram',
    description: 'Add a Mermaid diagram, or rewrite an existing one when element_id is given.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, element_id: { type: 'string' } },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_theme',
    description: 'Change the deck theme from a description of the look.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  },
  {
    name: 'suggest_effects',
    description: 'Suggest transitions and animations for slides. slide_ids defaults to the current slide.',
    inputSchema: { type: 'object', properties: { slide_ids: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'speaker_notes',
    description: 'Write speaker notes for slides. slide_ids defaults to the current slide.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_ids: { type: 'array', items: { type: 'string' } },
        tone: { type: 'string', enum: ['neutral', 'friendly', 'formal', 'energetic'] },
        length: { type: 'string', enum: ['short', 'medium', 'long'] },
      },
    },
  },
  {
    name: 'alt_text',
    description: 'Write alt text for images, charts or diagrams by element id.',
    inputSchema: { type: 'object', properties: { element_ids: { type: 'array', items: { type: 'string' } } }, required: ['element_ids'] },
  },
  {
    name: 'apply_ops',
    description:
      'Propose a batch of deck operations for a change no other tool covers (move, delete, reorder, rename). Each op is an object with an "op" field, for example {"op":"deleteSlide","slideId":"..."}. Give a short summary.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        ops: { type: 'array', items: { type: 'object' } },
      },
      required: ['summary', 'ops'],
    },
  },
]

const ApplyOpsInput = z.object({ summary: z.string().min(1).max(160), ops: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_APPLY_OPS) })

/** Tool inputs use snake_case keys (element_id); the ability schemas use camelCase. */
function camelKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v
  return out
}

/** Runs one tool call. Returns the text the model sees, and the proposal when the tool made one. */
export async function runTool(env: AbilityEnv, call: ToolCall, focusSlideId: string | undefined, selection: string[]): Promise<{ content: string; outcome?: AbilityOutcome }> {
  const raw = (call.input ?? {}) as Record<string, unknown>
  const focus = focusSlideId ?? env.deck.slides[0]?.id ?? ''
  const pick = (name: string) => raw[name]
  const fail = (message: string) => ({ content: `Error: ${message}. Fix the input and try again if it is useful.` })
  let outcome: AbilityOutcome
  try {
    switch (call.name) {
      case 'rewrite_text': {
        const i = RewriteTextInput.parse(camelKeys(raw))
        outcome = await rewriteText(env, i)
        break
      }
      case 'generate_slide': {
        const i = GenerateSlideInput.parse({
          prompt: pick('prompt'),
          ...(typeof pick('layout') === 'string' ? { layoutHint: pick('layout') } : {}),
          ...(typeof pick('slide_id') === 'string' ? { slideId: pick('slide_id') } : {}),
          focusSlideId: focus,
        })
        outcome = await generateSlide(env, i)
        break
      }
      case 'generate_chart': {
        const i = GenerateChartInput.parse({
          prompt: pick('prompt'),
          ...(typeof pick('element_id') === 'string' ? { elementId: pick('element_id') } : {}),
          ...(typeof pick('chart_type') === 'string' ? { chartType: pick('chart_type') } : {}),
          slideId: focus,
        })
        outcome = await generateChart(env, i)
        break
      }
      case 'generate_diagram': {
        const i = GenerateDiagramInput.parse({
          prompt: pick('prompt'),
          ...(typeof pick('element_id') === 'string' ? { elementId: pick('element_id') } : {}),
          slideId: focus,
        })
        outcome = await generateDiagram(env, i)
        break
      }
      case 'generate_theme':
        outcome = await generateTheme(env, GenerateThemeInput.parse({ prompt: pick('prompt') }))
        break
      case 'suggest_effects': {
        const ids = Array.isArray(pick('slide_ids')) && (pick('slide_ids') as unknown[]).length > 0 ? pick('slide_ids') : [focus]
        outcome = await suggestEffects(env, SuggestEffectsInput.parse({ slideIds: ids }))
        break
      }
      case 'speaker_notes': {
        const ids = Array.isArray(pick('slide_ids')) && (pick('slide_ids') as unknown[]).length > 0 ? pick('slide_ids') : [focus]
        outcome = await speakerNotes(env, SpeakerNotesInput.parse({ slideIds: ids, tone: pick('tone') ?? 'neutral', length: pick('length') ?? 'medium' }))
        break
      }
      case 'alt_text': {
        const ids = Array.isArray(pick('element_ids')) ? (pick('element_ids') as unknown[]) : selection
        outcome = await altText(env, AltTextInput.parse({ elementIds: ids }))
        break
      }
      case 'apply_ops': {
        const i = ApplyOpsInput.parse(raw)
        const ops = checkOps(env.deck, i.ops, allowlist(...ALL_OP_NAMES), 'the assistant')
        outcome = { ability: 'apply_ops', summary: i.summary, ops, warnings: [], usage: ZERO_USAGE, model: env.provider.model }
        break
      }
      default:
        return fail(`there is no tool named ${call.name}`)
    }
  } catch (err) {
    if (err instanceof z.ZodError) return fail(`the input did not match the tool (${err.issues.map((i) => i.path.join('.')).join(', ')})`)
    if (err instanceof LlmError) return fail(err.message)
    throw err
  }
  return {
    outcome,
    content: `Prepared a proposal: "${outcome.summary}" with ${outcome.ops.length} change${outcome.ops.length === 1 ? '' : 's'}. The user will review it and choose to preview, apply or discard it. Do not repeat the changes.`,
  }
}

export const CHAT_SYSTEM =
  'You help the user edit a slide presentation. Answer briefly. Use the tools to make changes. Each tool call becomes a proposal the user reviews, so do not claim a change is made until the user applies it. For a change to several slides, call one tool per kind of change.'

export async function* runChat(env: AbilityEnv, input: ChatInput, newId: () => string = () => crypto.randomUUID()): AsyncIterable<ChatEvent> {
  const { provider, deck } = env
  const focus = input.focusSlideId ?? deck.slides[0]?.id
  const system = systemPrompt(`${CHAT_SYSTEM}\n\nCurrent deck:\n${describeDeck(deck, { ...(focus ? { focusSlideId: focus } : {}), selectionIds: input.selectionIds ?? [] }).text}`)
  const history: Message[] = input.messages.slice(-MAX_CHAT_HISTORY).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
  if (history.length === 0 || history[history.length - 1]!.role !== 'user') {
    yield { type: 'error', message: 'Send a message first.' }
    return
  }
  let usage = ZERO_USAGE
  let model = provider.model

  for (let turn = 0; turn < MAX_CHAT_TURNS; turn++) {
    let text = ''
    const calls: ToolCall[] = []
    try {
      const events = provider.stream({
        system,
        messages: history,
        tools: CHAT_TOOLS,
        maxTokens: 1500,
        temperature: 0.4,
        ...(env.signal ? { signal: env.signal } : {}),
      })
      for await (const ev of events) {
        if (ev.type === 'text') {
          text += ev.delta
          yield { type: 'text', delta: ev.delta }
        } else if (ev.type === 'tool_call') {
          calls.push(ev.call)
        } else {
          usage = addUsage(usage, ev.usage)
          model = ev.model
        }
      }
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : 'The assistant failed.' }
      return
    }
    history.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) })
    if (calls.length === 0) {
      yield { type: 'done', usage, model }
      return
    }
    for (const call of calls) {
      yield { type: 'tool', name: call.name }
      const result = await runTool(env, call, focus, input.selectionIds ?? [])
      if (result.outcome) {
        usage = addUsage(usage, result.outcome.usage)
        const proposal: ChatProposal = {
          id: newId(),
          ability: result.outcome.ability,
          summary: result.outcome.summary,
          ops: result.outcome.ops,
          warnings: result.outcome.warnings,
          usage: result.outcome.usage,
          model: result.outcome.model,
          ...(focus ? { focusSlideId: focusOf(deck, result.outcome.ops, focus) } : {}),
        }
        if (proposal.ops.length > 0) yield { type: 'proposal', proposal }
      }
      history.push({ role: 'tool', toolCallId: call.id, content: result.content })
    }
  }
  yield { type: 'error', message: 'The assistant used too many steps for one request. Try a smaller request.' }
}

/** The slide a batch is mostly about: the first slide an op names, or the focus slide. */
export function focusOf(deck: Deck, ops: readonly Op[], fallback: string): string {
  for (const op of ops) {
    if (op.op === 'addSlide' && op.slide?.id) return op.slide.id
    if ('slideId' in op && typeof op.slideId === 'string' && deck.slides.some((s) => s.id === op.slideId)) return op.slideId
  }
  return fallback
}


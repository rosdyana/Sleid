// A scripted provider for tests. Each call pops the next scripted reply. Requests are recorded
// so tests can check what the model was asked. Not used in production code paths.
import { LlmError } from './errors.ts'
import type { GenerateRequest, GenerateResult, LlmProvider, StreamEvent, ToolCall, Usage } from './types.ts'

export interface ScriptedReply {
  text?: string
  toolCalls?: ToolCall[]
  usage?: Usage
  /** Throw this instead of replying. */
  error?: LlmError
}

export interface ScriptedProvider extends LlmProvider {
  readonly requests: GenerateRequest[]
  readonly remaining: number
}

export function scriptedProvider(replies: Array<ScriptedReply | string>, options: { supportsImages?: boolean; model?: string } = {}): ScriptedProvider {
  const queue = [...replies]
  const requests: GenerateRequest[] = []
  const next = (request: GenerateRequest): ScriptedReply => {
    requests.push(request)
    const reply = queue.shift()
    if (reply === undefined) throw new Error('scriptedProvider: no reply left for this request')
    const normalised = typeof reply === 'string' ? { text: reply } : reply
    if (normalised.error) throw normalised.error
    return normalised
  }
  const model = options.model ?? 'scripted-model'
  return {
    kind: 'openai-compatible',
    model,
    supportsImages: options.supportsImages ?? false,
    get requests() {
      return requests
    },
    get remaining() {
      return queue.length
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const reply = next(request)
      return {
        text: reply.text ?? '',
        toolCalls: reply.toolCalls ?? [],
        usage: reply.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: reply.toolCalls?.length ? 'tool_use' : 'end',
        model,
      }
    },
    async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
      const reply = next(request)
      const text = reply.text ?? ''
      for (let i = 0; i < text.length; i += 16) yield { type: 'text', delta: text.slice(i, i + 16) }
      for (const call of reply.toolCalls ?? []) yield { type: 'tool_call', call }
      yield {
        type: 'done',
        usage: reply.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: reply.toolCalls?.length ? 'tool_use' : 'end',
        model,
      }
    },
  }
}

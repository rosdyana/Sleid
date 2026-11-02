// Shared core for OpenAI-shaped chat/completions endpoints (Azure OpenAI, Ollama, LM Studio,
// llama.cpp, vLLM). The two public adapters only differ in URL and auth header.
//
// Structured output is tried in the configured order. `json_schema` sends response_format.
// `tools` forces a single function call whose arguments are the JSON. `prompt` asks for JSON
// in the system prompt and is the fallback for servers that reject both. When a server answers
// 400 saying it does not support the mode, the next mode is used, and the choice is remembered.
import { LlmError } from '../errors.ts'
import { postJson, mapFetchError, type HttpContext } from '../http.ts'
import { withRetry, type RetryOptions } from '../retry.ts'
import type { GenerateRequest, GenerateResult, LlmProvider, Message, ProviderKind, StopReason, StreamEvent, ToolCall, Usage } from '../types.ts'

export type StructuredMode = 'json_schema' | 'tools' | 'prompt'

export interface OpenAIChatConfig {
  kind: ProviderKind
  label: string
  model: string
  /** Full URL of the chat/completions endpoint. */
  url: string
  headers: Record<string, string>
  /** Modes to try, in order. */
  structured: StructuredMode[]
  supportsImages: boolean
  timeoutMs: number
  secrets: readonly string[]
  fetch?: typeof fetch
  retry?: RetryOptions
}

const SUBMIT_TOOL = 'submit_result'
const UNSUPPORTED = /response_format|json_schema|json mode|tool_choice|tools?\b.*(not|unsupported)|unsupported.*(tool|format)|not supported/i

interface WireToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
  index?: number
}

interface WireChoice {
  message?: { content?: string | null; tool_calls?: WireToolCall[] }
  delta?: { content?: string | null; tool_calls?: WireToolCall[] }
  finish_reason?: string | null
}

interface WireResponse {
  model?: string
  choices?: WireChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function parseArgs(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return { _raw: raw }
  }
}

function stopReasonOf(finish: string | null | undefined): StopReason {
  switch (finish) {
    case 'stop':
      return 'end'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return 'other'
  }
}

export function toWireMessages(messages: Message[], system: string, supportsImages: boolean): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? 'call_0', content: m.content })
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      })
    } else if (m.images?.length && supportsImages) {
      out.push({
        role: 'user',
        content: [
          ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } })),
          { type: 'text', text: m.content },
        ],
      })
    } else {
      out.push({ role: 'user', content: m.content })
    }
  }
  return out
}

export function createOpenAIChatProvider(config: OpenAIChatConfig): LlmProvider {
  const modes = config.structured.length > 0 ? config.structured : (['prompt'] as StructuredMode[])
  let modeIndex = 0
  const ctx = (signal?: AbortSignal): HttpContext => ({
    ...(config.fetch ? { fetch: config.fetch } : {}),
    timeoutMs: config.timeoutMs,
    ...(signal ? { signal } : {}),
    secrets: config.secrets,
    label: config.label,
  })

  function buildBody(req: GenerateRequest, mode: StructuredMode | null, stream: boolean): Record<string, unknown> {
    let system = req.system
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(stream ? { stream: true } : {}),
    }
    if (req.jsonSchema && mode) {
      if (mode === 'json_schema') {
        body.response_format = { type: 'json_schema', json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: false } }
      } else if (mode === 'tools') {
        body.tools = [{ type: 'function', function: { name: SUBMIT_TOOL, description: 'Submit the result.', parameters: req.jsonSchema.schema } }]
        body.tool_choice = { type: 'function', function: { name: SUBMIT_TOOL } }
      } else {
        system = `${system}\n\nReply with only one JSON object that matches this JSON Schema. No prose, no code fences.\nSchema: ${JSON.stringify(req.jsonSchema.schema)}`
      }
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
      body.tool_choice = 'auto'
    }
    body.messages = toWireMessages(req.messages, system, config.supportsImages)
    return body
  }

  function isUnsupportedMode(err: unknown): boolean {
    return err instanceof LlmError && err.kind === 'bad-request' && err.status === 400 && UNSUPPORTED.test(err.message)
  }

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    const attemptModes: Array<StructuredMode | null> = req.jsonSchema ? modes.slice(modeIndex) : [null]
    let lastError: unknown
    for (let i = 0; i < attemptModes.length; i++) {
      const mode = attemptModes[i]!
      try {
        const body = buildBody(req, mode, false)
        const response = await withRetry(() => postJson(config.url, config.headers, body, ctx(req.signal)), { ...config.retry, signal: req.signal })
        const data = (await response.json().catch(() => null)) as WireResponse | null
        if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
          throw new LlmError('invalid-output', `${config.label} sent a reply that is not in the chat/completions format.`)
        }
        if (req.jsonSchema && mode) modeIndex = modes.indexOf(mode)
        return parseResponse(data, req, mode)
      } catch (err) {
        lastError = err
        if (req.jsonSchema && isUnsupportedMode(err) && i + 1 < attemptModes.length) {
          modeIndex = modes.indexOf(attemptModes[i + 1]!)
          continue
        }
        throw err
      }
    }
    throw lastError
  }

  function parseResponse(data: WireResponse, req: GenerateRequest, mode: StructuredMode | null): GenerateResult {
    const choice = data.choices![0]!
    let text = choice.message?.content ?? ''
    const calls: ToolCall[] = []
    for (const [i, c] of (choice.message?.tool_calls ?? []).entries()) {
      const name = c.function?.name ?? ''
      if (req.jsonSchema && mode === 'tools' && name === SUBMIT_TOOL) {
        text = c.function?.arguments ?? '{}'
        continue
      }
      calls.push({ id: c.id ?? `call_${i}`, name, input: parseArgs(c.function?.arguments) })
    }
    const usage: Usage = data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : { inputTokens: estimateTokens(req.system.length), outputTokens: estimateTokens(text.length), estimated: true }
    const stopReason = calls.length > 0 && choice.finish_reason !== 'length' ? 'tool_use' : stopReasonOf(choice.finish_reason)
    return { text, toolCalls: calls, usage, stopReason, model: data.model ?? config.model }
  }

  async function* stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    if (req.jsonSchema) {
      const result = await generate(req)
      if (result.text) yield { type: 'text', delta: result.text }
      yield { type: 'done', usage: result.usage, stopReason: result.stopReason, model: result.model }
      return
    }
    const body = buildBody(req, null, true)
    const response = await withRetry(() => postJson(config.url, config.headers, body, ctx(req.signal)), { ...config.retry, signal: req.signal })
    if (!response.body) throw new LlmError('invalid-output', `${config.label} sent an empty stream.`)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const pending = new Map<number, { id?: string; name: string; args: string }>()
    let buffer = ''
    let finish: string | null | undefined
    let outputChars = 0
    let reported: Usage | undefined
    let model = config.model
    try {
      for (;;) {
        const { value, done } = await reader.read().catch((err: unknown) => {
          throw mapFetchError(err, ctx(req.signal))
        })
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          let chunk: WireResponse
          try {
            chunk = JSON.parse(payload) as WireResponse
          } catch {
            continue
          }
          if (chunk.model) model = chunk.model
          if (chunk.usage) reported = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 }
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finish = choice.finish_reason
          const delta = choice.delta
          if (delta?.content) {
            outputChars += delta.content.length
            yield { type: 'text', delta: delta.content }
          }
          for (const [position, call] of (delta?.tool_calls ?? []).entries()) {
            const index = call.index ?? position
            const entry = pending.get(index) ?? { name: '', args: '' }
            if (call.id) entry.id = call.id
            if (call.function?.name) entry.name += call.function.name
            if (call.function?.arguments) entry.args += call.function.arguments
            pending.set(index, entry)
          }
        }
      }
    } catch (err) {
      if (err instanceof LlmError) throw err
      throw mapFetchError(err, ctx(req.signal))
    } finally {
      reader.releaseLock()
    }

    const calls = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({ id: c.id ?? `call_${index}`, name: c.name, input: parseArgs(c.args) }))
    for (const call of calls) yield { type: 'tool_call', call }
    const usage: Usage = reported ?? { inputTokens: estimateTokens(req.system.length + JSON.stringify(req.messages).length), outputTokens: estimateTokens(outputChars), estimated: true }
    const stopReason: StopReason = calls.length > 0 ? 'tool_use' : stopReasonOf(finish)
    yield { type: 'done', usage, stopReason, model }
  }

  return {
    kind: config.kind,
    model: config.model,
    supportsImages: config.supportsImages,
    generate,
    stream,
  }
}

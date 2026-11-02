// Shared core for OpenAI-shaped chat/completions endpoints (Azure OpenAI, Ollama, LM Studio,
// llama.cpp, vLLM). The two public adapters only differ in URL and auth header.
//
// Structured output is tried in the configured order. `json_schema` sends response_format.
// `tools` forces a single function call whose arguments are the JSON. `prompt` asks for JSON
// in the system prompt and is the fallback for servers that reject both. When a server answers
// 400 saying it does not support the mode, the next mode is used, and the choice is remembered.
//
// Reasoning models send their thinking in `reasoning_content` and count it against max_tokens.
// Only `content` is the answer. A reply with no content that stopped at the length limit spent
// its budget thinking: it is retried once with a bigger budget, and if it is still empty the
// caller gets a clear error. The thinking can be turned off per provider (`reasoning`). The
// parameters are tried first, and the server's refusal of them turns them off for this instance.
//
// Structured calls can stream (`streamStructured`). The bytes then flow while the model works,
// which keeps a proxy from cutting a slow request, and the content is collected before it is parsed.
// A server that refuses streaming gets a plain request for the rest of this instance's life.
import { LlmError, redact } from '../errors.ts'
import { postJson, mapFetchError, type HttpContext } from '../http.ts'
import { withRetry, type RetryOptions } from '../retry.ts'
import type { GenerateRequest, GenerateResult, LlmProvider, Message, ProviderKind, StopReason, StreamEvent, ToolCall, Usage } from '../types.ts'

export type StructuredMode = 'json_schema' | 'tools' | 'prompt'

export interface ReasoningOptions {
  /** Sends chat_template_kwargs.enable_thinking = false (Qwen-style servers). */
  disableThinking?: boolean
  /** Sends reasoning_effort. */
  reasoningEffort?: 'low' | 'medium' | 'high'
}

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
  /** Structured calls use stream: true and collect the content. Falls back to a plain request if refused. */
  streamStructured?: boolean
  /** Thinking controls for reasoning models. Off unless set. */
  reasoning?: ReasoningOptions
  fetch?: typeof fetch
  retry?: RetryOptions
}

/** The largest budget the one retry for an empty, length-limited reply asks for. */
export const MAX_TOKENS_CAP = 8192

export const BUDGET_MESSAGE =
  'The model used its whole budget thinking and returned no answer. Raise max tokens or turn off thinking for this provider.'

/** The budget for the one retry: three times the first, capped. Equal to `maxTokens` when no increase is possible. */
export function retryBudget(maxTokens: number): number {
  return Math.max(maxTokens, Math.min(maxTokens * 3, MAX_TOKENS_CAP))
}

const SUBMIT_TOOL = 'submit_result'
const UNSUPPORTED = /response_format|json_schema|json mode|tool_choice|tools?\b.*(not|unsupported)|unsupported.*(tool|format)|not supported/i
const REASONING_PARAM = /reasoning_effort|chat_template_kwargs|enable_thinking/i
// Matches "stream", "streaming" and "stream_options" in a refusal.
const STREAM_REFUSED = /stream/i

interface WireToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
  index?: number
}

/** A streamed delta or a whole message. `reasoning_content` is read only to estimate usage. */
interface WireDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCall[]
}

interface WireChoice {
  message?: WireDelta
  delta?: WireDelta
  finish_reason?: string | null
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

interface WireResponse {
  model?: string
  choices?: WireChoice[]
  usage?: WireUsage
  /** Some servers report a failed generation inside the stream, as an error frame. */
  error?: { message?: unknown; code?: unknown; type?: unknown }
}

/** Everything read from one reply, whether it was streamed or whole. */
interface Accum {
  text: string
  reasoningChars: number
  calls: Map<number, { id?: string; name: string; args: string }>
  finish?: string | null
  usage?: Usage
  model?: string
  /** An error frame from the stream, as text. */
  error?: string
}

/** An error frame that says the output ran out of budget. That is retried with a bigger one, like finish_reason "length". */
const LENGTH_ERROR = /finish_reason=length|output budget|max_tokens|incomplete/i

function emptyAccum(): Accum {
  return { text: '', reasoningChars: 0, calls: new Map() }
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function usageOf(u: WireUsage): Usage {
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 }
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

/** The thinking controls as request fields. Empty when none is set. */
function reasoningFields(options: ReasoningOptions | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (options?.disableThinking) out.chat_template_kwargs = { enable_thinking: false }
  if (options?.reasoningEffort) out.reasoning_effort = options.reasoningEffort
  return out
}

function isBadRequest(err: unknown, pattern: RegExp): boolean {
  return err instanceof LlmError && err.kind === 'bad-request' && err.status === 400 && pattern.test(err.message)
}

/** The answer is empty and the reply ran out of tokens (so the budget went to thinking, or the reply was too long). */
function isBudgetSpent(result: GenerateResult): boolean {
  return result.text.trim() === '' && result.toolCalls.length === 0 && result.stopReason === 'max_tokens'
}

/** Adds the deltas of a streamed chunk to the accumulator. Returns the visible text it carried. */
function absorbDelta(acc: Accum, delta: WireDelta | undefined): string {
  let visible = ''
  if (delta?.content) {
    acc.text += delta.content
    visible = delta.content
  }
  if (delta?.reasoning_content) acc.reasoningChars += delta.reasoning_content.length
  for (const [position, call] of (delta?.tool_calls ?? []).entries()) {
    const index = call.index ?? position
    const entry = acc.calls.get(index) ?? { name: '', args: '' }
    if (call.id) entry.id = call.id
    if (call.function?.name) entry.name += call.function.name
    if (call.function?.arguments) entry.args += call.function.arguments
    acc.calls.set(index, entry)
  }
  return visible
}

function errorText(error: NonNullable<WireResponse['error']>): string {
  const parts = [error.code, error.message].filter((p): p is string => typeof p === 'string' && p.length > 0)
  return parts.length > 0 ? parts.join(': ') : 'unknown error'
}

function absorbChunk(acc: Accum, chunk: WireResponse): string {
  if (chunk.model) acc.model = chunk.model
  if (chunk.usage) acc.usage = usageOf(chunk.usage)
  if (chunk.error) acc.error = errorText(chunk.error)
  const choice = chunk.choices?.[0]
  if (!choice) return ''
  if (choice.finish_reason) acc.finish = choice.finish_reason
  return absorbDelta(acc, choice.delta)
}

/**
 * After a stream: an error frame that says the budget ran out is the same as finish_reason "length" (the caller retries
 * with a bigger budget). Any other error frame is a failure of the server.
 */
function settleStreamError(acc: Accum, secrets: readonly string[], label: string): void {
  if (!acc.error) return
  if (LENGTH_ERROR.test(acc.error)) {
    acc.finish = 'length'
    return
  }
  throw new LlmError('server', `${label} reported an error while answering: ${redact(acc.error, secrets).slice(0, 300)}`)
}

function absorbWhole(acc: Accum, data: WireResponse): void {
  if (data.model) acc.model = data.model
  if (data.usage) acc.usage = usageOf(data.usage)
  const choice = data.choices![0]!
  acc.finish = choice.finish_reason
  absorbDelta(acc, choice.message)
}

/** The result of one reply. The submit tool's arguments are the JSON reply in tools mode. */
function resultOf(acc: Accum, req: GenerateRequest, mode: StructuredMode | null, fallbackModel: string): GenerateResult {
  let text = acc.text
  const calls: ToolCall[] = []
  for (const [index, c] of [...acc.calls.entries()].sort(([a], [b]) => a - b)) {
    if (req.jsonSchema && mode === 'tools' && c.name === SUBMIT_TOOL) {
      text = c.args || '{}'
      continue
    }
    calls.push({ id: c.id ?? `call_${index}`, name: c.name, input: parseArgs(c.args) })
  }
  // Reasoning tokens are part of completion_tokens when the server reports usage. Without usage, the estimate counts
  // the reasoning text too, because it was generated.
  const usage: Usage = acc.usage ?? {
    inputTokens: estimateTokens(req.system.length + JSON.stringify(req.messages).length),
    outputTokens: estimateTokens(text.length + acc.reasoningChars),
    estimated: true,
  }
  const stopReason: StopReason = calls.length > 0 && acc.finish !== 'length' ? 'tool_use' : stopReasonOf(acc.finish)
  return { text, toolCalls: calls, usage, stopReason, model: acc.model ?? fallbackModel }
}

export function createOpenAIChatProvider(config: OpenAIChatConfig): LlmProvider {
  const modes = config.structured.length > 0 ? config.structured : (['prompt'] as StructuredMode[])
  let modeIndex = 0
  // Turned on by the server's refusal, for the life of this instance.
  let streamRejected = false
  let reasoningRejected = false
  const reasoning = reasoningFields(config.reasoning)
  const hasReasoning = Object.keys(reasoning).length > 0
  const ctx = (signal?: AbortSignal): HttpContext => ({
    ...(config.fetch ? { fetch: config.fetch } : {}),
    timeoutMs: config.timeoutMs,
    ...(signal ? { signal } : {}),
    secrets: config.secrets,
    label: config.label,
  })

  function buildBody(req: GenerateRequest, mode: StructuredMode | null, maxTokens: number, stream: boolean, withReasoning: boolean): Record<string, unknown> {
    let system = req.system
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: maxTokens,
      temperature: req.temperature,
      ...(stream ? { stream: true } : {}),
      ...(withReasoning ? reasoning : {}),
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

  /**
   * One POST. A refusal of the thinking parameters is retried without them, and a refusal of streaming is retried as a
   * plain request when the caller allows it. Each fallback happens at most once per instance.
   */
  async function send(
    req: GenerateRequest,
    mode: StructuredMode | null,
    maxTokens: number,
    stream: boolean,
    allowStreamFallback: boolean,
  ): Promise<{ response: Response; streamed: boolean }> {
    const withReasoning = hasReasoning && !reasoningRejected
    const body = buildBody(req, mode, maxTokens, stream, withReasoning)
    try {
      const response = await withRetry(() => postJson(config.url, config.headers, body, ctx(req.signal)), { ...config.retry, signal: req.signal })
      return { response, streamed: stream }
    } catch (err) {
      if (withReasoning && isBadRequest(err, REASONING_PARAM)) {
        reasoningRejected = true
        return send(req, mode, maxTokens, stream, allowStreamFallback)
      }
      if (stream && allowStreamFallback && isBadRequest(err, STREAM_REFUSED)) {
        streamRejected = true
        return send(req, mode, maxTokens, false, false)
      }
      throw err
    }
  }

  /** Reads an SSE body, one parsed chunk at a time. A final line without a newline is read too. */
  async function* readEvents(response: Response, signal: AbortSignal | undefined): AsyncGenerator<WireResponse> {
    if (!response.body) throw new LlmError('invalid-output', `${config.label} sent an empty stream.`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read().catch((err: unknown) => {
          throw mapFetchError(err, ctx(signal))
        })
        if (done) buffer += `${decoder.decode()}\n`
        else buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let chunk: WireResponse
          try {
            chunk = JSON.parse(payload) as WireResponse
          } catch {
            continue
          }
          yield chunk
        }
        if (done) break
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** One complete request for a structured or plain answer. Streams for structured calls when configured. */
  async function complete(req: GenerateRequest, mode: StructuredMode | null, maxTokens: number): Promise<GenerateResult> {
    const wantStream = !!req.jsonSchema && !!config.streamStructured && !streamRejected
    const { response, streamed } = await send(req, mode, maxTokens, wantStream, wantStream)
    const isSse = streamed && !(response.headers.get('content-type') ?? '').includes('application/json')
    if (isSse) {
      const acc = emptyAccum()
      for await (const chunk of readEvents(response, req.signal)) absorbChunk(acc, chunk)
      settleStreamError(acc, config.secrets, config.label)
      return resultOf(acc, req, mode, config.model)
    }
    const data = (await response.json().catch(() => null)) as WireResponse | null
    if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new LlmError('invalid-output', `${config.label} sent a reply that is not in the chat/completions format.`)
    }
    const acc = emptyAccum()
    absorbWhole(acc, data)
    return resultOf(acc, req, mode, config.model)
  }

  function isUnsupportedMode(err: unknown): boolean {
    return isBadRequest(err, UNSUPPORTED)
  }

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    const attemptModes: Array<StructuredMode | null> = req.jsonSchema ? modes.slice(modeIndex) : [null]
    let lastError: unknown
    for (let i = 0; i < attemptModes.length; i++) {
      const mode = attemptModes[i]!
      try {
        let result = await complete(req, mode, req.maxTokens)
        const bigger = retryBudget(req.maxTokens)
        if (isBudgetSpent(result) && bigger > req.maxTokens) result = await complete(req, mode, bigger)
        if (isBudgetSpent(result)) throw new LlmError('bad-request', BUDGET_MESSAGE)
        if (req.jsonSchema && mode) modeIndex = modes.indexOf(mode)
        return result
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

  async function* stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    if (req.jsonSchema) {
      const result = await generate(req)
      if (result.text) yield { type: 'text', delta: result.text }
      yield { type: 'done', usage: result.usage, stopReason: result.stopReason, model: result.model }
      return
    }
    let maxTokens = req.maxTokens
    for (let attempt = 0; ; attempt++) {
      const { response } = await send(req, null, maxTokens, true, false)
      const acc = emptyAccum()
      let emitted = false
      for await (const chunk of readEvents(response, req.signal)) {
        const delta = absorbChunk(acc, chunk)
        if (delta) {
          emitted = true
          yield { type: 'text', delta }
        }
      }
      settleStreamError(acc, config.secrets, config.label)
      // Nothing was shown yet, so the empty, length-limited reply can be retried without the user seeing the first try.
      const bigger = retryBudget(req.maxTokens)
      if (!emitted && acc.calls.size === 0 && acc.finish === 'length' && attempt === 0 && bigger > maxTokens) {
        maxTokens = bigger
        continue
      }
      const result = resultOf(acc, req, null, config.model)
      if (isBudgetSpent(result)) throw new LlmError('bad-request', BUDGET_MESSAGE)
      for (const call of result.toolCalls) yield { type: 'tool_call', call }
      yield { type: 'done', usage: result.usage, stopReason: result.stopReason, model: result.model }
      return
    }
  }

  return {
    kind: config.kind,
    model: config.model,
    supportsImages: config.supportsImages,
    generate,
    stream,
  }
}

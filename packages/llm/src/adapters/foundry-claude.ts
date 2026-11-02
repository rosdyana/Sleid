// Claude on Microsoft Foundry (Azure AI), through @anthropic-ai/foundry-sdk. Same client
// construction as papereview (src/server/llm.server.ts): the endpoint is either a bare resource
// name or the portal URL, and the key goes in the x-api-key header the SDK sends.
//
// Structured output is one forced tool call whose input_schema is the JSON schema. The SDK's own
// retries are off (maxRetries 0) so that retry, backoff and error mapping live in one place (retry.ts, errors.ts).
import AnthropicFoundry from '@anthropic-ai/foundry-sdk'
import type Anthropic from '@anthropic-ai/sdk'
import { LlmError, kindForStatus, parseRetryAfter, redact } from '../errors.ts'
import { withRetry, type RetryOptions } from '../retry.ts'
import type { GenerateRequest, GenerateResult, ImagePart, LlmProvider, Message, StopReason, StreamEvent, ToolCall } from '../types.ts'

export interface FoundryClaudeConfig {
  /** Resource name (for example my-resource) or the endpoint URL (https://my-resource.services.ai.azure.com/anthropic/). */
  endpoint: string
  apiKey: string
  /** The deployment name on Foundry, for example claude-opus-5-5. */
  model: string
  timeoutMs?: number
  /** Overrides the SDK's HTTP layer. Tests point it at a fake server with the default fetch. */
  fetch?: typeof fetch
  retry?: RetryOptions
}

const SUBMIT_TOOL = 'submit_result'

/** The SDK's constructor options for an endpoint. A URL is normalised to .../anthropic/. */
export function foundryEndpointOptions(endpoint: string): { resource?: string | null; baseURL?: string } {
  const raw = endpoint.trim()
  if (!/^https?:\/\//i.test(raw)) {
    if (!/^[a-z0-9-]+$/i.test(raw)) throw new Error('The Foundry endpoint must be a resource name or an https:// URL')
    return { resource: raw }
  }
  const url = new URL(raw)
  const path = url.pathname.replace(/\/+$/, '')
  return { resource: null, baseURL: `${url.origin}${path.endsWith('/anthropic') ? path : `${path}/anthropic`}/` }
}

function toAnthropicImage(img: ImagePart) {
  return { type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType as 'image/png', data: img.base64 } }
}

export function toAnthropicMessages(messages: Message[], supportsImages: boolean): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? 'call_0', content: m.content }] })
    } else if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: (c.input ?? {}) as Record<string, unknown> })
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : m.content || ' ' })
    } else if (m.images?.length && supportsImages) {
      out.push({ role: 'user', content: [...m.images.map(toAnthropicImage), { type: 'text', text: m.content || ' ' }] })
    } else {
      out.push({ role: 'user', content: m.content || ' ' })
    }
  }
  return out
}

function stopReasonOf(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end'
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

/** Maps an SDK or fetch error to an LlmError. The message never includes the key. */
export function mapFoundryError(err: unknown, secrets: readonly string[]): LlmError {
  if (err instanceof LlmError) return err
  const e = err as { name?: string; status?: unknown; message?: unknown; headers?: { get?: (name: string) => string | null } } | undefined
  // The SDK sets name to "Error" on its subclasses, so the class name is the reliable signal.
  const name = e?.constructor?.name ?? e?.name ?? ''
  if (name === 'APIUserAbortError' || name === 'AbortError') return new LlmError('aborted', 'The request was cancelled.', { cause: err })
  if (name === 'APIConnectionTimeoutError') return new LlmError('timeout', 'Claude on Foundry did not answer in time.', { cause: err })
  if (typeof e?.status === 'number') {
    const kind = kindForStatus(e.status)
    const detail = typeof e.message === 'string' ? redact(e.message, secrets).slice(0, 300) : ''
    const hint = kind === 'auth' ? ' Check ANTHROPIC_FOUNDRY_API_KEY or the key you saved, and the resource name.' : ''
    return new LlmError(kind, `Claude on Foundry answered HTTP ${e.status}${detail ? `: ${detail}` : ''}.${hint}`, {
      status: e.status,
      retryAfterMs: parseRetryAfter(e.headers?.get?.('retry-after') ?? null),
      cause: err,
    })
  }
  if (name === 'APIConnectionError') return new LlmError('network', 'Could not reach Claude on Foundry. Check the resource name and your network.', { cause: err })
  const message = e && typeof e.message === 'string' ? redact(e.message, secrets) : 'unknown error'
  return new LlmError('network', `Claude on Foundry request failed (${message}).`, { cause: err })
}

export function createFoundryClaudeProvider(config: FoundryClaudeConfig): LlmProvider {
  if (!config.apiKey) throw new LlmError('not-configured', 'Claude on Foundry needs an API key.')
  const endpoint = foundryEndpointOptions(config.endpoint)
  const secrets = [config.apiKey]
  const client = new AnthropicFoundry({
    ...endpoint,
    apiKey: config.apiKey,
    timeout: config.timeoutMs ?? 120_000,
    maxRetries: 0,
    ...(config.fetch ? { fetch: config.fetch as never } : {}),
  })
  const retry = config.retry

  function buildParams(req: GenerateRequest): Anthropic.MessageCreateParamsNonStreaming {
    const params: Record<string, unknown> = {
      model: config.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: toAnthropicMessages(req.messages, true),
    }
    // Temperature is not sent: Foundry deployments of the Opus 5.x line reject it, as papereview found.
    if (req.jsonSchema) {
      const { $schema: _ignored, ...schema } = req.jsonSchema.schema
      params.tools = [{ name: SUBMIT_TOOL, description: 'Submit the result as JSON.', input_schema: schema }]
      params.tool_choice = { type: 'tool', name: SUBMIT_TOOL }
    } else if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
      params.tool_choice = { type: 'auto' }
    }
    return params as unknown as Anthropic.MessageCreateParamsNonStreaming
  }

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    const params = buildParams(req)
    const message = await withRetry(
      async () => {
        try {
          return await client.messages.create(params, req.signal ? { signal: req.signal } : undefined)
        } catch (err) {
          throw mapFoundryError(err, secrets)
        }
      },
      { ...retry, ...(req.signal ? { signal: req.signal } : {}) },
    )
    let text = ''
    const calls: ToolCall[] = []
    for (const block of message.content) {
      if (block.type === 'text') text += block.text
      else if (block.type === 'tool_use') {
        if (req.jsonSchema && block.name === SUBMIT_TOOL) text = JSON.stringify(block.input ?? {})
        else calls.push({ id: block.id, name: block.name, input: block.input })
      }
    }
    const stopReason = calls.length > 0 ? 'tool_use' : stopReasonOf(message.stop_reason)
    return {
      text,
      toolCalls: calls,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      stopReason,
      model: message.model || config.model,
    }
  }

  async function* stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    if (req.jsonSchema) {
      const result = await generate(req)
      if (result.text) yield { type: 'text', delta: result.text }
      yield { type: 'done', usage: result.usage, stopReason: result.stopReason, model: result.model }
      return
    }
    const params = buildParams(req)
    let final: Anthropic.Message
    try {
      const s = client.messages.stream(params, req.signal ? { signal: req.signal } : undefined)
      for await (const event of s) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', delta: event.delta.text }
        }
      }
      final = await s.finalMessage()
    } catch (err) {
      throw mapFoundryError(err, secrets)
    }
    for (const block of final.content) {
      if (block.type === 'tool_use') yield { type: 'tool_call', call: { id: block.id, name: block.name, input: block.input } }
    }
    const hasTools = final.content.some((b) => b.type === 'tool_use')
    yield {
      type: 'done',
      usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
      stopReason: hasTools ? 'tool_use' : stopReasonOf(final.stop_reason),
      model: final.model || config.model,
    }
  }

  return { kind: 'foundry-claude', model: config.model, supportsImages: true, generate, stream }
}

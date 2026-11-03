// Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp (llama-server), vLLM.
// The base URL includes the /v1 prefix, for example http://127.0.0.1:11434/v1 for Ollama.
// Structured output: json_schema if the server accepts it, otherwise JSON-only prompting.
// Structured calls stream by default, so a proxy in front of the server sees bytes while the model works.
import type { LlmProvider } from '../types.ts'
import type { RetryOptions } from '../retry.ts'
import { createOpenAIChatProvider, type ReasoningOptions, type StructuredMode } from './openai-chat.ts'

export interface OpenAICompatibleConfig {
  /** Base URL that ends in /v1, for example http://127.0.0.1:1234/v1 (LM Studio). */
  baseUrl: string
  /** Optional. Local servers usually need none. */
  apiKey?: string
  model: string
  /** Structured output mode. `auto` tries json_schema, then JSON-only prompting. */
  structured?: StructuredMode | 'auto'
  supportsImages?: boolean
  timeoutMs?: number
  /** Stream structured calls and collect the content. Default on. */
  streamStructured?: boolean
  /** Thinking controls for reasoning models. Off unless set. */
  reasoning?: ReasoningOptions
  fetch?: typeof fetch
  retry?: RetryOptions
}

export function chatUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error('The base URL must start with http:// or https://')
  return `${base}/chat/completions`
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): LlmProvider {
  const structured: StructuredMode[] =
    config.structured === 'json_schema' || config.structured === 'tools' || config.structured === 'prompt'
      ? [config.structured]
      : ['json_schema', 'prompt']
  return createOpenAIChatProvider({
    kind: 'openai-compatible',
    label: 'The local model server',
    model: config.model,
    url: chatUrl(config.baseUrl),
    headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
    structured,
    supportsImages: config.supportsImages ?? false,
    timeoutMs: config.timeoutMs ?? 300_000,
    secrets: config.apiKey ? [config.apiKey] : [],
    streamStructured: config.streamStructured ?? true,
    ...(config.reasoning ? { reasoning: config.reasoning } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
  })
}

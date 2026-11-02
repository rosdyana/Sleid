// Azure OpenAI and Foundry OpenAI-compatible deployments. Plain fetch to
// {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
// Structured output: json_schema when the deployment accepts it, otherwise a forced tool call.
import type { LlmProvider } from '../types.ts'
import type { RetryOptions } from '../retry.ts'
import { createOpenAIChatProvider, type StructuredMode } from './openai-chat.ts'

export const DEFAULT_AZURE_API_VERSION = '2024-10-21'

export interface AzureOpenAIConfig {
  /** Resource endpoint, e.g. https://my-resource.openai.azure.com (a trailing /openai is also accepted). */
  endpoint: string
  apiKey: string
  /** The deployment name. */
  deployment: string
  apiVersion?: string
  /** Structured output mode. `auto` tries json_schema, then tools. */
  structured?: StructuredMode | 'auto'
  supportsImages?: boolean
  timeoutMs?: number
  fetch?: typeof fetch
  retry?: RetryOptions
}

export function azureChatUrl(endpoint: string, deployment: string, apiVersion: string): string {
  const base = endpoint.trim().replace(/\/+$/, '').replace(/\/openai$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error('The Azure OpenAI endpoint must start with https://')
  return `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
}

export function createAzureOpenAIProvider(config: AzureOpenAIConfig): LlmProvider {
  const structured: StructuredMode[] =
    config.structured === 'json_schema' || config.structured === 'tools' || config.structured === 'prompt'
      ? [config.structured]
      : ['json_schema', 'tools']
  return createOpenAIChatProvider({
    kind: 'azure-openai',
    label: 'Azure OpenAI',
    model: config.deployment,
    url: azureChatUrl(config.endpoint, config.deployment, config.apiVersion ?? DEFAULT_AZURE_API_VERSION),
    headers: { 'api-key': config.apiKey },
    structured,
    supportsImages: config.supportsImages ?? false,
    timeoutMs: config.timeoutMs ?? 120_000,
    secrets: [config.apiKey],
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
  })
}

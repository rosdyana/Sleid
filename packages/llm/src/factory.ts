// Builds an adapter from a stored or environment-provided provider spec.
import { LlmError, publicMessage } from './errors.ts'
import { createFoundryClaudeProvider, type FoundryClaudeConfig } from './adapters/foundry-claude.ts'
import { createAzureOpenAIProvider } from './adapters/azure-openai.ts'
import { createOpenAICompatibleProvider } from './adapters/openai-compatible.ts'
import type { StructuredMode } from './adapters/openai-chat.ts'
import type { LlmProvider, ProviderKind } from './types.ts'
import type { RetryOptions } from './retry.ts'

export type ProviderSpec =
  | { kind: 'foundry-claude'; endpoint: string; apiKey: string; model: string; timeoutMs?: number }
  | {
      kind: 'azure-openai'
      endpoint: string
      apiKey: string
      deployment: string
      apiVersion?: string
      structured?: StructuredMode | 'auto'
      supportsImages?: boolean
      timeoutMs?: number
    }
  | {
      kind: 'openai-compatible'
      baseUrl: string
      apiKey?: string
      model: string
      structured?: StructuredMode | 'auto'
      supportsImages?: boolean
      timeoutMs?: number
    }

export interface FactoryOptions {
  fetch?: typeof fetch
  retry?: RetryOptions
}

export const PROVIDER_KINDS: readonly ProviderKind[] = ['foundry-claude', 'azure-openai', 'openai-compatible']

/** The model or deployment name a spec targets. */
export function specModel(spec: ProviderSpec): string {
  return spec.kind === 'azure-openai' ? spec.deployment : spec.model
}

export function createProvider(spec: ProviderSpec, options: FactoryOptions = {}): LlmProvider {
  const common = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
  }
  switch (spec.kind) {
    case 'foundry-claude': {
      if (!spec.endpoint || !spec.apiKey || !spec.model) throw new LlmError('not-configured', 'Claude on Foundry needs an endpoint, an API key and a model.')
      const config: FoundryClaudeConfig = { endpoint: spec.endpoint, apiKey: spec.apiKey, model: spec.model, ...common, ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) }
      return createFoundryClaudeProvider(config)
    }
    case 'azure-openai': {
      if (!spec.endpoint || !spec.apiKey || !spec.deployment) throw new LlmError('not-configured', 'Azure OpenAI needs an endpoint, an API key and a deployment name.')
      return createAzureOpenAIProvider({ ...spec, ...common })
    }
    case 'openai-compatible': {
      if (!spec.baseUrl || !spec.model) throw new LlmError('not-configured', 'A local model server needs a base URL and a model name.')
      return createOpenAICompatibleProvider({ ...spec, ...common })
    }
  }
}

/** Removes the key from an error message before it is shown or logged. */
export function scrubError(err: unknown, secrets: readonly string[]): string {
  let message = err instanceof Error ? err.message : String(err)
  for (const secret of secrets) if (secret.length >= 4) message = message.split(secret).join('[redacted]')
  return message
}

/**
 * What the user is shown for a failure. With `hideDetails` (user-owned providers) only the status-derived
 * message is returned. Otherwise the scrubbed message, which can include the provider's own error text.
 */
export function failureMessage(err: unknown, secrets: readonly string[], hideDetails: boolean): string {
  return hideDetails ? publicMessage(err) : scrubError(err, secrets)
}

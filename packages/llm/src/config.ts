// Environment settings for providers: the key for stored secrets, the server default provider, and the endpoint
// policy per scope. Pure functions over an env object, so the web app and the worker read the same rules.
import type { ProviderSpec } from './factory.ts'
import type { UrlPolicy } from './url-policy.ts'

export const ENV_PROVIDER_ID = 'env'

/**
 * LLM_USER_ALLOW_PRIVATE_URLS=1 lets user-owned providers use loopback and private addresses (a local Ollama or
 * LM Studio on a single-user setup). Off by default. Anything else, including "true", leaves it off.
 */
export function allowPrivateUserUrls(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLM_USER_ALLOW_PRIVATE_URLS === '1'
}

/**
 * The endpoint policy for a provider. Workspace providers (admins only) and the server default are set by an
 * operator, so they may use private addresses. User providers may not, unless the environment allows it.
 * Link-local and metadata addresses are refused for every scope.
 */
export function networkPolicyFor(scope: 'user' | 'workspace' | 'environment', env: NodeJS.ProcessEnv = process.env): UrlPolicy {
  return { allowPrivate: scope !== 'user' || allowPrivateUserUrls(env) }
}

/** LLM_SECRET_KEY: 32 random bytes, base64. Undefined when unset (saving a key then fails with a clear message). */
export function llmSecretKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LLM_SECRET_KEY?.trim() || undefined
}

export interface EnvProvider {
  name: string
  kind: ProviderSpec['kind']
  /** Shown in the UI: the endpoint without any credentials. */
  endpoint: string
  model: string
  hasKey: boolean
  supportsImages: boolean
  spec: ProviderSpec
}

/**
 * A provider configured by the deployment (SLEID_LLM_*), used when no database provider is chosen.
 * Returns null when SLEID_LLM_KIND is unset or incomplete.
 */
export function envProvider(env: NodeJS.ProcessEnv = process.env): EnvProvider | null {
  const kind = env.SLEID_LLM_KIND?.trim()
  if (!kind) return null
  const endpoint = env.SLEID_LLM_ENDPOINT?.trim() ?? ''
  const apiKey = env.SLEID_LLM_API_KEY?.trim() || undefined
  const model = env.SLEID_LLM_MODEL?.trim() ?? ''
  const structured = (env.SLEID_LLM_STRUCTURED?.trim() || 'auto') as 'auto' | 'json_schema' | 'tools' | 'prompt'
  const supportsImages = env.SLEID_LLM_SUPPORTS_IMAGES === 'true' || env.SLEID_LLM_SUPPORTS_IMAGES === '1'
  const name = env.SLEID_LLM_NAME?.trim() || 'Server default'
  const base = { name, endpoint, model, hasKey: !!apiKey, supportsImages }
  switch (kind) {
    case 'foundry-claude':
      if (!endpoint || !apiKey || !model) return null
      return { ...base, kind: 'foundry-claude', spec: { kind, endpoint, apiKey, model } }
    case 'azure-openai':
      if (!endpoint || !apiKey || !model) return null
      return {
        ...base,
        kind: 'azure-openai',
        spec: { kind, endpoint, apiKey, deployment: model, structured, supportsImages, ...(env.SLEID_LLM_API_VERSION ? { apiVersion: env.SLEID_LLM_API_VERSION } : {}) },
      }
    case 'openai-compatible':
      if (!endpoint || !model) return null
      return {
        ...base,
        kind: 'openai-compatible',
        spec: { kind, baseUrl: endpoint, model, structured, supportsImages, ...(apiKey ? { apiKey } : {}) },
      }
    default:
      return null
  }
}

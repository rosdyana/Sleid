// Environment settings for the assistant: admins, the key for stored secrets, an optional default
// provider from the environment, and the per-user rate limit. Read at call time, so tests can set them.
import type { ProviderSpec } from '@sleid/llm'

export const ENV_PROVIDER_ID = 'env'

/** Lower-cased emails from ADMIN_EMAILS (comma-separated). */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

export function isAdminEmail(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return adminEmails(env).includes(email.trim().toLowerCase())
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

export interface RateLimit {
  max: number
  windowMs: number
}

/** AI_RATE_LIMIT_MAX requests per AI_RATE_LIMIT_WINDOW_SECONDS per user. Defaults: 30 per 600 s. */
export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimit {
  const max = Number(env.AI_RATE_LIMIT_MAX ?? 30)
  const seconds = Number(env.AI_RATE_LIMIT_WINDOW_SECONDS ?? 600)
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 30,
    windowMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000,
  }
}

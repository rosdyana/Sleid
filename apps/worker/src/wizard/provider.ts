// The model provider for a wizard run, resolved in the worker. Same rules as the web app's resolveProvider
// (the user's provider, then the user's default, the workspace default, the server default), and the same
// endpoint policy: every request goes through the pinned fetch, which checks the address on each call.
import {
  createPinnedFetch,
  createProvider,
  decryptSecret,
  envProvider,
  ENV_PROVIDER_ID,
  llmSecretKey,
  networkPolicyFor,
  LlmError,
  type LlmProvider,
  type ProviderSpec,
} from '@sleid/llm'
import { getLlmProviderFor, listLlmProvidersFor, type Db, type LlmProviderRow } from '@sleid/db'

export interface ResolvedWizardProvider {
  provider: LlmProvider
  /** Smaller prompts and schemas (the provider's setting, or the kind's default). */
  compact: boolean
  /** Secrets to keep out of logs and errors. */
  secrets: string[]
  /** The database provider id, or null for the server default (usage rows take a uuid). */
  providerId: string | null
}

interface StoredConfig {
  endpoint: string
  apiVersion?: string
  structured?: 'auto' | 'json_schema' | 'tools' | 'prompt'
  supportsImages?: boolean
  compactPrompts?: boolean
  disableThinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
}

function configOf(row: LlmProviderRow): StoredConfig {
  const c = row.config as Record<string, unknown>
  const effort = ['low', 'medium', 'high'].find((e) => e === c.reasoningEffort) as StoredConfig['reasoningEffort']
  const structured = ['auto', 'json_schema', 'tools', 'prompt'].find((s) => s === c.structured) as StoredConfig['structured']
  return {
    endpoint: typeof c.endpoint === 'string' ? c.endpoint : '',
    ...(typeof c.apiVersion === 'string' ? { apiVersion: c.apiVersion } : {}),
    ...(structured ? { structured } : {}),
    ...(typeof c.supportsImages === 'boolean' ? { supportsImages: c.supportsImages } : {}),
    ...(typeof c.compactPrompts === 'boolean' ? { compactPrompts: c.compactPrompts } : {}),
    ...(c.disableThinking === true ? { disableThinking: true } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  }
}

function specFrom(row: LlmProviderRow, apiKey: string | undefined): ProviderSpec {
  const config = configOf(row)
  switch (row.kind) {
    case 'foundry-claude':
      return { kind: 'foundry-claude', endpoint: config.endpoint, apiKey: apiKey ?? '', model: row.defaultModel }
    case 'azure-openai':
      return {
        kind: 'azure-openai',
        endpoint: config.endpoint,
        apiKey: apiKey ?? '',
        deployment: row.defaultModel,
        ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        ...(config.structured ? { structured: config.structured } : {}),
        supportsImages: config.supportsImages ?? false,
      }
    case 'openai-compatible':
      return {
        kind: 'openai-compatible',
        baseUrl: config.endpoint,
        model: row.defaultModel,
        ...(apiKey ? { apiKey } : {}),
        ...(config.structured ? { structured: config.structured } : {}),
        supportsImages: config.supportsImages ?? false,
        ...(config.disableThinking ? { disableThinking: true } : {}),
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      }
  }
}

function fromRow(row: LlmProviderRow, env: NodeJS.ProcessEnv, doFetch?: typeof fetch): ResolvedWizardProvider {
  let apiKey: string | undefined
  if (row.secretCiphertext) {
    const key = llmSecretKey(env)
    if (!key) throw new LlmError('not-configured', 'LLM_SECRET_KEY is not set, so the stored key cannot be read.')
    apiKey = decryptSecret(row.secretCiphertext, key)
  }
  const config = configOf(row)
  const compact = config.compactPrompts ?? row.kind === 'openai-compatible'
  return {
    provider: createProvider(specFrom(row, apiKey), { fetch: doFetch ?? createPinnedFetch(networkPolicyFor(row.scope, env)) }),
    compact,
    secrets: apiKey ? [apiKey] : [],
    providerId: row.id,
  }
}

/** Resolves the run's provider. `providerId` null means "the user's default, then the workspace default, then the server default". */
export async function resolveWizardProvider(
  db: Db,
  env: NodeJS.ProcessEnv,
  userId: string,
  providerId: string | null,
  options: { doFetch?: typeof fetch } = {},
): Promise<ResolvedWizardProvider> {
  const fromEnv = envProvider(env)
  if (providerId === ENV_PROVIDER_ID) {
    if (!fromEnv) throw new LlmError('not-configured', 'The server default AI provider is not set (SLEID_LLM_KIND).')
    return envResolved(fromEnv, options.doFetch)
  }
  let row: LlmProviderRow | null = null
  if (providerId) {
    row = await getLlmProviderFor(db, userId, providerId)
    if (!row) throw new LlmError('bad-request', 'That AI provider is not available to you.')
  } else {
    const visible = await listLlmProvidersFor(db, userId)
    row = visible.find((r) => r.isDefault && r.scope === 'user') ?? visible.find((r) => r.isDefault) ?? null
    if (!row && fromEnv) return envResolved(fromEnv, options.doFetch)
    if (!row) throw new LlmError('not-configured', 'No AI provider is set up yet. Add one in Settings › AI.')
  }
  return fromRow(row, env, options.doFetch)
}

function envResolved(fromEnv: NonNullable<ReturnType<typeof envProvider>>, doFetch?: typeof fetch): ResolvedWizardProvider {
  const secrets = 'apiKey' in fromEnv.spec && fromEnv.spec.apiKey ? [fromEnv.spec.apiKey] : []
  return {
    provider: createProvider(fromEnv.spec, { fetch: doFetch ?? createPinnedFetch(networkPolicyFor('environment')) }),
    compact: fromEnv.kind === 'openai-compatible',
    secrets,
    providerId: null,
  }
}

// Provider settings: list, save, delete, default, and test. Plain functions over the database so the
// tests can call them. The server functions in llm-settings.functions.ts are thin wrappers.
//
// Rules: a user manages their own providers. Workspace providers are managed by admins (ADMIN_EMAILS).
// Keys are written once and never returned: the view carries only `hasSecret`.
import { z } from 'zod'
import {
  createProvider,
  decryptSecret,
  encryptSecret,
  foundryEndpointOptions,
  chatUrl,
  azureChatUrl,
  DEFAULT_AZURE_API_VERSION,
  LlmError,
  scrubError,
  type LlmProvider,
  type ProviderSpec,
} from '@sleid/llm'
import {
  deleteLlmProvider,
  getLlmProviderFor,
  insertLlmProvider,
  listLlmProvidersFor,
  setDefaultLlmProvider,
  updateLlmProvider,
  type Db,
  type LlmProviderKind,
  type LlmProviderRow,
} from '@sleid/db'
import { envProvider, ENV_PROVIDER_ID, isAdminEmail, llmSecretKey, type EnvProvider } from './llm-config.server'

export interface AiUser {
  id: string
  email: string
}

export interface ProviderView {
  id: string
  scope: 'user' | 'workspace' | 'environment'
  name: string
  kind: LlmProviderKind
  endpoint: string
  apiVersion: string | null
  structured: string | null
  supportsImages: boolean
  defaultModel: string
  isDefault: boolean
  /** True when a key is stored (or set in the environment). The key itself is never returned. */
  hasSecret: boolean
  editable: boolean
  source: 'database' | 'environment'
}

export const STRUCTURED_MODES = ['auto', 'json_schema', 'tools', 'prompt'] as const

export const ProviderInput = z.object({
  id: z.uuid().optional(),
  kind: z.enum(['foundry-claude', 'azure-openai', 'openai-compatible']),
  scope: z.enum(['user', 'workspace']).default('user'),
  name: z.string().trim().min(1, 'Give the provider a name').max(80),
  endpoint: z.string().trim().min(1, 'Enter the endpoint').max(300),
  defaultModel: z.string().trim().min(1, 'Enter the model or deployment name').max(120),
  apiVersion: z.string().trim().max(40).optional(),
  structured: z.enum(STRUCTURED_MODES).optional(),
  supportsImages: z.boolean().optional(),
  /** Write-only. Empty or missing keeps the stored key when editing, and stores none when creating. */
  apiKey: z.string().max(500).optional(),
  makeDefault: z.boolean().optional(),
})
export type ProviderInput = z.infer<typeof ProviderInput>

export interface SettingsDeps {
  db: Db
  env: NodeJS.ProcessEnv
  /** Overrides the HTTP layer of the adapters (tests). */
  fetch?: typeof fetch
}

export interface ResolvedProvider {
  provider: LlmProvider
  info: { id: string; name: string; kind: LlmProviderKind; model: string }
  /** Every secret this provider holds, for redaction. */
  secrets: string[]
}

function configOf(row: LlmProviderRow): { endpoint: string; apiVersion?: string; structured?: string; supportsImages?: boolean } {
  const c = row.config as Record<string, unknown>
  return {
    endpoint: typeof c.endpoint === 'string' ? c.endpoint : '',
    ...(typeof c.apiVersion === 'string' ? { apiVersion: c.apiVersion } : {}),
    ...(typeof c.structured === 'string' ? { structured: c.structured } : {}),
    ...(typeof c.supportsImages === 'boolean' ? { supportsImages: c.supportsImages } : {}),
  }
}

export function canManage(row: Pick<LlmProviderRow, 'scope' | 'ownerId'>, user: AiUser, env: NodeJS.ProcessEnv): boolean {
  if (row.scope === 'user') return row.ownerId === user.id
  return isAdminEmail(user.email, env)
}

function viewOf(row: LlmProviderRow, user: AiUser, env: NodeJS.ProcessEnv): ProviderView {
  const config = configOf(row)
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    kind: row.kind,
    endpoint: config.endpoint,
    apiVersion: config.apiVersion ?? null,
    structured: config.structured ?? null,
    supportsImages: config.supportsImages ?? false,
    defaultModel: row.defaultModel,
    isDefault: row.isDefault,
    hasSecret: !!row.secretCiphertext,
    editable: canManage(row, user, env),
    source: 'database',
  }
}

function envView(env: EnvProvider, isDefault: boolean): ProviderView {
  return {
    id: ENV_PROVIDER_ID,
    scope: 'environment',
    name: env.name,
    kind: env.kind,
    endpoint: env.endpoint,
    apiVersion: null,
    structured: null,
    supportsImages: env.supportsImages,
    defaultModel: env.model,
    isDefault,
    hasSecret: env.hasKey,
    editable: false,
    source: 'environment',
  }
}

/** The providers the user can pick, the admin flag, and the environment default when there is one. */
export async function listProviderViews(deps: SettingsDeps, user: AiUser): Promise<{ providers: ProviderView[]; isAdmin: boolean; envDefault: boolean }> {
  const rows = await listLlmProvidersFor(deps.db, user.id)
  const providers = rows.map((r) => viewOf(r, user, deps.env))
  const fromEnv = envProvider(deps.env)
  if (fromEnv) providers.push(envView(fromEnv, !providers.some((p) => p.isDefault)))
  return { providers, isAdmin: isAdminEmail(user.email, deps.env), envDefault: !!fromEnv }
}

/** Checks the endpoint for the kind, so a typo fails at save time with a clear message. */
export function checkEndpoint(kind: LlmProviderKind, endpoint: string, defaultModel: string): void {
  try {
    if (kind === 'foundry-claude') foundryEndpointOptions(endpoint)
    else if (kind === 'azure-openai') azureChatUrl(endpoint, defaultModel, DEFAULT_AZURE_API_VERSION)
    else chatUrl(endpoint)
  } catch (err) {
    throw new LlmError('bad-request', err instanceof Error ? err.message : 'The endpoint is not valid.')
  }
}

export async function saveProvider(deps: SettingsDeps, user: AiUser, rawInput: unknown): Promise<ProviderView> {
  const input = ProviderInput.parse(rawInput)
  if (input.scope === 'workspace' && !isAdminEmail(user.email, deps.env)) {
    throw new LlmError('auth', 'Only an administrator can change workspace providers.')
  }
  checkEndpoint(input.kind, input.endpoint, input.defaultModel)
  const key = input.apiKey?.trim() || undefined
  const config = {
    endpoint: input.endpoint,
    ...(input.kind === 'azure-openai' && input.apiVersion ? { apiVersion: input.apiVersion } : {}),
    ...(input.structured ? { structured: input.structured } : {}),
    ...(input.supportsImages !== undefined ? { supportsImages: input.supportsImages } : {}),
  }

  let row: LlmProviderRow
  if (input.id) {
    const existing = await getLlmProviderFor(deps.db, user.id, input.id)
    if (!existing || !canManage(existing, user, deps.env)) throw new LlmError('bad-request', 'Provider not found.')
    if (existing.scope !== input.scope) throw new LlmError('bad-request', 'A provider cannot change scope. Create a new one.')
    if (key && !llmSecretKey(deps.env)) throw new LlmError('not-configured', 'LLM_SECRET_KEY is not set, so a key cannot be stored. See .env.example.')
    const secretCiphertext = key ? encryptSecret(key, llmSecretKey(deps.env)) : existing.secretCiphertext
    await updateLlmProvider(deps.db, existing.id, {
      name: input.name,
      kind: input.kind,
      config,
      secretCiphertext,
      defaultModel: input.defaultModel,
    })
    row = { ...existing, name: input.name, kind: input.kind, config, secretCiphertext, defaultModel: input.defaultModel }
  } else {
    if (key && !llmSecretKey(deps.env)) throw new LlmError('not-configured', 'LLM_SECRET_KEY is not set, so a key cannot be stored. See .env.example.')
    row = await insertLlmProvider(deps.db, {
      scope: input.scope,
      ownerId: input.scope === 'user' ? user.id : null,
      name: input.name,
      kind: input.kind,
      config,
      secretCiphertext: key ? encryptSecret(key, llmSecretKey(deps.env)) : null,
      defaultModel: input.defaultModel,
    })
  }
  if (input.makeDefault) {
    await setDefaultLlmProvider(deps.db, row)
    row = { ...row, isDefault: true }
  }
  return viewOf(row, user, deps.env)
}

export async function removeProvider(deps: SettingsDeps, user: AiUser, providerId: string): Promise<void> {
  const row = await getLlmProviderFor(deps.db, user.id, providerId)
  if (!row || !canManage(row, user, deps.env)) throw new LlmError('bad-request', 'Provider not found.')
  await deleteLlmProvider(deps.db, providerId)
}

export async function makeDefaultProvider(deps: SettingsDeps, user: AiUser, providerId: string): Promise<void> {
  const row = await getLlmProviderFor(deps.db, user.id, providerId)
  if (!row || !canManage(row, user, deps.env)) throw new LlmError('bad-request', 'Provider not found.')
  await setDefaultLlmProvider(deps.db, row)
}

function specFrom(row: LlmProviderRow, apiKey: string | undefined): ProviderSpec {
  const config = configOf(row)
  const structured = (config.structured as 'auto' | 'json_schema' | 'tools' | 'prompt' | undefined) ?? undefined
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
        ...(structured ? { structured } : {}),
        supportsImages: config.supportsImages ?? false,
      }
    case 'openai-compatible':
      return {
        kind: 'openai-compatible',
        baseUrl: config.endpoint,
        model: row.defaultModel,
        ...(apiKey ? { apiKey } : {}),
        ...(structured ? { structured } : {}),
        supportsImages: config.supportsImages ?? false,
      }
  }
}

function secretOf(row: LlmProviderRow, env: NodeJS.ProcessEnv): string | undefined {
  if (!row.secretCiphertext) return undefined
  const key = llmSecretKey(env)
  if (!key) throw new LlmError('not-configured', 'LLM_SECRET_KEY is not set, so the stored key cannot be read. See .env.example.')
  return decryptSecret(row.secretCiphertext, key)
}

function envSecrets(env: EnvProvider): string[] {
  const key = 'apiKey' in env.spec ? env.spec.apiKey : undefined
  return key ? [key] : []
}

function providerOptions(deps: SettingsDeps) {
  return deps.fetch ? { fetch: deps.fetch } : {}
}

/**
 * The provider for a request. Order: the chosen one (when it is visible to the user), otherwise the user's default,
 * the workspace default, and the environment default.
 */
export async function resolveProvider(deps: SettingsDeps, user: AiUser, providerId: string | null | undefined): Promise<ResolvedProvider> {
  const fromEnv = envProvider(deps.env)
  if (providerId === ENV_PROVIDER_ID) {
    if (!fromEnv) throw new LlmError('not-configured', 'The server default AI provider is not set (SLEID_LLM_KIND).')
    return {
      provider: createProvider(fromEnv.spec, providerOptions(deps)),
      info: { id: ENV_PROVIDER_ID, name: fromEnv.name, kind: fromEnv.kind, model: fromEnv.model },
      secrets: envSecrets(fromEnv),
    }
  }
  let row: LlmProviderRow | null = null
  if (providerId) {
    row = await getLlmProviderFor(deps.db, user.id, providerId)
    if (!row) throw new LlmError('bad-request', 'That AI provider is not available to you.')
  } else {
    const visible = await listLlmProvidersFor(deps.db, user.id)
    row = visible.find((r) => r.isDefault && r.scope === 'user') ?? visible.find((r) => r.isDefault) ?? null
    if (!row && fromEnv) {
      return {
        provider: createProvider(fromEnv.spec, providerOptions(deps)),
        info: { id: ENV_PROVIDER_ID, name: fromEnv.name, kind: fromEnv.kind, model: fromEnv.model },
        secrets: envSecrets(fromEnv),
      }
    }
    if (!row) throw new LlmError('not-configured', 'No AI provider is set up yet. Add one in Settings › AI.')
  }
  const apiKey = secretOf(row, deps.env)
  const spec = specFrom(row, apiKey)
  return {
    provider: createProvider(spec, providerOptions(deps)),
    info: { id: row.id, name: row.name, kind: row.kind, model: row.defaultModel },
    secrets: apiKey ? [apiKey] : [],
  }
}

export interface ConnectionTest {
  ok: boolean
  model: string
  latencyMs: number
  /** The model's short reply, when the test worked. */
  reply?: string
  /** The reason, when it did not. Keys are removed from it. */
  error?: string
}

/** Sends one tiny request to check a provider. Returns the outcome, never throws for provider problems. */
export async function testProvider(deps: SettingsDeps, user: AiUser, providerId: string | null): Promise<ConnectionTest> {
  const started = Date.now()
  let resolved: ResolvedProvider
  try {
    resolved = await resolveProvider(deps, user, providerId)
  } catch (err) {
    return { ok: false, model: '', latencyMs: Date.now() - started, error: scrubError(err, []) }
  }
  try {
    const reply = await resolved.provider.generate({
      system: 'You are a connection test. Answer with one short word.',
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      maxTokens: 16,
      temperature: 0,
    })
    return {
      ok: true,
      model: reply.model,
      latencyMs: Date.now() - started,
      reply: reply.text.trim().slice(0, 40),
    }
  } catch (err) {
    return { ok: false, model: resolved.info.model, latencyMs: Date.now() - started, error: scrubError(err, resolved.secrets) }
  }
}

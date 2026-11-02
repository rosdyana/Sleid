// Provider settings against real Postgres: visibility, admin rules, key handling, the default,
// the connection test, the rate limit and the editor-only rule. Skips when the database is unreachable.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decryptSecret, LlmError } from '@sleid/llm'
import { getLlmProviderFor, grantMembership, recordLlmUsage, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { checkRateLimit, requireEditorOn } from './ai.server.ts'
import { listProviderViews, makeDefaultProvider, removeProvider, resolveProvider, saveProvider, testProvider, type AiUser, type SettingsDeps } from './llm-settings.server.ts'
import { startLlmTestServer, type LlmTestServer } from './llm-test-server.ts'

const KEY = randomBytes(32).toString('base64')
const SECRET = `sk-local-${randomUUID()}`
const ADMIN_EMAIL = `admin-${randomUUID()}@example.com`

let db: Db | null = null
let alice: AiUser
let bob: AiUser
let admin: AiUser
let editorUser: AiUser
let viewerUser: AiUser
let deckId = ''
const userIds: string[] = []
let server: LlmTestServer | undefined

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { LLM_SECRET_KEY: KEY, ADMIN_EMAILS: ADMIN_EMAIL, ...extra } as NodeJS.ProcessEnv
}

function deps(extra: Record<string, string | undefined> = {}): SettingsDeps {
  return { db: db!, env: env(extra) }
}

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  const people = await Promise.all([makeUser(db, 'ai-alice'), makeUser(db, 'ai-bob'), makeUser(db, 'ai-editor'), makeUser(db, 'ai-viewer')])
  const adminRow = await makeUser(db, 'ai-admin')
  // The admin's email must be the one in ADMIN_EMAILS, so set it on the row.
  await db.$client`update "user" set email = ${ADMIN_EMAIL} where id = ${adminRow.id}`
  alice = { id: people[0]!.id, email: people[0]!.email }
  bob = { id: people[1]!.id, email: people[1]!.email }
  editorUser = { id: people[2]!.id, email: people[2]!.email }
  viewerUser = { id: people[3]!.id, email: people[3]!.email }
  admin = { id: adminRow.id, email: ADMIN_EMAIL }
  userIds.push(alice.id, bob.id, editorUser.id, viewerUser.id, admin.id)
  deckId = await makeDeck(db, alice.id, 'AI test deck')
  await db.transaction((tx) => grantMembership(tx, deckId, editorUser.id, 'editor'))
  await db.transaction((tx) => grantMembership(tx, deckId, viewerUser.id, 'viewer'))
})

afterAll(async () => {
  await server?.close()
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
})

describe('provider settings (database)', () => {
  it('saves a provider with its key encrypted, and never returns the key', async () => {
    if (!db) return
    const view = await saveProvider(deps(), alice, {
      kind: 'azure-openai',
      name: 'My Azure',
      endpoint: 'https://example.openai.azure.com',
      defaultModel: 'gpt-deploy',
      apiVersion: '2024-10-21',
      structured: 'json_schema',
      apiKey: SECRET,
    })
    const serialised = JSON.stringify(view)
    expect(serialised).not.toContain(SECRET)
    expect(view).toMatchObject({ hasSecret: true, editable: true, source: 'database', endpoint: 'https://example.openai.azure.com', scope: 'user' })
    const row = await getLlmProviderFor(db, alice.id, view.id)
    expect(row!.secretCiphertext).toMatch(/^v1:/)
    expect(row!.secretCiphertext).not.toContain(SECRET)
    expect(decryptSecret(row!.secretCiphertext!, KEY)).toBe(SECRET)
  })

  it('shows a user only their own providers, plus the workspace ones', async () => {
    if (!db) return
    const { providers } = await listProviderViews(deps(), bob)
    expect(providers.find((p) => p.name === 'My Azure')).toBeUndefined()
    const { providers: mine } = await listProviderViews(deps(), alice)
    expect(mine.find((p) => p.name === 'My Azure')).toBeDefined()
    expect(JSON.stringify(mine)).not.toContain(SECRET)
  })

  it('keeps the stored key when an edit leaves the key field empty, and replaces it when a new one is typed', async () => {
    if (!db) return
    const created = await saveProvider(deps(), alice, { kind: 'openai-compatible', name: 'Edit me', endpoint: 'http://127.0.0.1:1234/v1', defaultModel: 'm1', apiKey: SECRET })
    const edited = await saveProvider(deps(), alice, { id: created.id, kind: 'openai-compatible', name: 'Edited', endpoint: 'http://127.0.0.1:1234/v1', defaultModel: 'm2' })
    expect(edited).toMatchObject({ name: 'Edited', defaultModel: 'm2', hasSecret: true })
    const row = await getLlmProviderFor(db, alice.id, created.id)
    expect(decryptSecret(row!.secretCiphertext!, KEY)).toBe(SECRET)
    await saveProvider(deps(), alice, { id: created.id, kind: 'openai-compatible', name: 'Edited', endpoint: 'http://127.0.0.1:1234/v1', defaultModel: 'm2', apiKey: 'sk-new-key-value' })
    const again = await getLlmProviderFor(db, alice.id, created.id)
    expect(decryptSecret(again!.secretCiphertext!, KEY)).toBe('sk-new-key-value')
    await removeProvider(deps(), alice, created.id)
  })

  it('refuses to store a key without LLM_SECRET_KEY, but allows a keyless local provider', async () => {
    if (!db) return
    const noKey = { LLM_SECRET_KEY: undefined } as Record<string, string | undefined>
    await expect(saveProvider(deps(noKey), alice, { kind: 'foundry-claude', name: 'F', endpoint: 'res', defaultModel: 'claude-opus-5-5', apiKey: SECRET })).rejects.toMatchObject({
      kind: 'not-configured',
    })
    const local = await saveProvider(deps(noKey), alice, { kind: 'openai-compatible', name: 'Local no key', endpoint: 'http://127.0.0.1:11434/v1', defaultModel: 'llama' })
    expect(local.hasSecret).toBe(false)
    await removeProvider(deps(noKey), alice, local.id)
  })

  it('checks the endpoint for its kind before saving', async () => {
    if (!db) return
    await expect(saveProvider(deps(), alice, { kind: 'openai-compatible', name: 'Bad', endpoint: 'ftp://nope', defaultModel: 'm' })).rejects.toMatchObject({ kind: 'bad-request' })
    await expect(saveProvider(deps(), alice, { kind: 'azure-openai', name: 'Bad', endpoint: 'no-scheme', defaultModel: 'd' })).rejects.toMatchObject({ kind: 'bad-request' })
  })

  it('lets only an admin change workspace providers', async () => {
    if (!db) return
    await expect(saveProvider(deps(), alice, { kind: 'openai-compatible', scope: 'workspace', name: 'Shared', endpoint: 'http://127.0.0.1:1/v1', defaultModel: 'm' })).rejects.toMatchObject({
      kind: 'auth',
    })
    const shared = await saveProvider(deps(), admin, { kind: 'openai-compatible', scope: 'workspace', name: 'Shared local', endpoint: 'http://127.0.0.1:1/v1', defaultModel: 'm' })
    expect(shared).toMatchObject({ scope: 'workspace', editable: true })
    const seenByAlice = await listProviderViews(deps(), alice)
    expect(seenByAlice.providers.find((p) => p.id === shared.id)).toMatchObject({ scope: 'workspace', editable: false })
    await expect(removeProvider(deps(), alice, shared.id)).rejects.toThrow(/not found/)
    await removeProvider(deps(), admin, shared.id)
  })

  it('makes one default per user, and removes a provider', async () => {
    if (!db) return
    const a = await saveProvider(deps(), bob, { kind: 'openai-compatible', name: 'B1', endpoint: 'http://127.0.0.1:1/v1', defaultModel: 'm', makeDefault: true })
    const b = await saveProvider(deps(), bob, { kind: 'openai-compatible', name: 'B2', endpoint: 'http://127.0.0.1:1/v1', defaultModel: 'm' })
    await makeDefaultProvider(deps(), bob, b.id)
    const { providers } = await listProviderViews(deps(), bob)
    expect(providers.filter((p) => p.isDefault && p.scope === 'user').map((p) => p.id)).toEqual([b.id])
    expect(providers.find((p) => p.id === a.id)?.isDefault).toBe(false)
    await removeProvider(deps(), bob, a.id)
    await removeProvider(deps(), bob, b.id)
  })

  it('the environment default is listed, never editable, and carries no key', async () => {
    if (!db) return
    const withEnv = deps({ SLEID_LLM_KIND: 'foundry-claude', SLEID_LLM_ENDPOINT: 'my-res', SLEID_LLM_API_KEY: 'env-secret-value-1234', SLEID_LLM_MODEL: 'claude-opus-5-5' })
    const { providers, envDefault } = await listProviderViews(withEnv, alice)
    expect(envDefault).toBe(true)
    const envView = providers.find((p) => p.id === 'env')
    expect(envView).toMatchObject({ source: 'environment', editable: false, hasSecret: true, isDefault: true })
    expect(JSON.stringify(providers)).not.toContain('env-secret-value-1234')
  })

  it('resolves a provider from its stored key and sends it as the bearer token', async () => {
    if (!db) return
    server = await startLlmTestServer([{ text: 'Hello from the fake server' }])
    const view = await saveProvider(deps(), alice, { kind: 'openai-compatible', name: 'Fake', endpoint: server.url, defaultModel: 'fake-local', apiKey: SECRET })
    const resolved = await resolveProvider(deps(), alice, view.id)
    expect(resolved.info).toMatchObject({ id: view.id, model: 'fake-local' })
    const reply = await resolved.provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 20, temperature: 0 })
    expect(reply.text).toBe('Hello from the fake server')
    expect(server.seen.at(-1)!.headers.authorization).toBe(`Bearer ${SECRET}`)
  })

  it('a test connection reports OK with the latency and the model, and scrubs the key from failures', async () => {
    if (!db) return
    server = await startLlmTestServer([{ text: 'OK' }, { status: 401, error: `bad key ${SECRET}` }])
    const view = await saveProvider(deps(), alice, { kind: 'openai-compatible', name: 'Test me', endpoint: server.url, defaultModel: 'fake-local', apiKey: SECRET })
    const ok = await testProvider(deps(), alice, view.id)
    expect(ok).toMatchObject({ ok: true, model: 'fake-local', reply: 'OK' })
    expect(typeof ok.latencyMs).toBe('number')
    const failed = await testProvider(deps(), alice, view.id)
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('[redacted]')
    expect(JSON.stringify(failed)).not.toContain(SECRET)
    await removeProvider(deps(), alice, view.id)
  })

  it('reports a missing provider without throwing', async () => {
    if (!db) return
    const result = await testProvider(deps(), alice, randomUUID())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not available/)
  })
})

describe('request rules (database)', () => {
  it('only editors and owners may run the assistant on a deck', async () => {
    if (!db) return
    await requireEditorOn(db, alice.id, deckId)
    await requireEditorOn(db, editorUser.id, deckId)
    await expect(requireEditorOn(db, viewerUser.id, deckId)).rejects.toMatchObject({ kind: 'auth' })
    await expect(requireEditorOn(db, bob.id, deckId)).rejects.toMatchObject({ kind: 'bad-request', message: 'Deck not found' })
  })

  it('refuses requests past the per-user limit, and counts failed ones', async () => {
    if (!db) return
    const carol = await makeUser(db, 'ai-ratelimit')
    userIds.push(carol.id)
    const limit = { max: 3, windowMs: 60_000 }
    for (let i = 0; i < 3; i++) {
      await recordLlmUsage(db, { userId: carol.id, deckId, providerId: null, ability: 'explain', inputTokens: 0, outputTokens: 0, latencyMs: 1, ok: i !== 0 })
    }
    await expect(checkRateLimit(db, carol.id, {}, new Date(), limit)).rejects.toMatchObject({ kind: 'rate-limit' })
    await expect(checkRateLimit(db, alice.id, {}, new Date(), limit)).resolves.toBeUndefined()
  })

  it('a missing provider id gives a clear error', async () => {
    if (!db) return
    await expect(resolveProvider(deps({ SLEID_LLM_KIND: undefined }), alice, null)).rejects.toMatchObject({ kind: 'not-configured' })
    await expect(resolveProvider(deps(), alice, 'env')).rejects.toBeInstanceOf(LlmError)
  })
})

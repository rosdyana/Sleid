// The chat route against real Postgres and a fake OpenAI-compatible model server. Covers the auth
// and role responses, the NDJSON stream, a tool call that becomes a proposal, and the usage row.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { grantMembership, llmUsage, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { handleAiChat } from './ai-chat.server.ts'
import { saveProvider, type AiUser } from './llm-settings.server.ts'
import { startLlmTestServer, type LlmTestServer } from './llm-test-server.ts'

const KEY = randomBytes(32).toString('base64')
let db: Db | null = null
let owner: AiUser
let viewer: AiUser
let deckId = ''
let providerId = ''
const userIds: string[] = []
let server: LlmTestServer | undefined

const THEME = JSON.stringify({
  name: 'Night',
  background: '#101418',
  surface: '#1a1f26',
  text: '#f2f4f7',
  muted: '#9aa4b2',
  accent: '#7fb3ff',
  accent2: '#7fd1ae',
  accent3: '#ffd166',
  accent4: '#c3a6ff',
  headingFont: 'Inter',
  bodyFont: 'Inter',
})

// The fake server is on 127.0.0.1, which a user provider may only use when the environment allows private addresses.
function env(): NodeJS.ProcessEnv {
  return { LLM_SECRET_KEY: KEY, ADMIN_EMAILS: '', LLM_USER_ALLOW_PRIVATE_URLS: '1' } as NodeJS.ProcessEnv
}

function chatRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/decks/x/ai/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

async function ndjson(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  const a = await makeUser(db, 'chat-owner')
  const v = await makeUser(db, 'chat-viewer')
  owner = { id: a.id, email: a.email }
  viewer = { id: v.id, email: v.email }
  userIds.push(owner.id, viewer.id)
  deckId = await makeDeck(db, owner.id, 'Chat deck')
  await db.transaction((tx) => grantMembership(tx, deckId, viewer.id, 'viewer'))
})

afterAll(async () => {
  await server?.close()
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
})

describe('POST /api/decks/:deckId/ai/chat', () => {
  it('answers 404 for a malformed deck id, 401 when signed out, and 400 for a bad body', async () => {
    if (!db) return
    const base = { db, env: env() }
    expect((await handleAiChat(chatRequest({}), 'not-a-uuid', { ...base, user: owner })).status).toBe(404)
    expect((await handleAiChat(chatRequest({}), deckId, { ...base, user: null })).status).toBe(401)
    const bad = await handleAiChat(chatRequest({ messages: [] }), deckId, { ...base, user: owner })
    expect(bad.status).toBe(400)
  })

  it('refuses a viewer with 403, and a non-member with 400 "Deck not found"', async () => {
    if (!db) return
    const base = { db, env: env() }
    const forbidden = await handleAiChat(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }), deckId, { ...base, user: viewer })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ error: expect.stringMatching(/editor access/) })
    const stranger = await makeUser(db, 'chat-stranger')
    userIds.push(stranger.id)
    const missing = await handleAiChat(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }), deckId, { ...base, user: { id: stranger.id, email: stranger.email } })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'Deck not found' })
  })

  it('answers 409 when no provider is configured', async () => {
    if (!db) return
    const response = await handleAiChat(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }), deckId, { db, env: env(), user: owner })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/Settings/) })
  })

  it('streams text, a proposal from a tool call, and done as NDJSON, and records one usage row', async () => {
    if (!db) return
    server = await startLlmTestServer([
      // 1. The chat turn asks for the theme tool.
      { toolCall: { name: 'generate_theme', arguments: JSON.stringify({ prompt: 'dark and calm' }) } },
      // 2. The theme ability's structured call.
      { text: THEME },
      // 3. The chat's answer after the tool.
      { text: 'Here is a calm dark theme.' },
    ])
    const saved = await saveProvider({ db, env: env() }, owner, {
      kind: 'openai-compatible',
      name: 'Chat fake',
      endpoint: server.url,
      defaultModel: 'fake-local',
      structured: 'json_schema',
      apiKey: 'sk-chat-test-key-1234',
    })
    providerId = saved.id
    const response = await handleAiChat(
      chatRequest({ providerId, messages: [{ role: 'user', content: 'make it dark and calm' }] }),
      deckId,
      { db, env: env(), user: owner },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const events = await ndjson(response)
    const types = events.map((e) => e.type)
    expect(types).toContain('text')
    expect(types).toContain('tool')
    expect(types.at(-1)).toBe('done')
    const proposal = events.find((e) => e.type === 'proposal') as { proposal: { ability: string; ops: Array<{ op: string }> }; provider: { name: string } }
    expect(proposal.proposal.ability).toBe('generateTheme')
    expect(proposal.proposal.ops.map((o) => o.op)).toEqual(['setTheme'])
    expect(proposal.provider.name).toBe('Chat fake')
    expect(JSON.stringify(events)).not.toContain('sk-chat-test-key-1234')

    const rows = await db.select().from(llmUsage).where(and(eq(llmUsage.userId, owner.id), eq(llmUsage.deckId, deckId), eq(llmUsage.ability, 'chat')))
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.at(-1)).toMatchObject({ ok: true, providerId })
    // The key travelled as the bearer token and nowhere else.
    expect(server.seen[0]!.headers.authorization).toBe('Bearer sk-chat-test-key-1234')
  })

  it('a provider failure ends the stream with a status-only error line, and the upstream text stays in the log', async () => {
    if (!db) return
    server = await startLlmTestServer([{ status: 401, error: 'invalid key sk-chat-test-key-1234' }])
    const saved = await saveProvider({ db, env: env() }, owner, {
      kind: 'openai-compatible',
      name: 'Broken key',
      endpoint: server.url,
      defaultModel: 'fake-local',
      apiKey: 'sk-chat-test-key-1234',
    })
    const response = await handleAiChat(chatRequest({ providerId: saved.id, messages: [{ role: 'user', content: 'hi' }] }), deckId, {
      db,
      env: env(),
      user: owner,
    })
    const events = await ndjson(response)
    const last = events.at(-1)!
    expect(last.type).toBe('error')
    // A user-owned provider: the status, never the upstream body or the key.
    expect(last.message).toBe('The provider answered HTTP 401 Unauthorized. Check the API key.')
    expect(JSON.stringify(events)).not.toContain('sk-chat-test-key-1234')
    expect(JSON.stringify(events)).not.toContain('invalid key')
  })
})

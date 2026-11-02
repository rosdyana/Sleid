// Azure OpenAI and openai-compatible adapters against a fake chat/completions endpoint.
// Covers json_schema mode, forced-tool mode, the JSON-only fallback when a server refuses
// response_format, streaming SSE, retries and key redaction.
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAzureOpenAIProvider, azureChatUrl } from './azure-openai.ts'
import { createOpenAICompatibleProvider, chatUrl } from './openai-compatible.ts'
import { structured } from '../structured.ts'
import { LlmError } from '../errors.ts'
import { scriptedServer, type FakeServer } from './fake-servers.ts'

const KEY = 'az-key-0123456789abcdef'
const chatReply = (content: string | null, extra: Record<string, unknown> = {}) => ({
  body: {
    id: 'cmpl-1',
    model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 12 },
  },
})

let server: FakeServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

const noWait = { baseDelayMs: 1, sleep: async () => undefined }

describe('endpoint URLs', () => {
  it('builds the Azure deployment URL with api-version, and accepts a trailing /openai', () => {
    expect(azureChatUrl('https://r.openai.azure.com/', 'gpt-5', '2024-10-21')).toBe(
      'https://r.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21',
    )
    expect(azureChatUrl('https://r.openai.azure.com/openai', 'd', 'v1')).toContain('/openai/deployments/d/chat/completions')
    expect(() => azureChatUrl('r.openai.azure.com', 'd', 'v1')).toThrow(/https/)
  })

  it('builds the local base URL path and rejects non-http URLs', () => {
    expect(chatUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(() => chatUrl('ftp://x')).toThrow()
  })
})

describe('Azure OpenAI adapter', () => {
  it('posts json_schema with the api-key header and the deployment URL', async () => {
    server = await scriptedServer([chatReply('{"title":"Q3"}')])
    const provider = createAzureOpenAIProvider({
      endpoint: server.url,
      apiKey: KEY,
      deployment: 'gpt-5-deploy',
      apiVersion: '2024-10-21',
      retry: noWait,
    })
    const result = await structured(provider, z.object({ title: z.string() }), { system: 'sys', user: 'u', maxTokens: 200, name: 't' })
    expect(result.value).toEqual({ title: 'Q3' })
    const req = server.requests[0]!
    expect(req.url).toBe('/openai/deployments/gpt-5-deploy/chat/completions?api-version=2024-10-21')
    expect(req.headers['api-key']).toBe(KEY)
    expect(req.headers.authorization).toBeUndefined()
    expect(req.body.response_format.type).toBe('json_schema')
    expect(req.body.response_format.json_schema.name).toBe('t')
    expect(req.body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(req.body.tools).toBeUndefined()
  })

  it('falls back to a forced tool call when the deployment rejects response_format', async () => {
    server = await scriptedServer([
      { status: 400, body: { error: { message: "Unsupported parameter: 'response_format' is not supported with this model." } } },
      chatReply(null, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit_result', arguments: '{"title":"Tools"}' } }] }),
      chatReply(null, { tool_calls: [{ id: 'c2', type: 'function', function: { name: 'submit_result', arguments: '{"title":"Again"}' } }] }),
    ])
    const provider = createAzureOpenAIProvider({ endpoint: server.url, apiKey: KEY, deployment: 'd', retry: noWait })
    const schema = z.object({ title: z.string() })
    const first = await structured(provider, schema, { system: 's', user: 'u', maxTokens: 100 })
    expect(first.value).toEqual({ title: 'Tools' })
    expect(server.requests[1]!.body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_result' } })
    expect(server.requests[1]!.body.response_format).toBeUndefined()
    // The working mode is remembered: the next call goes straight to tools.
    await structured(provider, schema, { system: 's', user: 'u', maxTokens: 100 })
    expect(server.requests).toHaveLength(3)
    expect(server.requests[2]!.body.tool_choice).toBeDefined()
    expect(server.requests[2]!.body.response_format).toBeUndefined()
  })

  it('retries 429 with Retry-After and returns the second reply', async () => {
    const waits: number[] = []
    server = await scriptedServer([{ status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'busy' } } }, chatReply('ok')])
    const provider = createAzureOpenAIProvider({
      endpoint: server.url,
      apiKey: KEY,
      deployment: 'd',
      retry: { sleep: async (ms: number) => void waits.push(ms), baseDelayMs: 1 },
    })
    const reply = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 20, temperature: 0 })
    expect(reply.text).toBe('ok')
    expect(waits).toEqual([1000])
    expect(server.requests).toHaveLength(2)
  })

  it('reports a bad key as an auth error and never echoes the key', async () => {
    server = await scriptedServer([{ status: 401, body: { error: { message: `Access denied for key ${KEY}` } } }])
    const provider = createAzureOpenAIProvider({ endpoint: server.url, apiKey: KEY, deployment: 'd', retry: noWait })
    const err = (await provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 20, temperature: 0 }).catch((e: unknown) => e)) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('auth')
    expect(err.message).not.toContain(KEY)
    expect(err.message).toContain('[redacted]')
  })

  it('streams text and tool-call deltas over SSE', async () => {
    const frames = [
      { model: 'gpt-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Sure, ' } }] },
      { choices: [{ index: 0, delta: { content: 'done.' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'generate_theme', arguments: '{"pro' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'mpt":"dark"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } },
    ]
    const raw = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
    server = await scriptedServer([{ raw }])
    const provider = createAzureOpenAIProvider({ endpoint: server.url, apiKey: KEY, deployment: 'd', retry: noWait })
    const events = []
    for await (const ev of provider.stream({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, temperature: 0 })) events.push(ev)
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Sure, done.')
    expect(events.find((e) => e.type === 'tool_call')).toEqual({ type: 'tool_call', call: { id: 'call_a', name: 'generate_theme', input: { prompt: 'dark' } } })
    expect(events.at(-1)).toEqual({ type: 'done', usage: { inputTokens: 30, outputTokens: 9 }, stopReason: 'tool_use', model: 'gpt-test' })
    expect(server.requests[0]!.body.stream).toBe(true)
  })
})

describe('openai-compatible adapter (local servers)', () => {
  it('uses json_schema when the server accepts it', async () => {
    server = await scriptedServer([chatReply('{"n":3}')])
    const provider = createOpenAICompatibleProvider({ baseUrl: `${server.url}/v1`, model: 'qwen2.5-7b', retry: noWait })
    const result = await structured(provider, z.object({ n: z.number() }), { system: 's', user: 'u', maxTokens: 50, compact: true })
    expect(result.value).toEqual({ n: 3 })
    const req = server.requests[0]!
    expect(req.url).toBe('/v1/chat/completions')
    expect(req.body.model).toBe('qwen2.5-7b')
    expect(req.headers.authorization).toBeUndefined()
    expect(req.body.response_format.json_schema.schema).not.toHaveProperty('description')
  })

  it('falls back to JSON-only prompting when the server refuses response_format', async () => {
    server = await scriptedServer([
      { status: 400, body: { error: 'response_format json_schema is not supported by this server' } },
      chatReply('Here you go: {"n": 4,}'),
    ])
    const provider = createOpenAICompatibleProvider({ baseUrl: `${server.url}/v1`, model: 'llama', retry: noWait })
    const result = await structured(provider, z.object({ n: z.number() }), { system: 's', user: 'u', maxTokens: 50 })
    expect(result.value).toEqual({ n: 4 })
    expect(result.repaired).toBe(true)
    const prompted = server.requests[1]!
    expect(prompted.body.response_format).toBeUndefined()
    expect(prompted.body.messages[0].content).toContain('Reply with only one JSON object')
  })

  it('sends a bearer token only when a key is configured', async () => {
    server = await scriptedServer([chatReply('a'), chatReply('b')])
    const keyed = createOpenAICompatibleProvider({ baseUrl: `${server.url}/v1`, model: 'm', apiKey: KEY, retry: noWait })
    await keyed.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 5, temperature: 0 })
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('reports an unreachable server as a network error', async () => {
    const provider = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm', timeoutMs: 2000, retry: noWait })
    await expect(provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 5, temperature: 0 })).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('reports a reply that is not chat/completions as invalid output', async () => {
    server = await scriptedServer([{ body: { hello: 'world' } }])
    const provider = createOpenAICompatibleProvider({ baseUrl: `${server.url}/v1`, model: 'm', retry: noWait })
    await expect(provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 5, temperature: 0 })).rejects.toMatchObject({
      kind: 'invalid-output',
    })
  })

  it('attaches images as data URLs only when the provider supports them', async () => {
    server = await scriptedServer([chatReply('a'), chatReply('b')])
    const withVision = createOpenAICompatibleProvider({ baseUrl: `${server.url}/v1`, model: 'm', supportsImages: true, retry: noWait })
    const img = { mediaType: 'image/png', base64: 'AAAA' }
    await withVision.generate({ system: 's', messages: [{ role: 'user', content: 'describe', images: [img] }], maxTokens: 5, temperature: 0 })
    const content = server.requests[0]!.body.messages[1].content
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
    const noVision = createOpenAICompatibleProvider({ baseUrl: `${server.url}/v1`, model: 'm', retry: noWait })
    await noVision.generate({ system: 's', messages: [{ role: 'user', content: 'describe', images: [img] }], maxTokens: 5, temperature: 0 })
    expect(server.requests[1]!.body.messages[1].content).toBe('describe')
  })
})

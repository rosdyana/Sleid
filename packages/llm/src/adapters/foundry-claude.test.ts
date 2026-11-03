// Foundry adapter against a fake Anthropic-Messages endpoint. Asserts the request shape the SDK sends
// (model, forced tool, the x-api-key header, the path under /anthropic/) and that the key never reaches logs or errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createFoundryClaudeProvider, foundryEndpointOptions, toAnthropicMessages } from './foundry-claude.ts'
import { structured } from '../structured.ts'
import { LlmError } from '../errors.ts'
import { scriptedServer, type FakeServer } from './fake-servers.ts'

const KEY = 'test-foundry-key-9f8e7d6c'

function messageReply(content: unknown[], stop = 'end_turn') {
  return {
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason: stop,
      usage: { input_tokens: 120, output_tokens: 30 },
    },
  }
}

let server: FakeServer
const logged: string[] = []
const spies: Array<ReturnType<typeof vi.spyOn>> = []

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    spies.push(
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '))
      }),
    )
  }
})

afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore()
  logged.length = 0
  await server?.close()
})

function providerFor(url: string, extra: Record<string, unknown> = {}) {
  return createFoundryClaudeProvider({
    endpoint: `${url}/anthropic/`,
    apiKey: KEY,
    model: 'claude-opus-5-5',
    retry: { baseDelayMs: 1, sleep: async () => undefined },
    ...extra,
  })
}

describe('foundry endpoint options', () => {
  it('accepts a bare resource name or the portal URL, normalised to /anthropic/', () => {
    expect(foundryEndpointOptions('my-res')).toEqual({ resource: 'my-res' })
    const want = { resource: null, baseURL: 'https://my-res.services.ai.azure.com/anthropic/' }
    expect(foundryEndpointOptions('https://my-res.services.ai.azure.com/anthropic')).toEqual(want)
    expect(foundryEndpointOptions('https://my-res.services.ai.azure.com/')).toEqual(want)
    expect(() => foundryEndpointOptions('my res!')).toThrow()
  })
})

describe('Foundry Claude adapter (fake Anthropic endpoint)', () => {
  it('sends the forced-tool structured request and reads the tool input back as JSON text', async () => {
    server = await scriptedServer([messageReply([{ type: 'tool_use', id: 'tu_1', name: 'submit_result', input: { title: 'Hi' } }], 'tool_use')])
    const provider = providerFor(server.url)
    const schema = z.object({ title: z.string() })
    const result = await structured(provider, schema, { system: 'sys', user: 'make a title', maxTokens: 500, name: 'title' })

    expect(result.value).toEqual({ title: 'Hi' })
    expect(result.model).toBe('claude-opus-5-5')
    const req = server.requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/anthropic/v1/messages')
    expect(req.headers['x-api-key']).toBe(KEY)
    expect(req.headers['anthropic-version']).toBeTruthy()
    expect(req.headers.authorization).toBeUndefined()
    expect(req.body.model).toBe('claude-opus-5-5')
    expect(req.body.max_tokens).toBe(500)
    expect(req.body.system).toBe('sys')
    expect(req.body.tools).toHaveLength(1)
    expect(req.body.tools[0].name).toBe('submit_result')
    expect(req.body.tools[0].input_schema).toMatchObject({ type: 'object', properties: { title: { type: 'string' } } })
    expect(req.body.tools[0].input_schema).not.toHaveProperty('$schema')
    expect(req.body.tool_choice).toEqual({ type: 'tool', name: 'submit_result' })
    expect(req.body).not.toHaveProperty('temperature')
    expect(req.body.stream).toBeUndefined()
  })

  it('maps tool-use requests for chat, and streams text deltas', async () => {
    server = await scriptedServer([
      messageReply([{ type: 'tool_use', id: 'tu_9', name: 'generate_theme', input: { prompt: 'dark' } }], 'tool_use'),
    ])
    const provider = providerFor(server.url)
    const reply = await provider.generate({
      system: 'sys',
      messages: [{ role: 'user', content: 'theme please' }],
      tools: [{ name: 'generate_theme', description: 'theme', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }],
      maxTokens: 300,
      temperature: 0.2,
    })
    expect(reply.toolCalls).toEqual([{ id: 'tu_9', name: 'generate_theme', input: { prompt: 'dark' } }])
    expect(reply.stopReason).toBe('tool_use')
    expect(reply.usage).toEqual({ inputTokens: 120, outputTokens: 30 })
    expect(server.requests[0]!.body.tool_choice).toEqual({ type: 'auto' })
  })

  it('retries a 429 with the Retry-After delay, then succeeds', async () => {
    const waits: number[] = []
    server = await scriptedServer([
      { status: 429, headers: { 'retry-after': '2' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } },
      messageReply([{ type: 'text', text: 'OK' }]),
    ])
    const provider = providerFor(server.url, { retry: { baseDelayMs: 1, sleep: async (ms: number) => void waits.push(ms) } })
    const reply = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, temperature: 0 })
    expect(reply.text).toBe('OK')
    expect(server.requests).toHaveLength(2)
    expect(waits).toEqual([2000])
  })

  it('retries 5xx at most twice, then reports a typed server error', async () => {
    server = await scriptedServer([{ status: 503, body: { error: { message: 'overloaded' } } }])
    const provider = providerFor(server.url)
    const err = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, temperature: 0 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('server')
    expect(server.requests).toHaveLength(3)
  })

  it('reports a 401 as an auth error once, without the key in the message or in logs', async () => {
    server = await scriptedServer([{ status: 401, body: { error: { message: `invalid key ${KEY}` } } }])
    const provider = providerFor(server.url)
    const err = (await provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, temperature: 0 }).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('auth')
    expect(err.message).not.toContain(KEY)
    expect(server.requests).toHaveLength(1)
    expect(logged.join('\n')).not.toContain(KEY)
  })

  it('aborts an in-flight request when the caller signals', async () => {
    server = await scriptedServer([{ delayMs: 2000, body: {} }])
    const provider = providerFor(server.url)
    const controller = new AbortController()
    const pending = provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, temperature: 0, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('times out a slow endpoint with a timeout error', async () => {
    server = await scriptedServer([{ delayMs: 1500, body: {} }])
    const provider = providerFor(server.url, { timeoutMs: 100 })
    await expect(provider.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, temperature: 0 })).rejects.toMatchObject({
      kind: 'timeout',
    })
  })

  it('streams text as deltas and reports tool calls and usage at the end', async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":40,"output_tokens":1}}}\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_2","name":"speaker_notes","input":{}}}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"tone\\":\\"friendly\\"}"}}\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":12}}\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n',
      '',
    ].join('\n')
    server = await scriptedServer([{ raw: sse }])
    const provider = providerFor(server.url)
    const events = []
    for await (const ev of provider.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, temperature: 0 })) events.push(ev)
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')
    expect(text).toBe('Hello there')
    expect(events.find((e) => e.type === 'tool_call')).toEqual({ type: 'tool_call', call: { id: 'tu_2', name: 'speaker_notes', input: { tone: 'friendly' } } })
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use', model: 'claude-opus-5-5' })
    expect(server.requests[0]!.body.stream).toBe(true)
  })
})

describe('Foundry message conversion', () => {
  it('sends pictures as base64 image blocks only when the provider supports them', () => {
    const img = { mediaType: 'image/png', base64: 'AAAA' }
    const withImage = toAnthropicMessages([{ role: 'user', content: 'describe', images: [img] }], true)
    expect(withImage[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'describe' },
    ])
    expect(toAnthropicMessages([{ role: 'user', content: 'describe', images: [img] }], false)[0]!.content).toBe('describe')
  })

  it('turns tool calls and tool results into tool_use and tool_result blocks', () => {
    const out = toAnthropicMessages(
      [
        { role: 'user', content: 'theme please' },
        { role: 'assistant', content: 'On it.', toolCalls: [{ id: 'tu_1', name: 'generate_theme', input: { prompt: 'dark' } }] },
        { role: 'tool', toolCallId: 'tu_1', content: 'Prepared a proposal' },
      ],
      false,
    )
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: 'tu_1', name: 'generate_theme', input: { prompt: 'dark' } },
      ],
    })
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Prepared a proposal' }] })
  })
})


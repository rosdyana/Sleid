import { afterEach, describe, expect, it } from 'vitest'
import { assertAllowedEndpoint, classifyAddress, createPinnedFetch, parseIPv6, refusalFor, type LookupFn, type UrlPolicy } from './url-policy.ts'
import { createFoundryClaudeProvider } from './adapters/foundry-claude.ts'
import { createOpenAICompatibleProvider } from './adapters/openai-compatible.ts'
import { startFakeServer, type FakeServer } from './adapters/fake-servers.ts'
import { LlmError } from './errors.ts'

const USER: UrlPolicy = { allowPrivate: false }
const LOCAL: UrlPolicy = { allowPrivate: true }

/** A stub resolver: each host maps to a list of addresses. Unknown hosts fail like DNS does. */
function stubLookup(map: Record<string, string[]>): { lookup: LookupFn; calls: string[] } {
  const calls: string[] = []
  const lookup: LookupFn = async (host) => {
    calls.push(host)
    const addresses = map[host]
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  return { lookup, calls }
}

async function refusedBy(url: string, policy: UrlPolicy, lookup?: LookupFn): Promise<string | null> {
  try {
    await assertAllowedEndpoint(url, policy, lookup)
    return null
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError)
    return (err as LlmError).message
  }
}

describe('address classes (IPv4)', () => {
  const refused: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['169.254.1.1', 'link-local'],
    ['169.254.169.254', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
  ]
  for (const [address, cls] of refused) {
    it(`${address} is ${cls}`, () => {
      expect(classifyAddress(address)).toBe(cls)
      expect(refusalFor(classifyAddress(address), USER)).not.toBeNull()
    })
  }

  const publicAddresses = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '192.167.0.1', '100.128.0.1', '100.63.255.255']
  for (const address of publicAddresses) {
    it(`${address} is public and allowed`, () => {
      expect(classifyAddress(address)).toBe('public')
      expect(refusalFor(classifyAddress(address), USER)).toBeNull()
    })
  }
})

describe('address classes (IPv6, every written form)', () => {
  const cases: Array<[string, string]> = [
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0:0:0:0:0:ffff:7f00:0001', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::127.0.0.1', 'loopback'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['2002:7f00:1::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['FE80::1%eth0', 'link-local'],
    ['febf::1', 'link-local'],
    ['fc00::1', 'private'],
    ['fd12:3456:789a::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
    ['2001::1', 'reserved'],
  ]
  for (const [address, cls] of cases) {
    it(`${address} is ${cls}`, () => {
      expect(classifyAddress(address)).toBe(cls)
    })
  }

  it('global unicast addresses are public', () => {
    expect(classifyAddress('2606:4700:4700::1111')).toBe('public')
    expect(classifyAddress('2001:4860:4860::8888')).toBe('public')
  })

  it('parses the compressed and embedded forms to the same bytes', () => {
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual(parseIPv6('::ffff:7f00:1'))
    expect(parseIPv6('0:0:0:0:0:0:0:1')).toEqual(parseIPv6('::1'))
  })

  it('treats malformed IPv6 text as reserved, never as public', () => {
    for (const bad of ['1:2:3', ':::', '1::2::3', '1:2:3:4:5:6:7:8:9', 'g::1']) {
      expect(parseIPv6(bad)).toBeNull()
      expect(classifyAddress(bad)).toBe('reserved')
    }
  })
})

describe('refusal rules', () => {
  it('link-local and metadata are refused even when private addresses are allowed', () => {
    expect(refusalFor('link-local', LOCAL)).toMatch(/never allowed/)
    expect(refusalFor('metadata', LOCAL)).toMatch(/never allowed/)
  })

  it('loopback and private are allowed only when the policy allows them', () => {
    expect(refusalFor('loopback', LOCAL)).toBeNull()
    expect(refusalFor('private', LOCAL)).toBeNull()
    expect(refusalFor('loopback', USER)).toMatch(/LLM_USER_ALLOW_PRIVATE_URLS=1/)
  })
})

describe('endpoint checks (literal addresses)', () => {
  it('refuses loopback and private literals for a user provider, with a clear message', async () => {
    const message = await refusedBy('http://127.0.0.1:3002/', USER)
    expect(message).toMatch(/The address 127\.0\.0\.1 is a loopback address/)
    expect(message).toMatch(/administrator/)
    expect(await refusedBy('http://[::1]:3002/', USER)).toMatch(/loopback/)
    expect(await refusedBy('http://10.1.2.3/v1', USER)).toMatch(/private network/)
    expect(await refusedBy('http://[::ffff:127.0.0.1]/', USER)).toMatch(/loopback/)
  })

  it('refuses numeric host forms that the URL parser turns into loopback', async () => {
    expect(await refusedBy('http://2130706433/', USER)).toMatch(/loopback/)
    expect(await refusedBy('http://0x7f.0.0.1/', USER)).toMatch(/loopback/)
    expect(await refusedBy('http://0177.0.0.1/', USER)).toMatch(/loopback/)
  })

  it('allows loopback and private literals when private addresses are allowed, and any port', async () => {
    expect(await refusedBy('http://127.0.0.1:11434/v1', LOCAL)).toBeNull()
    expect(await refusedBy('http://10.1.2.3:1/v1', LOCAL)).toBeNull()
    expect(await refusedBy('https://93.184.216.34:8443/v1', USER)).toBeNull()
  })

  it('always refuses metadata and link-local literals, even when private addresses are allowed', async () => {
    expect(await refusedBy('http://169.254.169.254/latest/meta-data/', LOCAL)).toMatch(/link-local address, which is never allowed/)
    expect(await refusedBy('http://[fd00:ec2::254]/', LOCAL)).toMatch(/cloud metadata address, which is never allowed/)
    expect(await refusedBy('http://[::ffff:169.254.169.254]/', LOCAL)).toMatch(/never allowed/)
    expect(await refusedBy('http://[fe80::1]:3002/', LOCAL)).toMatch(/never allowed/)
    expect(await refusedBy('http://169.254.169.254/', USER)).toMatch(/never allowed/)
  })

  it('accepts only http and https, and refuses credentials and invalid URLs', async () => {
    expect(await refusedBy('ftp://93.184.216.34/', USER)).toMatch(/must start with http/)
    expect(await refusedBy('file:///etc/passwd', USER)).toMatch(/must start with http/)
    expect(await refusedBy('http://user:pass@93.184.216.34/', USER)).toMatch(/must not contain a user name or password/)
    expect(await refusedBy('http://user@93.184.216.34/', USER)).toMatch(/must not contain a user name or password/)
    expect(await refusedBy('not a url', USER)).toMatch(/not a valid URL/)
  })
})

describe('endpoint checks (host names)', () => {
  const { lookup } = stubLookup({
    'api.example.test': ['93.184.216.34'],
    'internal.example.test': ['10.1.2.3'],
    'loopback.example.test': ['127.0.0.1'],
    'mixed.example.test': ['93.184.216.34', '127.0.0.1'],
    'mixed-meta.example.test': ['93.184.216.34', '169.254.169.254'],
    'meta.example.test': ['169.254.169.254'],
    'meta6.example.test': ['fd00:ec2::254'],
    'empty.example.test': [],
  })

  it('a host that resolves to a public address is allowed for a user provider', async () => {
    const vetted = await assertAllowedEndpoint('https://api.example.test/v1', USER, lookup)
    expect(vetted.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('a host that resolves to a private address is refused for a user provider and allowed with private addresses', async () => {
    expect(await refusedBy('https://internal.example.test/v1', USER, lookup)).toMatch(/"internal.example.test" resolves to a private network address/)
    expect(await refusedBy('https://loopback.example.test/v1', USER, lookup)).toMatch(/resolves to a loopback address/)
    expect(await refusedBy('https://internal.example.test/v1', LOCAL, lookup)).toBeNull()
  })

  it('refuses when any one of several addresses is not allowed', async () => {
    expect(await refusedBy('https://mixed.example.test/v1', USER, lookup)).toMatch(/mixed.example.test/)
    expect(await refusedBy('https://mixed-meta.example.test/v1', LOCAL, lookup)).toMatch(/never allowed/)
  })

  it('refuses metadata addresses behind a host name, even when private addresses are allowed', async () => {
    expect(await refusedBy('https://meta.example.test/', LOCAL, lookup)).toMatch(/never allowed/)
    expect(await refusedBy('https://meta6.example.test/', LOCAL, lookup)).toMatch(/never allowed/)
  })

  it('refuses localhost for a user provider without asking DNS', async () => {
    const { lookup: unused, calls } = stubLookup({})
    expect(await refusedBy('http://localhost:3002/', USER, unused)).toMatch(/resolves to a loopback address/)
    expect(calls).toEqual([])
  })

  it('refuses a host that does not resolve or resolves to nothing', async () => {
    expect(await refusedBy('https://nowhere.example.test/', USER, lookup)).toMatch(/could not be resolved/)
    expect(await refusedBy('https://empty.example.test/', USER, lookup)).toMatch(/could not be resolved/)
  })
})

describe('pinned fetch', () => {
  let server: FakeServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('connects to the vetted address and keeps the host name for Host and SNI', async () => {
    server = await startFakeServer(() => ({ body: { ok: true } }))
    const port = Number(new URL(server.url).port)
    const { lookup, calls } = stubLookup({ 'pinned.example.test': ['127.0.0.1'] })
    const pinned = createPinnedFetch(LOCAL, { lookup })
    const response = await pinned(`http://pinned.example.test:${port}/hello`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(server.requests[0]!.headers.host).toBe(`pinned.example.test:${port}`)
    expect(calls).toEqual(['pinned.example.test'])
  })

  it('does not look the host up again to connect (a second answer cannot redirect the request)', async () => {
    server = await startFakeServer(() => ({ body: { ok: true } }))
    const port = Number(new URL(server.url).port)
    // The first answer is the vetted loopback address. Any later answer is a private address that would not be reachable.
    let count = 0
    const lookup: LookupFn = async () => {
      count++
      return count === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]
    }
    const response = await createPinnedFetch(LOCAL, { lookup })(`http://rebind.example.test:${port}/x`)
    expect(response.status).toBe(200)
    expect(count).toBe(1)
    expect(server.requests).toHaveLength(1)
  })

  it('refuses before any connection when the vetted address is not allowed', async () => {
    server = await startFakeServer(() => ({ body: { ok: true } }))
    const port = Number(new URL(server.url).port)
    const { lookup } = stubLookup({ 'internal.example.test': ['127.0.0.1'] })
    await expect(createPinnedFetch(USER, { lookup })(`http://internal.example.test:${port}/`)).rejects.toMatchObject({ kind: 'bad-request' })
    expect(server.requests).toHaveLength(0)
  })

  it('returns a redirect as it is and never follows it', async () => {
    server = await startFakeServer(() => ({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, body: {} }))
    const port = Number(new URL(server.url).port)
    const { lookup } = stubLookup({ 'redirect.example.test': ['127.0.0.1'] })
    const response = await createPinnedFetch(LOCAL, { lookup })(`http://redirect.example.test:${port}/v1/chat/completions`)
    expect(response.status).toBe(302)
    expect(server.requests).toHaveLength(1)
  })

  it('keeps a streamed body readable after the response headers arrive', async () => {
    const frames = 'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    server = await startFakeServer(() => ({ raw: frames }))
    const port = Number(new URL(server.url).port)
    const { lookup } = stubLookup({ 'stream.example.test': ['127.0.0.1'] })
    const response = await createPinnedFetch(LOCAL, { lookup })(`http://stream.example.test:${port}/v1/chat/completions`)
    expect(await response.text()).toBe(frames)
  })

  it('a local OpenAI-compatible provider works through the pinned fetch', async () => {
    const reply = {
      model: 'pinned-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pinned OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }
    server = await startFakeServer(() => ({ body: reply }))
    const port = Number(new URL(server.url).port)
    const { lookup } = stubLookup({ 'local.example.test': ['127.0.0.1'] })
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://local.example.test:${port}/v1`,
      model: 'pinned-model',
      structured: 'prompt',
      fetch: createPinnedFetch(LOCAL, { lookup }),
    })
    const result = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, temperature: 0 })
    expect(result.text).toBe('pinned OK')
  })

  it('an adapter reports a redirect as an error that names the redirect, not the target', async () => {
    server = await startFakeServer(() => ({ status: 307, headers: { location: 'http://10.0.0.5/' }, body: {} }))
    const port = Number(new URL(server.url).port)
    const { lookup } = stubLookup({ 'hop.example.test': ['127.0.0.1'] })
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://hop.example.test:${port}/v1`,
      model: 'm',
      structured: 'prompt',
      fetch: createPinnedFetch(LOCAL, { lookup }),
    })
    const error = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, temperature: 0 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).kind).toBe('bad-request')
    expect((error as LlmError).status).toBe(307)
    expect((error as LlmError).message).toMatch(/redirect \(HTTP 307\)/)
    expect(server.requests).toHaveLength(1)
  })

  it('Claude on Foundry goes through the pinned fetch, and a refused endpoint surfaces its own message', async () => {
    const message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'foundry OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    }
    server = await startFakeServer(() => ({ body: message }))
    const port = Number(new URL(server.url).port)
    const { lookup } = stubLookup({ 'foundry.example.test': ['127.0.0.1'] })
    const provider = createFoundryClaudeProvider({
      endpoint: `http://foundry.example.test:${port}/`,
      apiKey: 'test-key-1234',
      model: 'claude-test',
      fetch: createPinnedFetch(LOCAL, { lookup }),
    })
    const result = await provider.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, temperature: 0 })
    expect(result.text).toBe('foundry OK')
    expect(server.requests[0]!.url).toBe('/anthropic/v1/messages')

    const refused = createFoundryClaudeProvider({
      endpoint: `http://foundry.example.test:${port}/`,
      apiKey: 'test-key-1234',
      model: 'claude-test',
      fetch: createPinnedFetch(USER, { lookup }),
    })
    const error = await refused.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, temperature: 0 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).message).toMatch(/resolves to a loopback address/)
    expect(server.requests).toHaveLength(1)
  })
})

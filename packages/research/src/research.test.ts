import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { researchFromEnv, researchStatusLine, createSearchProvider, ResearchError, dedupeResults, canonicalUrl } from './index.ts'

describe('configuration', () => {
  it('uses SearXNG first, then Brave, then Tavily, and none when unset', () => {
    expect(researchFromEnv({})).toBeNull()
    expect(researchFromEnv({ TAVILY_API_KEY: 't', BRAVE_API_KEY: 'b' })?.kind).toBe('brave')
    expect(researchFromEnv({ TAVILY_API_KEY: 't', BRAVE_API_KEY: 'b', SEARXNG_URL: 'http://127.0.0.1:8888/' })?.kind).toBe('searxng')
    expect(researchFromEnv({ TAVILY_API_KEY: 't' })?.kind).toBe('tavily')
  })

  it('shows the host, never a key', () => {
    const line = researchStatusLine({ BRAVE_API_KEY: 'secret-key-123' })
    expect(line).toBe('Research: Brave Search')
    expect(line).not.toContain('secret-key-123')
    expect(researchStatusLine({ SEARXNG_URL: 'http://127.0.0.1:8888' })).toBe('Research: SearXNG at 127.0.0.1:8888')
    expect(researchStatusLine({})).toContain('not configured')
  })

  it('refuses a SEARXNG_URL that is not http', () => {
    expect(() => researchFromEnv({ SEARXNG_URL: 'ftp://x' })).toThrow(/http/)
    expect(() => researchFromEnv({ SEARXNG_URL: 'not a url' })).toThrow(/valid URL/)
  })
})

describe('SearXNG adapter (fake JSON server)', () => {
  let server: Server
  let base = ''
  const seen: string[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? '')
      if (req.url?.startsWith('/search?') && req.url.includes('format=json')) {
        if (req.url.includes('q=broken')) {
          res.writeHead(500)
          return res.end('boom')
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(
          JSON.stringify({
            results: [
              { title: 'Solar grants', url: 'https://example.org/grants?utm_source=x', content: 'Grants  for\nrooftop solar.' },
              { title: 'Script link', url: 'javascript:alert(1)', content: 'bad' },
              { title: '', url: 'https://example.org/untitled', content: 'no title' },
            ],
          }),
        )
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('returns only http(s) results with a title, normalised', async () => {
    const provider = createSearchProvider(researchFromEnv({ SEARXNG_URL: base })!, { searxngPolicy: { allowPrivate: true } })
    const results = await provider.search('solar grants', { limit: 5 })
    expect(results).toEqual([{ title: 'Solar grants', url: 'https://example.org/grants?utm_source=x', snippet: 'Grants for rooftop solar.' }])
    expect(seen.some((u) => u.includes('q=solar+grants') && u.includes('format=json'))).toBe(true)
  })

  it('fails with the HTTP status when the server errors', async () => {
    const provider = createSearchProvider(researchFromEnv({ SEARXNG_URL: base })!, { searxngPolicy: { allowPrivate: true } })
    await expect(provider.search('broken', { limit: 3 })).rejects.toMatchObject({ status: 500 })
    await expect(provider.search('broken', { limit: 3 })).rejects.toBeInstanceOf(ResearchError)
  })

  it('reaches the configured SearXNG host by default (its one private host), and only that host', async () => {
    const provider = createSearchProvider(researchFromEnv({ SEARXNG_URL: base })!)
    const results = await provider.search('solar', { limit: 3 })
    expect(results).toHaveLength(1)
    expect(seen[seen.length - 1]).toContain('/search?')
  })
})

describe('Brave and Tavily adapters (injected transport)', () => {
  it('Brave sends the subscription header and reads web.results', async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      captured = { url, headers: init?.headers as Record<string, string> }
      return new Response(JSON.stringify({ web: { results: [{ title: 'Rooftop solar', url: 'https://a.example/x', description: 'Good <b>read</b>' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const provider = createSearchProvider(researchFromEnv({ BRAVE_API_KEY: 'k1' })!, { fetch: fakeFetch })
    const results = await provider.search('rooftop solar', { limit: 4 })
    expect(results[0]).toEqual({ title: 'Rooftop solar', url: 'https://a.example/x', snippet: 'Good <b>read</b>' })
    expect(captured!.url).toContain('count=4')
    expect(captured!.headers['x-subscription-token']).toBe('k1')
  })

  it('Tavily posts the query with a bearer token', async () => {
    let body: unknown = null
    let auth = ''
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      auth = (init?.headers as Record<string, string>).authorization ?? ''
      return new Response(JSON.stringify({ results: [{ title: 'Panels', url: 'https://t.example/p', content: 'Panel prices.' }] }), { status: 200 })
    }) as typeof fetch
    const provider = createSearchProvider(researchFromEnv({ TAVILY_API_KEY: 'tk' })!, { fetch: fakeFetch })
    const results = await provider.search('panel prices', { limit: 2 })
    expect(results).toHaveLength(1)
    expect(body).toEqual({ query: 'panel prices', max_results: 2 })
    expect(auth).toBe('Bearer tk')
  })

  it('a non-JSON reply is a ResearchError', async () => {
    const fakeFetch = (async () => new Response('<html>', { status: 200 })) as typeof fetch
    const provider = createSearchProvider(researchFromEnv({ TAVILY_API_KEY: 'tk' })!, { fetch: fakeFetch })
    await expect(provider.search('x', { limit: 1 })).rejects.toThrow(/not JSON/)
  })
})

describe('de-duplication', () => {
  it('canonicalises host case, fragments and tracking parameters', () => {
    expect(canonicalUrl('https://Example.com/a/?utm_source=x&b=1#frag')).toBe('https://example.com/a/?b=1')
    expect(canonicalUrl('https://example.com/a?b=1&a=2')).toBe(canonicalUrl('https://example.com/a?a=2&b=1'))
  })

  it('keeps the first of duplicate URLs', () => {
    const out = dedupeResults([
      { title: 'First', url: 'https://x.example/p?utm_medium=y', snippet: '' },
      { title: 'Second', url: 'https://X.example/p', snippet: '' },
      { title: 'Other', url: 'https://x.example/q', snippet: '' },
    ])
    expect(out.map((r) => r.title)).toEqual(['First', 'Other'])
  })
})

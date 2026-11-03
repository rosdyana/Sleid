import { createPinnedFetch, type UrlPolicy } from '@sleid/llm'
import type { SearchProvider, SearchResult } from './types.ts'
import { ResearchError } from './types.ts'
import type { ResearchConfig } from './config.ts'

export interface ProviderOptions {
  /** Test-only override for the transport. Production uses the pinned fetch. */
  fetch?: typeof fetch
  /** Test-only: lets the SearXNG check reach a loopback test server. Production never sets it. */
  searxngPolicy?: UrlPolicy
}

async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new ResearchError(`${label} answered HTTP ${response.status}.`, response.status)
  }
  try {
    return await response.json()
  } catch {
    throw new ResearchError(`${label} returned something that is not JSON.`)
  }
}

function strings(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
}

/** Keeps only http(s) results with a title. Anything else from a search engine is dropped. */
export function normaliseResults(items: unknown[]): SearchResult[] {
  const out: SearchResult[] = []
  for (const item of items) {
    const r = (item ?? {}) as Record<string, unknown>
    const url = strings(r.url)
    const title = strings(r.title)
    if (!title || !/^https?:\/\//i.test(url)) continue
    out.push({ title: title.slice(0, 200), url, snippet: strings(r.content ?? r.snippet ?? r.description) })
  }
  return out
}

export function createSearchProvider(config: ResearchConfig, options: ProviderOptions = {}): SearchProvider {
  switch (config.kind) {
    case 'searxng': {
      const base = config.baseUrl!
      const host = new URL(base).host
      // The configured SearXNG host is the one private address allowed for research, and only that host is ever called.
      const doFetch = options.fetch ?? createPinnedFetch(options.searxngPolicy ?? { allowPrivate: true })
      return {
        kind: 'searxng',
        label: config.label,
        async search(query, { limit, signal }) {
          const url = new URL('/search', base)
          url.searchParams.set('q', query)
          url.searchParams.set('format', 'json')
          if (new URL(url).host !== host) throw new ResearchError('The search URL does not match the configured host.')
          const response = await doFetch(url.href, { signal: signal ?? AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
          const body = (await readJson(response, 'SearXNG')) as { results?: unknown[] }
          return normaliseResults(Array.isArray(body.results) ? body.results : []).slice(0, limit)
        },
      }
    }
    case 'brave': {
      const doFetch = options.fetch ?? createPinnedFetch({ allowPrivate: false })
      return {
        kind: 'brave',
        label: config.label,
        async search(query, { limit, signal }) {
          const url = new URL('https://api.search.brave.com/res/v1/web/search')
          url.searchParams.set('q', query)
          url.searchParams.set('count', String(Math.min(limit, 20)))
          const response = await doFetch(url.href, {
            signal: signal ?? AbortSignal.timeout(15_000),
            headers: { accept: 'application/json', 'x-subscription-token': config.apiKey! },
          })
          const body = (await readJson(response, 'Brave Search')) as { web?: { results?: unknown[] } }
          return normaliseResults(body.web?.results ?? []).slice(0, limit)
        },
      }
    }
    case 'tavily': {
      const doFetch = options.fetch ?? createPinnedFetch({ allowPrivate: false })
      return {
        kind: 'tavily',
        label: config.label,
        async search(query, { limit, signal }) {
          const response = await doFetch('https://api.tavily.com/search', {
            method: 'POST',
            signal: signal ?? AbortSignal.timeout(15_000),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey!}` },
            body: JSON.stringify({ query, max_results: Math.min(limit, 20) }),
          })
          const body = (await readJson(response, 'Tavily')) as { results?: unknown[] }
          return normaliseResults(body.results ?? []).slice(0, limit)
        },
      }
    }
  }
}

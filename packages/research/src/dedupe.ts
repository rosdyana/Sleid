import type { SearchResult } from './types.ts'

const TRACKING = /^(utm_|fbclid$|gclid$|ref$|ref_src$)/i

/** The canonical form of a URL for comparing results: lower-case host, no fragment, no tracking parameters, no trailing slash. */
export function canonicalUrl(raw: string): string {
  const url = new URL(raw)
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
  url.searchParams.sort()
  let href = url.href
  if (url.pathname !== '/' && href.endsWith('/') && !url.search) href = href.slice(0, -1)
  return href
}

/** Merges results from several queries: first occurrence wins, duplicates by canonical URL are dropped. */
export function dedupeResults(results: readonly SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const r of results) {
    const key = canonicalUrl(r.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

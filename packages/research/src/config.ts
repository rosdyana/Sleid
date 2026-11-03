// Research (web search) settings from the environment. The first one set wins: SearXNG, then Brave, then Tavily.
// Nothing here is returned to a client with its secret; the UI shows only `label`.
export interface ResearchConfig {
  kind: 'searxng' | 'brave' | 'tavily'
  label: string
  baseUrl?: string
  apiKey?: string
}

export function researchFromEnv(env: NodeJS.ProcessEnv = process.env): ResearchConfig | null {
  const searx = env.SEARXNG_URL?.trim()
  if (searx) {
    let url: URL
    try {
      url = new URL(searx)
    } catch {
      throw new Error('SEARXNG_URL is not a valid URL.')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('SEARXNG_URL must start with http:// or https://.')
    return { kind: 'searxng', label: `SearXNG at ${url.host}`, baseUrl: url.href.replace(/\/$/, '') }
  }
  const brave = env.BRAVE_API_KEY?.trim()
  if (brave) return { kind: 'brave', label: 'Brave Search', apiKey: brave }
  const tavily = env.TAVILY_API_KEY?.trim()
  if (tavily) return { kind: 'tavily', label: 'Tavily', apiKey: tavily }
  return null
}

/** The line shown on the AI settings page. */
export function researchStatusLine(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const config = researchFromEnv(env)
    return config ? `Research: ${config.label}` : 'Research: not configured (set SEARXNG_URL, BRAVE_API_KEY or TAVILY_API_KEY)'
  } catch (err) {
    return `Research: misconfigured (${err instanceof Error ? err.message : 'invalid setting'})`
  }
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchProvider {
  readonly kind: 'searxng' | 'brave' | 'tavily'
  /** Shown in the UI. Never contains a credential. */
  readonly label: string
  search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]>
}

export class ResearchError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ResearchError'
    this.status = status
  }
}

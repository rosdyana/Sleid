// The worker's client for the collab internal API (same contract as apps/web/src/lib/collab-client.server.ts).
// Ops are applied to the live document as `server:wizard`, so open editors receive each slide as it lands.
import type { Deck } from '@sleid/model'

export interface WizardCollab {
  applyOps(deckId: string, actor: string, ops: readonly unknown[]): Promise<{ ok: true }>
  getDeck(deckId: string): Promise<Deck>
}

export function createWizardCollab(options: { baseUrl: string; secret: string; fetch?: typeof fetch }): WizardCollab {
  const base = options.baseUrl.replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: { 'x-sleid-internal': options.secret, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const message = typeof (payload as { error?: unknown } | null)?.error === 'string' ? (payload as { error: string }).error : `collab internal API ${response.status}`
      throw new Error(message)
    }
    return payload as T
  }
  return {
    applyOps: (deckId, actor, ops) => call('POST', `/internal/decks/${encodeURIComponent(deckId)}/ops`, { actor, ops: [...ops] }),
    getDeck: (deckId) => call('GET', `/internal/decks/${encodeURIComponent(deckId)}/json`),
  }
}

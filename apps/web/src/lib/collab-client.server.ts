// Typed client for the collab service's internal API (see apps/collab/src/internal-api.ts).
// Server-only: it carries COLLAB_INTERNAL_SECRET. Used by server functions in this app, and
// later by the AI assistant and MCP layers.
import type { Deck } from '@sleid/model'

export interface OpResult {
  ok: true
  id?: string
}

export interface OpFailure {
  opIndex: number
  opName: string
  reason: string
}

export interface RevalidateResult {
  connections: number
  downgraded: number
  upgraded: number
  closed: number
}

export class CollabInternalError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.name = 'CollabInternalError'
    this.status = status
    this.body = body
  }
}

export interface CollabInternalClient {
  /** Applies deck-ops as `server:<actor>`. Connected clients see the change live. All-or-nothing. */
  applyOps(deckId: string, actor: string, ops: readonly unknown[]): Promise<{ ok: true; results: OpResult[] }>
  /** The current deck, as the collab service sees it. */
  getDeck(deckId: string): Promise<Deck>
  /** Re-checks the roles of users connected to a deck and downgrades, upgrades or closes them. */
  revalidate(deckId: string): Promise<RevalidateResult>
}

export function createCollabInternalClient(options: { baseUrl: string; secret: string; fetch?: typeof fetch }): CollabInternalClient {
  const base = options.baseUrl.replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        'x-sleid-internal': options.secret,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const message = typeof (payload as { error?: unknown } | null)?.error === 'string' ? (payload as { error: string }).error : `collab internal API ${response.status}`
      throw new CollabInternalError(response.status, payload, message)
    }
    return payload as T
  }

  return {
    applyOps(deckId, actor, ops) {
      return call(`POST`, `/internal/decks/${encodeURIComponent(deckId)}/ops`, { actor, ops: [...ops] })
    },
    getDeck(deckId) {
      return call('GET', `/internal/decks/${encodeURIComponent(deckId)}/json`)
    },
    revalidate(deckId) {
      return call('POST', `/internal/decks/${encodeURIComponent(deckId)}/revalidate`)
    },
  }
}

/** The client configured from the environment: COLLAB_INTERNAL_URL (default localhost:3002) and COLLAB_INTERNAL_SECRET. */
export function getCollabInternalClient(): CollabInternalClient {
  const secret = process.env.COLLAB_INTERNAL_SECRET
  if (!secret) throw new Error('COLLAB_INTERNAL_SECRET is required (see .env.example)')
  const baseUrl = process.env.COLLAB_INTERNAL_URL ?? `http://127.0.0.1:${process.env.COLLAB_INTERNAL_PORT ?? '3002'}`
  return createCollabInternalClient({ baseUrl, secret })
}

/** The live-document source for exports and publishing, or undefined when the collab secret is not set (the database is then read). */
export function liveDeckSourceFromEnv(): { baseUrl: string; secret: string } | undefined {
  const secret = process.env.COLLAB_INTERNAL_SECRET
  if (!secret) return undefined
  return { baseUrl: process.env.COLLAB_INTERNAL_URL ?? `http://127.0.0.1:${process.env.COLLAB_INTERNAL_PORT ?? '3002'}`, secret }
}

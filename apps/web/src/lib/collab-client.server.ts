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
  /**
   * Applies deck-ops as `server:<actor>`. Connected clients see the change live. All-or-nothing.
   * `userId` is the person the change is for, when there is one (version checkpoints record the last editors).
   */
  applyOps(deckId: string, actor: string, ops: readonly unknown[], userId?: string): Promise<{ ok: true; results: OpResult[] }>
  /** The current deck, as the collab service sees it. */
  getDeck(deckId: string): Promise<Deck>
  /** Re-checks the roles of users connected to a deck and downgrades, upgrades or closes them. */
  revalidate(deckId: string): Promise<RevalidateResult>
  /** A named version of the live state. */
  snapshot(deckId: string, input: { userId: string; name: string }): Promise<{ id: string; createdAt: string }>
  /** Replaces the deck's content with `deck` (validated by the collab service), after keeping "Before restore". */
  restore(deckId: string, input: { userId: string; deck: Deck }): Promise<{ ok: true; beforeSnapshotId: string }>
  /** Sends a stateless message to everyone connected to the deck. */
  broadcast(deckId: string, payload: Record<string, unknown>): Promise<{ delivered: number }>
  /** A remote command for a presenter session (next, prev, first, last). */
  remoteCommand(deckId: string, sid: string, action: 'next' | 'prev' | 'first' | 'last'): Promise<{ delivered: number }>
  /** The last state the presenter reported on its remote channel, or null. */
  remoteState(deckId: string, sid: string): Promise<{ state: RemoteStateReport; ageMs: number } | { state: null; ageMs: null }>
}

export interface RemoteStateReport {
  slide: number
  total: number
  slideId: string
  notes: string
  title: string
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

  const path = (deckId: string, rest: string) => `/internal/decks/${encodeURIComponent(deckId)}/${rest}`

  return {
    applyOps(deckId, actor, ops, userId) {
      return call('POST', path(deckId, 'ops'), { actor, ops: [...ops], ...(userId ? { userId } : {}) })
    },
    getDeck(deckId) {
      return call('GET', path(deckId, 'json'))
    },
    revalidate(deckId) {
      return call('POST', path(deckId, 'revalidate'))
    },
    snapshot(deckId, input) {
      return call('POST', path(deckId, 'snapshot'), input)
    },
    restore(deckId, input) {
      return call('POST', path(deckId, 'restore'), { userId: input.userId, deck: input.deck })
    },
    broadcast(deckId, payload) {
      return call('POST', path(deckId, 'broadcast'), { payload })
    },
    remoteCommand(deckId, sid, action) {
      return call('POST', path(deckId, `remote/${encodeURIComponent(sid)}/command`), { action })
    },
    remoteState(deckId, sid) {
      return call('GET', path(deckId, `remote/${encodeURIComponent(sid)}/state`))
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

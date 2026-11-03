// The phone remote's server side: checks a remote token against its session row and the presenter's current role,
// rate-limits commands, and forwards them to the collab service. Written with injected dependencies so the handlers
// can be tested without the web server.
import { getDeckRole, getRemoteSession, verifyRemoteToken, RemoteTokenError, type Db } from '@sleid/db'
import type { FixedWindowLimiter } from '~/lib/mcp/rate-limit'
import type { getCollabInternalClient } from '~/lib/collab-client.server'

/** Commands per session per window. A person tapping Next a few times is far below this. */
export const COMMAND_LIMIT = { max: 20, windowMs: 10_000 }
/** A presenter that has not reported for this long is treated as not open. */
export const PRESENTER_STALE_MS = 10_000

export interface RemoteDeps {
  db: Db
  secret: string | undefined
  collab: Pick<ReturnType<typeof getCollabInternalClient>, 'remoteCommand' | 'remoteState'>
  limiter: FixedWindowLimiter
  now?: () => number
}

export type RemoteAccess = { ok: true; deckId: string; sid: string; userId: string } | { ok: false; status: number; error: string }

/** Checks the token, its session (not revoked, same deck) and the presenter's current role. */
export async function authorizeRemote(deps: RemoteDeps, token: string): Promise<RemoteAccess> {
  if (!deps.secret) return { ok: false, status: 503, error: 'The phone remote is not configured on this server.' }
  let claims
  try {
    claims = verifyRemoteToken(token, deps.secret, deps.now?.() ?? Date.now())
  } catch (err) {
    if (err instanceof RemoteTokenError && err.reason === 'expired') return { ok: false, status: 410, error: 'This remote has expired. Start a new one from the presenter view.' }
    return { ok: false, status: 401, error: 'This remote link is not valid.' }
  }
  const session = await getRemoteSession(deps.db, claims.sid)
  if (!session || session.deckId !== claims.deckId || session.userId !== claims.userId) {
    return { ok: false, status: 401, error: 'This remote link is not valid.' }
  }
  if (session.revokedAt) return { ok: false, status: 410, error: 'The presenter closed this remote.' }
  const role = await getDeckRole(deps.db, claims.userId, claims.deckId)
  if (!role) return { ok: false, status: 403, error: 'The presenter no longer has access to this deck.' }
  return { ok: true, deckId: claims.deckId, sid: claims.sid, userId: claims.userId }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers },
  })

/** GET: the presenter's last reported state (slide, notes) and whether the presenter window is open. */
export async function handleRemoteState(deps: RemoteDeps, token: string): Promise<Response> {
  const access = await authorizeRemote(deps, token)
  if (!access.ok) return json(access.status, { error: access.error })
  const reported = await deps.collab.remoteState(access.deckId, access.sid)
  if (!reported.state || reported.ageMs === null) return json(200, { presenterOnline: false, state: null })
  return json(200, { presenterOnline: reported.ageMs <= PRESENTER_STALE_MS, state: reported.state, ageMs: reported.ageMs })
}

const ACTIONS = new Set(['next', 'prev', 'first', 'last'])

/** POST { action }: a command for the presenter window. Rate limited per session. */
export async function handleRemoteCommand(deps: RemoteDeps, token: string, request: Request): Promise<Response> {
  const access = await authorizeRemote(deps, token)
  if (!access.ok) return json(access.status, { error: access.error })
  const limit = deps.limiter.take(access.sid, deps.now?.() ?? Date.now())
  if (!limit.ok) return json(429, { error: 'Too many commands. Wait a moment.' }, { 'retry-after': String(limit.retryAfterSeconds) })

  let action: unknown
  try {
    action = ((await request.json()) as { action?: unknown }).action
  } catch {
    return json(400, { error: 'Send { "action": "next" | "prev" }.' })
  }
  if (typeof action !== 'string' || !ACTIONS.has(action)) return json(400, { error: 'Send { "action": "next" | "prev" }.' })
  const result = await deps.collab.remoteCommand(access.deckId, access.sid, action as 'next' | 'prev' | 'first' | 'last')
  if (result.delivered === 0) return json(409, { error: 'The presenter window is not open.' })
  return json(200, { ok: true })
}

// Internal HTTP API for trusted callers on this machine (apps/web, later the AI and MCP
// layers). It runs on its own listener, bound to localhost by default, and every
// request must carry the shared secret in `x-sleid-internal`.
//
//   POST /internal/decks/:deckId/ops         body { actor, ops }  -> applyOps as "server:<actor>"
//   GET  /internal/decks/:deckId/json        -> the deck (yDocToDeck)
//   POST /internal/decks/:deckId/revalidate  -> re-check connected users' roles
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import { applyOps, DeckSchema, OpError, replaceDeckContent, yDocToDeck } from '@sleid/model'
import { canEdit, getDeckRole, loadDeckState, writeSnapshot, BEFORE_RESTORE_NAME, type Db } from '@sleid/db'
import { z } from 'zod'
import type { ConnectionContext, Logger } from './hooks.ts'
import type { RemoteStateStore } from './remote-state.ts'

const MAX_BODY_BYTES = 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OpsBody = z.object({
  actor: z.string().trim().min(1).max(100),
  ops: z.array(z.unknown()).min(1).max(500),
  /** The user the change is made for, when there is one (MCP calls). Used for version checkpoints. */
  userId: z.string().min(1).max(200).optional(),
})
const SnapshotBody = z.object({
  userId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
})
const RestoreBody = z.object({
  userId: z.string().min(1).max(200),
  deck: z.unknown(),
})
const BroadcastBody = z.object({ payload: z.record(z.string(), z.unknown()) })
const REMOTE_ACTIONS = ['next', 'prev', 'first', 'last'] as const
const CommandBody = z.object({ action: z.enum(REMOTE_ACTIONS) })
const MAX_BROADCAST_BYTES = 8 * 1024
const SID = /^[A-Za-z0-9_-]{16,64}$/
export const RESTORE_ORIGIN = 'server:restore'

export interface InternalApiOptions {
  hocuspocus: Hocuspocus
  db: Db
  internalSecret: string
  logger: Logger
  remoteStates: RemoteStateStore
}

/** A deck's state for a snapshot: the live document when someone has it open, otherwise the saved state. */
export async function snapshotState(hocuspocus: Hocuspocus, db: Db, deckId: string): Promise<Uint8Array> {
  const live = hocuspocus.documents.get(deckId)
  if (live) return Y.encodeStateAsUpdate(live)
  return loadDeckState(db, deckId)
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function secretMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false
  // Compare digests so the length of the secret does not leak through timing.
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('body must be JSON'), { status: 400 })
  }
}

export function createInternalHandler({ hocuspocus, db, internalSecret, logger, remoteStates }: InternalApiOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!secretMatches(req.headers['x-sleid-internal'], internalSecret)) return send(res, 401, { error: 'unauthorized' })

      const url = new URL(req.url ?? '/', 'http://internal')
      const remote = /^\/internal\/decks\/([^/]+)\/remote\/([^/]+)\/(command|state)$/.exec(url.pathname)
      if (remote) {
        const deckId = decodeURIComponent(remote[1]!)
        const sid = decodeURIComponent(remote[2]!)
        if (!UUID.test(deckId)) return send(res, 400, { error: 'deckId must be a uuid' })
        if (!SID.test(sid)) return send(res, 400, { error: 'session id is not valid' })
        if (remote[3] === 'command' && req.method === 'POST') return await handleCommand(req, res, deckId, sid)
        if (remote[3] === 'state' && req.method === 'GET') return send(res, 200, remoteStates.get(deckId, sid) ?? { state: null, ageMs: null })
        return send(res, 405, { error: 'method not allowed' })
      }

      const match = /^\/internal\/decks\/([^/]+)\/(ops|json|revalidate|snapshot|restore|broadcast)$/.exec(url.pathname)
      if (!match) return send(res, 404, { error: 'not found' })
      const deckId = decodeURIComponent(match[1]!)
      const action = match[2]!
      if (!UUID.test(deckId)) return send(res, 400, { error: 'deckId must be a uuid' })

      if (action === 'ops' && req.method === 'POST') return await handleOps(req, res, deckId)
      if (action === 'json' && req.method === 'GET') return await handleJson(res, deckId)
      if (action === 'revalidate' && req.method === 'POST') return await handleRevalidate(res, deckId)
      if (action === 'snapshot' && req.method === 'POST') return await handleSnapshot(req, res, deckId)
      if (action === 'restore' && req.method === 'POST') return await handleRestore(req, res, deckId)
      if (action === 'broadcast' && req.method === 'POST') return await handleBroadcast(req, res, deckId)
      return send(res, 405, { error: 'method not allowed' })
    } catch (err) {
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500
      if (status === 500) logger.error('[collab] internal request failed', err)
      send(res, status, { error: status === 500 ? 'internal error' : (err as Error).message })
    }
  }

  async function handleOps(req: IncomingMessage, res: ServerResponse, deckId: string) {
    const parsed = OpsBody.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'body must be { actor: string, ops: array }' })
    const { actor, ops, userId } = parsed.data

    let direct
    try {
      direct = await hocuspocus.openDirectConnection(deckId, { actor, userId })
    } catch {
      return send(res, 404, { error: 'Deck not found' })
    }
    try {
      const doc = direct.document
      if (!doc) throw new Error('document is not available')
      // Applied to the live document, so connected clients receive it through the normal broadcast.
      const { results } = applyOps(doc, ops, `server:${actor}`)
      return send(res, 200, { ok: true, results })
    } catch (err) {
      if (err instanceof OpError) {
        return send(res, 422, { ok: false, error: { opIndex: err.opIndex, opName: err.opName, reason: err.reason } })
      }
      throw err
    } finally {
      // Keep the document in memory until its store has run. An immediate unload would let the next request reload
      // the saved state from before this change, so an agent's read right after a write could be stale.
      await direct.disconnect({ unloadImmediately: false })
    }
  }

  async function handleJson(res: ServerResponse, deckId: string) {
    let direct
    try {
      direct = await hocuspocus.openDirectConnection(deckId, { actor: 'internal-read' })
    } catch {
      return send(res, 404, { error: 'Deck not found' })
    }
    try {
      if (!direct.document) throw new Error('document is not available')
      return send(res, 200, yDocToDeck(direct.document))
    } finally {
      await direct.disconnect({ unloadImmediately: false })
    }
  }

  /** After a role or link change: downgrade open connections in place, or close them if access is gone. */
  async function handleRevalidate(res: ServerResponse, deckId: string) {
    const document = hocuspocus.documents.get(deckId)
    if (!document) return send(res, 200, { connections: 0, downgraded: 0, upgraded: 0, closed: 0 })

    let downgraded = 0
    let upgraded = 0
    let closed = 0
    for (const connection of document.getConnections()) {
      const context = connection.context as Partial<ConnectionContext> | undefined
      if (!context?.userId) continue
      const role = await getDeckRole(db, context.userId, deckId)
      if (!role) {
        connection.close({ code: 4403, reason: 'access-revoked' })
        closed++
        continue
      }
      const readOnly = !canEdit(role)
      if (connection.readOnly !== readOnly) {
        if (readOnly) downgraded++
        else upgraded++
        connection.readOnly = readOnly
      }
      connection.context = { ...context, role }
    }
    return send(res, 200, { connections: document.getConnectionsCount(), downgraded, upgraded, closed })
  }

  /** Named version: the live state (including edits not yet saved), kept as a snapshot. */
  async function handleSnapshot(req: IncomingMessage, res: ServerResponse, deckId: string) {
    const parsed = SnapshotBody.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'body must be { userId: string, name: string }' })
    const state = await snapshotStateOrNotFound(res, deckId)
    if (!state) return
    const { id, createdAt } = await writeSnapshot(db, deckId, state, { kind: 'named', name: parsed.data.name, createdBy: parsed.data.userId, editors: [parsed.data.userId] })
    return send(res, 200, { id, createdAt: createdAt.toISOString() })
  }

  /**
   * Restore: the deck's content becomes the target, in one transaction on the live document, so connected clients
   * update at once. The current state is kept first as the named version "Before restore". The target is validated
   * before anything is written, so a bad target changes nothing.
   */
  async function handleRestore(req: IncomingMessage, res: ServerResponse, deckId: string) {
    const parsed = RestoreBody.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'body must be { userId: string, deck: object }' })
    const target = DeckSchema.safeParse({ ...(parsed.data.deck as object), id: deckId })
    if (!target.success) return send(res, 422, { error: `the version is not a valid deck: ${target.error.issues[0]?.message ?? 'invalid'}` })
    const userId = parsed.data.userId

    let direct
    try {
      direct = await hocuspocus.openDirectConnection(deckId, { actor: 'restore', userId })
    } catch {
      return send(res, 404, { error: 'Deck not found' })
    }
    try {
      const doc = direct.document
      if (!doc) throw new Error('document is not available')
      const before = await writeSnapshot(db, deckId, Y.encodeStateAsUpdate(doc), {
        kind: 'auto',
        name: BEFORE_RESTORE_NAME,
        createdBy: userId,
        editors: [userId],
      })
      replaceDeckContent(doc, target.data, RESTORE_ORIGIN)
      return send(res, 200, { ok: true, beforeSnapshotId: before.id })
    } finally {
      await direct.disconnect({ unloadImmediately: false })
    }
  }

  /** Sends a stateless message to everyone connected to the deck (comments, remote). Returns how many connections it reached. */
  async function handleBroadcast(req: IncomingMessage, res: ServerResponse, deckId: string) {
    const parsed = BroadcastBody.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'body must be { payload: object }' })
    const text = JSON.stringify(parsed.data.payload)
    if (Buffer.byteLength(text) > MAX_BROADCAST_BYTES) return send(res, 413, { error: 'payload is too large' })
    const doc = hocuspocus.documents.get(deckId)
    if (!doc) return send(res, 200, { delivered: 0 })
    doc.broadcastStateless(text)
    return send(res, 200, { delivered: doc.getConnectionsCount() })
  }

  /** A remote command from the phone (already checked by the web app): broadcast to the presenter window(s). */
  async function handleCommand(req: IncomingMessage, res: ServerResponse, deckId: string, sid: string) {
    const parsed = CommandBody.safeParse(await readJson(req))
    if (!parsed.success) return send(res, 400, { error: 'body must be { action: next | prev | first | last }' })
    const doc = hocuspocus.documents.get(deckId)
    if (!doc) return send(res, 200, { delivered: 0 })
    doc.broadcastStateless(JSON.stringify({ channel: `remote:${sid}`, type: 'command', action: parsed.data.action, at: Date.now() }))
    return send(res, 200, { delivered: doc.getConnectionsCount() })
  }

  async function snapshotStateOrNotFound(res: ServerResponse, deckId: string): Promise<Uint8Array | null> {
    try {
      return await snapshotState(hocuspocus, db, deckId)
    } catch (err) {
      if (err instanceof Error && err.message === 'Deck not found') {
        send(res, 404, { error: 'Deck not found' })
        return null
      }
      throw err
    }
  }
}

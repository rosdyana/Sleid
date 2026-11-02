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
import { applyOps, OpError, yDocToDeck } from '@sleid/model'
import { canEdit, getDeckRole, type Db } from '@sleid/db'
import { z } from 'zod'
import type { ConnectionContext, Logger } from './hooks.ts'

const MAX_BODY_BYTES = 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OpsBody = z.object({
  actor: z.string().trim().min(1).max(100),
  ops: z.array(z.unknown()).min(1).max(500),
})

export interface InternalApiOptions {
  hocuspocus: Hocuspocus
  db: Db
  internalSecret: string
  logger: Logger
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

export function createInternalHandler({ hocuspocus, db, internalSecret, logger }: InternalApiOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!secretMatches(req.headers['x-sleid-internal'], internalSecret)) return send(res, 401, { error: 'unauthorized' })

      const url = new URL(req.url ?? '/', 'http://internal')
      const match = /^\/internal\/decks\/([^/]+)\/(ops|json|revalidate)$/.exec(url.pathname)
      if (!match) return send(res, 404, { error: 'not found' })
      const deckId = decodeURIComponent(match[1]!)
      const action = match[2]!
      if (!UUID.test(deckId)) return send(res, 400, { error: 'deckId must be a uuid' })

      if (action === 'ops' && req.method === 'POST') return await handleOps(req, res, deckId)
      if (action === 'json' && req.method === 'GET') return await handleJson(res, deckId)
      if (action === 'revalidate' && req.method === 'POST') return await handleRevalidate(res, deckId)
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
    const { actor, ops } = parsed.data

    let direct
    try {
      direct = await hocuspocus.openDirectConnection(deckId, { actor })
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
      await direct.disconnect()
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
      await direct.disconnect()
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
}

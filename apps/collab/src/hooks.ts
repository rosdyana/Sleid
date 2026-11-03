// Hocuspocus hooks: authentication, document load, debounced store, and the
// write guard that runs before any client update is applied.
import * as Y from 'yjs'
import { yDocToDeck } from '@sleid/model'
import { z } from 'zod'
import { appendDeckUpdate, canEdit, CollabTokenError, loadDeckState, verifyCollabToken, type Db, getDeckRole } from '@sleid/db'
import type { RemoteStateStore } from './remote-state.ts'

export interface Logger {
  info(message: string): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/** The context stored on each authenticated connection. Read by the internal revalidate endpoint. */
export interface ConnectionContext {
  userId: string
  name: string
  image: string | null
  role: 'owner' | 'editor' | 'commenter' | 'viewer'
}

/** Error that Hocuspocus turns into a permission-denied reply carrying `reason`. */
export function deny(reason: string): Error & { reason: string } {
  return Object.assign(new Error(reason), { reason })
}

const DEFAULT_TITLE = 'Untitled presentation'
const LOAD_ORIGIN = 'load'
const EMPTY_STATE_VECTOR = Y.encodeStateVector(new Y.Doc())

/** Yjs message types that carry document content: SyncStep2 (1) and Update (2). */
const CONTENT_MESSAGE_TYPES = new Set([1, 2])

/** Largest stateless message accepted from a client. Presenter state is a few hundred bytes. */
const MAX_STATELESS_BYTES = 16 * 1024

/** A presenter's state report on its remote channel. Anything else a client sends on stateless is dropped. */
const RemoteStateMessage = z.object({
  channel: z.string().regex(/^remote:[A-Za-z0-9_-]{16,64}$/),
  type: z.literal('state'),
  slide: z.number().int().min(1).max(10000),
  total: z.number().int().min(1).max(10000),
  slideId: z.string().min(1).max(100),
  notes: z.string().max(5000),
  title: z.string().max(200),
})

export interface HooksOptions {
  db: Db
  tokenSecret: string
  logger: Logger
  /** Called for each edit by an authenticated user (drives the automatic checkpoints). */
  onEdit?: (deckId: string, userId: string) => void
  remoteStates: RemoteStateStore
}

/**
 * Creates the hook set for one server. The lastStored map is per server instance:
 * it holds, for each loaded document, the state vector that the database already has.
 */
export function createHooks({ db, tokenSecret, logger, onEdit, remoteStates }: HooksOptions) {
  const lastStored = new Map<string, Uint8Array>()

  return {
    async onAuthenticate({ token, documentName, connectionConfig }: { token: string; documentName: string; connectionConfig: { readOnly: boolean } }) {
      let claims
      try {
        claims = verifyCollabToken(token, tokenSecret, { deckId: documentName })
      } catch (err) {
        if (err instanceof CollabTokenError) throw deny(err.reason)
        throw err
      }
      // Re-check the role in the database. The token only proves who the user was when it was issued.
      const role = await getDeckRole(db, claims.userId, documentName)
      if (!role) throw deny('not-a-member')
      connectionConfig.readOnly = !canEdit(role)
      const context: ConnectionContext = { userId: claims.userId, name: claims.name, image: claims.image, role }
      return context
    },

    async onLoadDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
      const state = await loadDeckState(db, documentName)
      Y.applyUpdate(document, state, LOAD_ORIGIN)
      lastStored.set(documentName, Y.encodeStateVector(document))
    },

    /**
     * Appends the diff since the last store as one deck_updates row. Hocuspocus
     * debounces this hook (see createCollabServer). A deck that no longer parses is
     * logged loudly and still stored, so no edit is silently lost.
     */
    async onStoreDocument({ document, documentName }: { document: Y.Doc; documentName: string }) {
      const previous = lastStored.get(documentName) ?? EMPTY_STATE_VECTOR
      const stateVector = Y.encodeStateVector(document)
      if (Buffer.from(stateVector).equals(Buffer.from(previous))) return

      const update = Y.encodeStateAsUpdate(document, previous)
      const title = titleAfterStore(document, documentName, logger)
      lastStored.set(documentName, stateVector)
      try {
        await appendDeckUpdate(db, documentName, update, title)
      } catch (err) {
        lastStored.set(documentName, previous)
        throw err
      }
    },

    /**
     * Presence identity comes from the authenticated connection, not from the client. A client
     * can still choose its colour and cursor, but it cannot show itself as another user.
     */
    async beforeHandleAwareness({ states, context }: { states: Map<number, Record<string, unknown>>; context: ConnectionContext | undefined }) {
      if (!context) return
      for (const state of states.values()) {
        const user = state.user
        if (typeof user !== 'object' || user === null) continue
        state.user = { ...(user as Record<string, unknown>), id: context.userId, name: context.name }
      }
    },

    async afterUnloadDocument({ documentName }: { documentName: string }) {
      lastStored.delete(documentName)
    },

    /**
     * Every document change. Only changes with an authenticated user count as edits. A load has no user on it,
     * so opening a deck does not start a checkpoint.
     */
    async onChange({ update, documentName, context }: { update: Uint8Array; documentName: string; context: ConnectionContext | undefined }) {
      if (update.byteLength === 0 || !context?.userId) return
      onEdit?.(documentName, context.userId)
    },

    /**
     * Presenter state for the phone remote and for followers. The state is kept for the phone to poll, and sent to
     * everyone on the deck so followers can keep up. Other stateless messages from clients are dropped: commands
     * come only from the web app, through the internal API.
     */
    async onStateless({ payload, documentName, document }: { payload: string; documentName: string; document: Y.Doc & { broadcastStateless(p: string): void } }) {
      if (payload.length > MAX_STATELESS_BYTES) return
      let raw: unknown
      try {
        raw = JSON.parse(payload)
      } catch {
        return
      }
      const parsed = RemoteStateMessage.safeParse(raw)
      if (!parsed.success) return
      const { channel, slide, total, slideId, notes, title } = parsed.data
      remoteStates.set(documentName, channel.slice('remote:'.length), { slide, total, slideId, notes, title })
      document.broadcastStateless(payload)
    },

    /**
     * Runs before a client's SyncStep2 or Update is applied. The update is applied to
     * a scratch copy, and it is refused (connection closed) unless the result still
     * parses as a deck. Read-only connections are skipped: their writes are dropped
     * by Hocuspocus anyway.
     */
    async beforeSync({ connection, type, payload, document, documentName }: { connection: { readOnly: boolean }; type: number; payload: Uint8Array; document: Y.Doc; documentName: string }) {
      if (connection.readOnly || !CONTENT_MESSAGE_TYPES.has(type)) return
      const scratch = new Y.Doc()
      try {
        Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document))
        Y.applyUpdate(scratch, payload)
        yDocToDeck(scratch)
      } catch (err) {
        logger.warn(`[collab] refused an update to deck ${documentName}: it does not produce a valid deck`, err)
        throw deny('invalid-update')
      } finally {
        scratch.destroy()
      }
    },
  }
}

function titleAfterStore(document: Y.Doc, documentName: string, logger: Logger): string {
  const raw = document.getMap('deck').get('title')
  try {
    return yDocToDeck(document).title.slice(0, 200)
  } catch (err) {
    logger.error(`[collab] deck ${documentName} does not parse after a store; the update is stored anyway so no edit is lost`, err)
    return typeof raw === 'string' && raw.trim() ? raw.slice(0, 200) : DEFAULT_TITLE
  }
}

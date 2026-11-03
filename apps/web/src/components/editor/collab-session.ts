// Client side of one open deck. The Y.Doc syncs through the collab service (Hocuspocus).
// This class owns the provider, local-origin undo, sync status and presence (awareness).
//
// Origins: local edits are applied with origin LOCAL_ORIGIN. Remote updates arrive with the
// provider as origin, so Y.UndoManager (which tracks LOCAL_ORIGIN only) never undoes a collaborator's edit.
import { useCallback, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import { applyOps, createUndoManager, yDocToDeck, type Deck } from '@sleid/model'

export const LOCAL_ORIGIN = 'local'
/**
 * The collab WebSocket. VITE_COLLAB_URL wins when set at build time. Otherwise dev uses ws://localhost:3001,
 * and a production build uses /collab on the page's own origin (a reverse proxy routes it to apps/collab),
 * so one container image works on any domain.
 */
export const COLLAB_URL: string = resolveCollabUrl()

function resolveCollabUrl(): string {
  const configured = import.meta.env.VITE_COLLAB_URL?.trim()
  if (configured) return configured
  if (import.meta.env.DEV || typeof window === 'undefined') return 'ws://localhost:3001'
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/collab`
}
/** Cursor updates are sent at most this often (20 Hz). */
export const CURSOR_INTERVAL_MS = 50

export type SyncStatus =
  | { kind: 'connecting' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'offline' }
  | { kind: 'denied'; reason: string }

export interface PresenceUser {
  id: string
  name: string
  image: string | null
}

export interface PresencePeer {
  clientId: number
  userId: string
  name: string
  color: string
  slideId: string | null
  selection: string[]
  cursor: { x: number; y: number } | null
}

const PALETTE = ['#1a73e8', '#d93025', '#188038', '#e37400', '#a142f4', '#12b5cb', '#c5221f', '#7c4dff']

/** A stable colour per user, so the same person looks the same to everyone. */
export function colorFor(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]!
}

const DENIED_TEXT: Record<string, string> = {
  'not-a-member': 'You no longer have access to this deck.',
  expired: 'Your session expired. Reload the page.',
  'wrong-deck': 'This connection is for a different deck. Reload the page.',
  'bad-signature': 'Could not verify your access. Reload the page.',
  'invalid-token': 'Could not verify your access. Reload the page.',
  'access-revoked': 'Your access to this deck was removed.',
}

export function deniedMessage(reason: string): string {
  return DENIED_TEXT[reason] ?? 'The server refused this connection.'
}

export interface CollabSessionOptions {
  deckId: string
  user: PresenceUser
  readOnly: boolean
  /** Returns a fresh collab token. Called on every (re)connect. */
  fetchToken: () => Promise<string>
  url?: string
}

export class CollabSession {
  readonly doc = new Y.Doc()
  readonly awareness: Awareness
  readonly provider: HocuspocusProvider
  readonly undoManager: Y.UndoManager
  readonly readOnly: boolean
  readonly user: PresenceUser
  readonly color: string

  private socketStatus: 'connecting' | 'connected' | 'disconnected' = 'connecting'
  private hasSynced = false
  private status: SyncStatus = { kind: 'connecting' }
  private statusListeners = new Set<() => void>()
  private statelessListeners = new Set<(payload: string) => void>()
  private peers: PresencePeer[] = []
  private peerListeners = new Set<() => void>()
  private cursorTimer: ReturnType<typeof setTimeout> | undefined
  private cursorPending: { x: number; y: number } | null | undefined
  private lastCursorAt = 0
  private destroyed = false

  constructor(options: CollabSessionOptions) {
    this.readOnly = options.readOnly
    this.user = options.user
    this.color = colorFor(options.user.id)

    this.awareness = new Awareness(this.doc)
    this.awareness.setLocalStateField('user', { id: options.user.id, name: options.user.name, color: this.color })
    this.undoManager = createUndoManager(this.doc, [LOCAL_ORIGIN], { captureTimeout: 0 })

    this.provider = new HocuspocusProvider({
      url: options.url ?? COLLAB_URL,
      name: options.deckId,
      document: this.doc,
      awareness: this.awareness,
      token: () => options.fetchToken(),
      onStatus: ({ status }) => {
        this.socketStatus = status
        this.refreshStatus()
      },
      onSynced: () => {
        this.hasSynced = true
        this.notifyStatus()
        this.refreshStatus()
      },
      onUnsyncedChanges: () => this.refreshStatus(),
      onAuthenticationFailed: ({ reason }) => this.setStatus({ kind: 'denied', reason }),
      onStateless: ({ payload }: { payload: string }) => {
        for (const listener of this.statelessListeners) listener(payload)
      },
    })
    this.awareness.on('change', this.onAwarenessChange)
    this.refreshPeers()
    // The provider only notices a dead socket after its message timeout (about 30 s), so the
    // browser's online/offline events drive the status. On "online" the socket is reset, which
    // re-authenticates and runs the sync handshake; local changes made offline are sent then.
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.onBrowserOffline)
      window.addEventListener('online', this.onBrowserOnline)
    }
  }

  private onBrowserOffline = () => {
    this.socketStatus = 'disconnected'
    this.refreshStatus()
  }

  private onBrowserOnline = () => {
    if (this.destroyed) return
    const socket = this.provider.configuration.websocketProvider
    // The old socket may look open while it is dead, and its close event can take a long time.
    // Detach it, mark it disconnected (so connect() does not return early), and reconnect now.
    socket.cleanupWebSocket()
    socket.status = WebSocketStatus.Disconnected
    socket.shouldConnect = true
    socket.connect().catch(() => undefined)
  }

  /** Applies a batch of deck-ops locally; the provider sends it to the server. Throws OpError for an invalid batch. */
  apply(ops: readonly unknown[]) {
    if (this.readOnly) throw new Error('View only: changes are turned off for this deck')
    return applyOps(this.doc, ops, LOCAL_ORIGIN)
  }

  undo() {
    this.undoManager.undo()
  }

  redo() {
    this.undoManager.redo()
  }

  canUndo() {
    return this.undoManager.canUndo()
  }

  canRedo() {
    return this.undoManager.canRedo()
  }

  /** True until the server has confirmed every local change. */
  hasUnsavedChanges(): boolean {
    return this.provider.hasUnsyncedChanges
  }

  isReady(): boolean {
    return this.hasSynced
  }

  getStatus(): SyncStatus {
    return this.status
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Messages the server broadcasts to the deck (comment changes). The payload is the JSON text the sender wrote. */
  subscribeStateless(listener: (payload: string) => void): () => void {
    this.statelessListeners.add(listener)
    return () => this.statelessListeners.delete(listener)
  }

  getPeers(): PresencePeer[] {
    return this.peers
  }

  subscribePeers(listener: () => void): () => void {
    this.peerListeners.add(listener)
    return () => this.peerListeners.delete(listener)
  }

  /** The slide and selection this user is looking at. Sent at once; these change rarely. */
  setPresence(fields: { slideId?: string | null; selection?: string[] }) {
    if (this.destroyed) return
    if (fields.slideId !== undefined) this.awareness.setLocalStateField('slideId', fields.slideId)
    if (fields.selection !== undefined) this.awareness.setLocalStateField('selection', fields.selection)
  }

  /** Cursor position in slide coordinates, or null when the pointer leaves the canvas. Throttled to 20 Hz. */
  setCursor(point: { x: number; y: number } | null) {
    if (this.destroyed) return
    if (point === null) {
      this.clearCursorTimer()
      this.cursorPending = undefined
      this.awareness.setLocalStateField('cursor', null)
      return
    }
    this.cursorPending = point
    const wait = CURSOR_INTERVAL_MS - (Date.now() - this.lastCursorAt)
    if (wait <= 0) this.flushCursor()
    else if (this.cursorTimer === undefined) this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined
      this.flushCursor()
    }, wait)
  }

  private flushCursor() {
    this.lastCursorAt = Date.now()
    if (this.cursorPending === undefined || this.destroyed) return
    this.awareness.setLocalStateField('cursor', this.cursorPending)
    this.cursorPending = undefined
  }

  private clearCursorTimer() {
    if (this.cursorTimer !== undefined) clearTimeout(this.cursorTimer)
    this.cursorTimer = undefined
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.onBrowserOffline)
      window.removeEventListener('online', this.onBrowserOnline)
    }
    this.clearCursorTimer()
    this.provider.destroy()
    this.awareness.destroy()
    this.doc.destroy()
  }

  private onAwarenessChange = () => this.refreshPeers()

  private refreshPeers() {
    const self = this.awareness.clientID
    const next: PresencePeer[] = []
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return
      const user = state.user as { id?: unknown; name?: unknown; color?: unknown } | undefined
      if (!user || typeof user.id !== 'string') return
      next.push({
        clientId,
        userId: user.id,
        name: typeof user.name === 'string' ? user.name : 'Someone',
        color: typeof user.color === 'string' ? user.color : colorFor(user.id),
        slideId: typeof state.slideId === 'string' ? state.slideId : null,
        selection: Array.isArray(state.selection) ? state.selection.filter((id): id is string => typeof id === 'string') : [],
        cursor: isPoint(state.cursor) ? state.cursor : null,
      })
    })
    this.peers = next
    for (const listener of this.peerListeners) listener()
  }

  private refreshStatus() {
    if (this.status.kind === 'denied') return
    let next: SyncStatus
    if (this.socketStatus === 'disconnected') next = { kind: 'offline' }
    else if (this.socketStatus === 'connecting' || !this.provider.isSynced) next = { kind: 'connecting' }
    else if (this.provider.hasUnsyncedChanges) next = { kind: 'saving' }
    else next = { kind: 'saved' }
    this.setStatus(next)
  }

  private setStatus(next: SyncStatus) {
    const same = next.kind === this.status.kind && (next.kind !== 'denied' || (this.status.kind === 'denied' && this.status.reason === next.reason))
    if (same) return
    this.status = next
    this.notifyStatus()
  }

  private notifyStatus() {
    for (const listener of this.statusListeners) listener()
  }
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return typeof value === 'object' && value !== null && typeof (value as { x?: unknown }).x === 'number' && typeof (value as { y?: unknown }).y === 'number'
}

/** The session's sync status, re-rendering on change. */
export function useSyncStatus(session: CollabSession): SyncStatus {
  const subscribe = useCallback((cb: () => void) => session.subscribeStatus(cb), [session])
  const get = useCallback(() => session.getStatus(), [session])
  return useSyncExternalStore(subscribe, get, get)
}

/** Remote collaborators, re-rendering on awareness change. */
export function usePeers(session: CollabSession): PresencePeer[] {
  const subscribe = useCallback((cb: () => void) => session.subscribePeers(cb), [session])
  const get = useCallback(() => session.getPeers(), [session])
  return useSyncExternalStore(subscribe, get, get)
}

/** Undo and redo availability, re-rendering on change. */
export function useUndoState(session: CollabSession): { canUndo: boolean; canRedo: boolean } {
  const subscribe = useCallback(
    (cb: () => void) => {
      const um = session.undoManager
      um.on('stack-item-added', cb)
      um.on('stack-item-popped', cb)
      return () => {
        um.off('stack-item-added', cb)
        um.off('stack-item-popped', cb)
      }
    },
    [session],
  )
  const canUndo = useSyncExternalStore(subscribe, () => session.canUndo(), () => session.canUndo())
  const canRedo = useSyncExternalStore(subscribe, () => session.canRedo(), () => session.canRedo())
  return { canUndo, canRedo }
}

/** Becomes true after the first sync with the server. The document is empty before that. */
export function useReady(session: CollabSession): boolean {
  const subscribe = useCallback((cb: () => void) => session.subscribeStatus(cb), [session])
  const get = useCallback(() => session.isReady(), [session])
  return useSyncExternalStore(subscribe, get, get)
}

const deckCache = new WeakMap<Y.Doc, Deck>()
const invalidatorAttached = new WeakSet<Y.Doc>()

function cachedDeck(doc: Y.Doc): Deck {
  if (!invalidatorAttached.has(doc)) {
    invalidatorAttached.add(doc)
    doc.on('update', () => deckCache.delete(doc))
  }
  let deck = deckCache.get(doc)
  if (!deck) {
    deck = yDocToDeck(doc)
    deckCache.set(doc, deck)
  }
  return deck
}

/** The doc as a plain Deck. Re-renders on every doc update. Only call after the first sync. */
export function useDeck(doc: Y.Doc): Deck {
  const subscribe = useCallback(
    (cb: () => void) => {
      doc.on('update', cb)
      return () => {
        doc.off('update', cb)
      }
    },
    [doc],
  )
  const get = useCallback(() => cachedDeck(doc), [doc])
  return useSyncExternalStore(subscribe, get, get)
}

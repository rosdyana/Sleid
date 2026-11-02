// Client side of one open deck: the Y.Doc, the debounced push queue, the undo
// manager and the React hook that reads the doc as a plain Deck.
//
// Every local change goes through applyOps(doc, ops, 'local'). Updates from
// the doc with origin 'local' (or from undo, whose origin is the undo manager)
// are queued and pushed as one merged update, 500 ms after the last change.
// Updates applied from the server carry origin 'remote' and are not pushed.
import { useCallback, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { applyOps, createUndoManager, yDocToDeck, type Deck } from '@sleid/model'

export type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'error'; message: string }
export type PushFn = (update: Uint8Array) => Promise<void>

const RETRY_MS = 3000

export class DocSession {
  readonly doc: Y.Doc
  readonly undoManager: Y.UndoManager
  private pending: Uint8Array[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private busy = false
  private save: SaveState = { kind: 'saved' }
  private saveListeners = new Set<() => void>()

  constructor(
    state: Uint8Array,
    private readonly push: PushFn,
    private readonly debounceMs = 500,
  ) {
    this.doc = new Y.Doc()
    Y.applyUpdate(this.doc, state, 'remote')
    this.undoManager = createUndoManager(this.doc, ['local'], { captureTimeout: 0 })
    this.doc.on('update', this.onUpdate)
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return
    this.pending.push(update)
    this.setSave({ kind: 'saving' })
    this.schedule(this.debounceMs)
  }

  /** Runs a batch of deck-ops as one undo step. Throws OpError when the batch is invalid; the doc is then unchanged. */
  apply(ops: readonly unknown[]) {
    return applyOps(this.doc, ops, 'local')
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

  isDirty() {
    return this.pending.length > 0 || this.busy
  }

  getSave(): SaveState {
    return this.save
  }

  subscribeSave(listener: () => void): () => void {
    this.saveListeners.add(listener)
    return () => this.saveListeners.delete(listener)
  }

  subscribeUndo(listener: () => void): () => void {
    const um = this.undoManager
    um.on('stack-item-added', listener)
    um.on('stack-item-popped', listener)
    return () => {
      um.off('stack-item-added', listener)
      um.off('stack-item-popped', listener)
    }
  }

  /** Pushes everything queued now. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.busy || this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch)
    this.busy = true
    try {
      await this.push(merged)
      this.busy = false
      if (this.pending.length > 0) this.schedule(0)
      else this.setSave({ kind: 'saved' })
    } catch (err) {
      this.busy = false
      this.pending = [merged, ...this.pending]
      this.setSave({ kind: 'error', message: err instanceof Error ? err.message : 'Save failed' })
      this.schedule(RETRY_MS)
    }
  }

  private schedule(ms: number) {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, ms)
  }

  private setSave(next: SaveState) {
    const same = next.kind === this.save.kind && (next.kind !== 'error' || this.save.kind !== 'error' || next.message === this.save.message)
    if (same) return
    this.save = next
    for (const listener of this.saveListeners) listener()
  }
}

export function useSaveState(session: DocSession): SaveState {
  const subscribe = useCallback((cb: () => void) => session.subscribeSave(cb), [session])
  const get = useCallback(() => session.getSave(), [session])
  return useSyncExternalStore(subscribe, get, get)
}

export function useUndoState(session: DocSession): { canUndo: boolean; canRedo: boolean } {
  const subscribe = useCallback((cb: () => void) => session.subscribeUndo(cb), [session])
  const get = useCallback(() => session.canUndo(), [session])
  const getRedo = useCallback(() => session.canRedo(), [session])
  const canUndo = useSyncExternalStore(subscribe, get, get)
  const canRedo = useSyncExternalStore(subscribe, getRedo, getRedo)
  return { canUndo, canRedo }
}

// One parsed Deck per doc state. The cache is invalidated by a listener that is
// attached before React's subscription, so React never sees a stale value.
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

/** The doc as a plain Deck. Re-renders on every doc update. */
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

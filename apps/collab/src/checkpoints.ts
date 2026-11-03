// Automatic version checkpoints. A checkpoint is written when a document has had edits and then either
//   - 2 minutes pass with no further edit (the idle timer, restarted by every edit), or
//   - 10 minutes pass since the first unsaved edit (the max timer), so continuous editing still gets checkpoints.
// Each checkpoint clears both timers. The next edit starts them again. Editors are the distinct authenticated
// users who edited since the last checkpoint, most recent first (see EDITORS_KEPT in @sleid/db).
//
// The timers are injected so the timing can be tested with a fake clock.

export const IDLE_CHECKPOINT_MS = 2 * 60 * 1000
export const MAX_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000
const MAX_EDITORS = 5

export interface CheckpointTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface CheckpointScheduler {
  /** Call for each edit by an authenticated user. */
  noteEdit(deckId: string, userId: string): void
  /** Number of decks with an edit waiting for a checkpoint. */
  pending(): number
  /** Clears every timer. A checkpoint still pending is not written. */
  dispose(): void
}

interface DeckState {
  editors: string[]
  idle: unknown
  max: unknown
}

export function createCheckpointScheduler(options: {
  onCheckpoint: (deckId: string, editors: string[]) => Promise<void>
  onError?: (deckId: string, err: unknown) => void
  idleMs?: number
  maxIntervalMs?: number
  timers?: CheckpointTimers
}): CheckpointScheduler {
  const idleMs = options.idleMs ?? IDLE_CHECKPOINT_MS
  const maxIntervalMs = options.maxIntervalMs ?? MAX_CHECKPOINT_INTERVAL_MS
  const timers: CheckpointTimers = options.timers ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const decks = new Map<string, DeckState>()
  let disposed = false

  function clear(state: DeckState) {
    timers.clearTimeout(state.idle)
    timers.clearTimeout(state.max)
    state.idle = undefined
    state.max = undefined
  }

  async function fire(deckId: string) {
    const state = decks.get(deckId)
    if (!state) return
    clear(state)
    const editors = state.editors
    decks.delete(deckId)
    if (disposed) return
    try {
      await options.onCheckpoint(deckId, editors)
    } catch (err) {
      options.onError?.(deckId, err)
    }
  }

  return {
    noteEdit(deckId, userId) {
      if (disposed) return
      let state = decks.get(deckId)
      if (!state) {
        state = { editors: [], idle: undefined, max: undefined }
        decks.set(deckId, state)
        state.max = timers.setTimeout(() => void fire(deckId), maxIntervalMs)
      }
      state.editors = [userId, ...state.editors.filter((id) => id !== userId)].slice(0, MAX_EDITORS)
      timers.clearTimeout(state.idle)
      state.idle = timers.setTimeout(() => void fire(deckId), idleMs)
    },
    pending() {
      return decks.size
    },
    dispose() {
      disposed = true
      for (const state of decks.values()) clear(state)
      decks.clear()
    },
  }
}

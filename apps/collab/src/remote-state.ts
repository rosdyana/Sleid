// The last state each presenter reported on its remote channel (slide, total, notes), kept in memory so the
// phone can poll it. Entries older than the TTL are dropped. One collab process holds them, like the other
// per-process state in this service: a restart clears them, and the presenter sends a new one on its next change.

export interface RemoteState {
  slide: number
  total: number
  slideId: string
  notes: string
  title: string
}

export interface RemoteStateEntry {
  state: RemoteState
  at: number
}

export class RemoteStateStore {
  private readonly entries = new Map<string, RemoteStateEntry>()

  private readonly ttlMs: number
  private readonly now: () => number

  constructor(ttlMs = 2 * 60 * 60 * 1000, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs
    this.now = now
  }

  private key(deckId: string, sid: string) {
    return `${deckId}|${sid}`
  }

  set(deckId: string, sid: string, state: RemoteState): void {
    this.prune()
    this.entries.set(this.key(deckId, sid), { state, at: this.now() })
  }

  /** The last state and how old it is, or null. */
  get(deckId: string, sid: string): { state: RemoteState; ageMs: number } | null {
    const entry = this.entries.get(this.key(deckId, sid))
    if (!entry) return null
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(this.key(deckId, sid))
      return null
    }
    return { state: entry.state, ageMs: this.now() - entry.at }
  }

  size(): number {
    return this.entries.size
  }

  private prune() {
    if (this.entries.size < 1000) return
    const cutoff = this.now() - this.ttlMs
    for (const [key, entry] of this.entries) if (entry.at < cutoff) this.entries.delete(key)
  }
}

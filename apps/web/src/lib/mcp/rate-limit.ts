/**
 * Fixed-window counter per key (a token id, here). In memory, so it holds for one web process: a
 * deployment with several processes gets this limit per process. That is noted in the README.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, now: number = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (this.hits.size > 10_000) this.prune(now)
    let entry = this.hits.get(key)
    if (!entry || now - entry.start >= this.windowMs) {
      entry = { start: now, count: 0 }
      this.hits.set(key, entry)
    }
    if (entry.count >= this.max) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.start + this.windowMs - now) / 1000)) }
    }
    entry.count++
    return { ok: true }
  }

  private prune(now: number) {
    for (const [key, entry] of this.hits) {
      if (now - entry.start >= this.windowMs) this.hits.delete(key)
    }
  }
}

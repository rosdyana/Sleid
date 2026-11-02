// Retries with backoff on rate limits (429) and server errors (5xx). Other errors
// (auth, bad request, network, timeout, abort, invalid output) are not retried.
import { isLlmError, LlmError } from './errors.ts'

export interface RetryOptions {
  /** Retries after the first attempt. Default 2, so at most three requests. */
  maxRetries?: number
  /** Backoff base. Default 500 ms, doubled per attempt, plus jitter. */
  baseDelayMs?: number
  /** Upper bound for one wait. Default 8 s. */
  maxDelayMs?: number
  /** Injectable for tests. Must reject with an `aborted` LlmError when the signal fires. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmError('aborted', 'The request was cancelled.'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LlmError('aborted', 'The request was cancelled.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isRetryable(err: unknown): boolean {
  return isLlmError(err) && (err.kind === 'rate-limit' || err.kind === 'server')
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions & { signal?: AbortSignal } = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 2
  const base = options.baseDelayMs ?? 500
  const cap = options.maxDelayMs ?? 8000
  const sleep = options.sleep ?? sleepMs
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries || options.signal?.aborted) throw err
      const wanted = isLlmError(err) && err.retryAfterMs !== undefined ? err.retryAfterMs : base * 2 ** attempt + Math.random() * base
      await sleep(Math.min(wanted, cap), options.signal)
    }
  }
}

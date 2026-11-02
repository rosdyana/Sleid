// Typed errors. Messages never contain API keys: callers pass the secrets they hold to
// redact(), and every adapter runs its upstream messages through it.

export type LlmErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'bad-request'
  | 'network'
  | 'timeout'
  | 'server'
  | 'invalid-output'
  | 'aborted'
  | 'not-configured'

export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly status: number | undefined
  /** Milliseconds the server asked us to wait (Retry-After), when given. */
  readonly retryAfterMs: number | undefined
  readonly issues: string[] | undefined

  constructor(
    kind: LlmErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; issues?: string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.kind = kind
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
    this.issues = options.issues
  }
}

export function isLlmError(err: unknown): err is LlmError {
  return err instanceof LlmError
}

/** Removes every occurrence of each secret from a message. Empty secrets are ignored. */
export function redact(message: string, secrets: readonly (string | undefined | null)[]): string {
  let out = message
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]')
  }
  return out
}

/** Maps an HTTP status to an error kind. */
export function kindForStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 408) return 'timeout'
  if (status >= 500) return 'server'
  return 'bad-request'
}

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return undefined
}

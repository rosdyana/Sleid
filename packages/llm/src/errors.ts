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

const STATUS_TEXT: Record<number, string> = {
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

/** "HTTP 401 Unauthorized". The status text only, never anything from the response body. */
export function httpStatusLabel(status: number): string {
  const text = STATUS_TEXT[status]
  return text ? `HTTP ${status} ${text}` : `HTTP ${status}`
}

/**
 * The message a user sees for a failure in a user-owned provider. It carries the status and the kind, never the
 * upstream body, and never the network detail that would reveal which internal ports answered. The full message
 * belongs in the server log. Errors raised by our own checks (no status, not a network kind) keep their text.
 */
export function publicMessage(err: unknown): string {
  if (!(err instanceof LlmError)) return 'The assistant request failed.'
  if (err.status !== undefined) {
    const label = httpStatusLabel(err.status)
    if (err.kind === 'auth') return `The provider answered ${label}. Check the API key.`
    if (err.kind === 'rate-limit') return `The provider answered ${label}. Try again shortly.`
    return `The provider answered ${label}.`
  }
  switch (err.kind) {
    case 'network':
      return 'Could not reach the provider. Check the endpoint.'
    case 'timeout':
      return 'The provider did not answer in time.'
    case 'aborted':
      return 'The request was cancelled.'
    case 'server':
      return 'The provider failed to answer.'
    case 'invalid-output':
      return 'The provider replied in a form the assistant could not read.'
    default:
      return err.message
  }
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

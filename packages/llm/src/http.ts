// Plain-fetch helper for the OpenAI-shaped adapters. Maps every failure to an LlmError.
import { kindForStatus, LlmError, parseRetryAfter, redact } from './errors.ts'

export interface HttpContext {
  fetch?: typeof fetch
  timeoutMs: number
  signal?: AbortSignal
  /** Secrets to remove from any message that could reach a log or the UI. */
  secrets: readonly string[]
  /** Provider name for messages, e.g. "Azure OpenAI". */
  label: string
}

/** Combines the request timeout with the caller's signal. */
export function requestSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return caller ? AbortSignal.any([timeout, caller]) : timeout
}

/** Reads the error text from an OpenAI-style or plain error body, truncated. */
export async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown }
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
    if (typeof message === 'string') return message.slice(0, 300)
  } catch {
    // not JSON: fall through
  }
  return text.slice(0, 300)
}

/** POSTs JSON. Non-2xx responses throw an LlmError. The response body is left unread on success. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, ctx: HttpContext): Promise<Response> {
  const doFetch = ctx.fetch ?? fetch
  const signal = requestSignal(ctx.timeoutMs, ctx.signal)
  let response: Response
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw mapFetchError(err, ctx)
  }
  if (response.ok) return response
  const detail = redact(await errorDetail(response), ctx.secrets)
  const status = response.status
  const kind = kindForStatus(status)
  const hint =
    kind === 'auth'
      ? ' Check the API key and that the key is allowed for this resource.'
      : kind === 'rate-limit'
        ? ' The provider is rate limiting requests. Wait a moment and try again.'
        : ''
  throw new LlmError(kind, `${ctx.label} answered HTTP ${status}${detail ? `: ${detail}` : ''}.${hint}`, {
    status,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  })
}

/** Maps a fetch rejection (timeout, cancel, connection refused) to an LlmError. */
export function mapFetchError(err: unknown, ctx: HttpContext): LlmError {
  if (err instanceof LlmError) return err
  const name = err instanceof Error ? err.name : ''
  if (ctx.signal?.aborted || name === 'AbortError') return new LlmError('aborted', 'The request was cancelled.', { cause: err })
  if (name === 'TimeoutError') return new LlmError('timeout', `${ctx.label} did not answer within ${Math.round(ctx.timeoutMs / 1000)} seconds.`, { cause: err })
  const message = err instanceof Error ? redact(err.message, ctx.secrets) : 'unknown error'
  return new LlmError('network', `Could not reach ${ctx.label} (${message}). Check the endpoint and your network.`, { cause: err })
}

import { describe, expect, it } from 'vitest'
import { httpStatusLabel, LlmError, publicMessage } from './errors.ts'

describe('publicMessage (what a user sees for a user-owned provider)', () => {
  it('shows the status and the kind, and never the upstream body', () => {
    const body = 'invalid key sk-leak-1234 and the internal host 10.0.0.9'
    const auth = new LlmError('auth', `The local model server answered HTTP 401: ${body}.`, { status: 401 })
    expect(publicMessage(auth)).toBe('The provider answered HTTP 401 Unauthorized. Check the API key.')
    expect(publicMessage(new LlmError('server', `answered HTTP 503: ${body}`, { status: 503 }))).toBe('The provider answered HTTP 503 Service Unavailable.')
    expect(publicMessage(new LlmError('rate-limit', `answered HTTP 429: ${body}`, { status: 429 }))).toBe('The provider answered HTTP 429 Too Many Requests. Try again shortly.')
    expect(publicMessage(new LlmError('bad-request', `answered with a redirect (HTTP 302): ${body}`, { status: 302 }))).toBe('The provider answered HTTP 302 Found.')
  })

  it('gives network failures a fixed message, so the error does not reveal which ports answered', () => {
    expect(publicMessage(new LlmError('network', 'Could not reach the local model server (connect ECONNREFUSED 127.0.0.1:3002). Check the endpoint.'))).toBe(
      'Could not reach the provider. Check the endpoint.',
    )
    expect(publicMessage(new LlmError('timeout', 'The local model server did not answer within 300 seconds.'))).toBe('The provider did not answer in time.')
  })

  it('keeps the messages of our own checks, which carry no upstream text', () => {
    expect(publicMessage(new LlmError('auth', 'Only an administrator can change workspace providers.'))).toBe('Only an administrator can change workspace providers.')
    expect(publicMessage(new LlmError('rate-limit', 'You have used the assistant 30 times in the last 10 minutes.'))).toMatch(/used the assistant/)
    expect(publicMessage(new LlmError('not-configured', 'LLM_SECRET_KEY is not set.'))).toBe('LLM_SECRET_KEY is not set.')
  })

  it('a non-LlmError gets a generic message', () => {
    expect(publicMessage(new TypeError('cannot read properties of undefined'))).toBe('The assistant request failed.')
  })

  it('labels statuses with their text, and falls back to the number', () => {
    expect(httpStatusLabel(401)).toBe('HTTP 401 Unauthorized')
    expect(httpStatusLabel(418)).toBe('HTTP 418')
  })
})

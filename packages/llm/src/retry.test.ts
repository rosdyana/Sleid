import { describe, expect, it } from 'vitest'
import { LlmError } from './errors.ts'
import { withRetry } from './retry.ts'

describe('withRetry', () => {
  it('retries 429 and 5xx up to two times, with the given waits', async () => {
    const waits: number[] = []
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls === 1) throw new LlmError('rate-limit', 'slow down', { status: 429, retryAfterMs: 1500 })
        if (calls === 2) throw new LlmError('server', 'boom', { status: 503 })
        return 'ok'
      },
      { sleep: async (ms) => void waits.push(ms), baseDelayMs: 10 },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(waits[0]).toBe(1500)
    expect(waits[1]).toBeGreaterThanOrEqual(20)
  })

  it('gives up after the last retry and throws that error', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new LlmError('server', 'still down', { status: 500 })
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toMatchObject({ kind: 'server' })
    expect(calls).toBe(3)
  })

  it('does not retry auth, bad request, network or timeout errors', async () => {
    for (const kind of ['auth', 'bad-request', 'network', 'timeout'] as const) {
      let calls = 0
      await expect(
        withRetry(
          async () => {
            calls++
            throw new LlmError(kind, kind)
          },
          { sleep: async () => undefined },
        ),
      ).rejects.toMatchObject({ kind })
      expect(calls).toBe(1)
    }
  })

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController()
    const pending = withRetry(
      async () => {
        throw new LlmError('rate-limit', 'slow', { status: 429, retryAfterMs: 5000 })
      },
      { signal: controller.signal, baseDelayMs: 5000 },
    )
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
  })
})

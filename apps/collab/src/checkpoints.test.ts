import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCheckpointScheduler, IDLE_CHECKPOINT_MS, MAX_CHECKPOINT_INTERVAL_MS } from './checkpoints.ts'

const MIN = 60 * 1000

describe('automatic checkpoints (fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-03T09:00:00.000Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes one checkpoint two minutes after the last edit', async () => {
    const calls: Array<[string, string[]]> = []
    const scheduler = createCheckpointScheduler({ onCheckpoint: async (deck, editors) => void calls.push([deck, editors]) })
    scheduler.noteEdit('deck-1', 'ana')
    await vi.advanceTimersByTimeAsync(IDLE_CHECKPOINT_MS - 1)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual([['deck-1', ['ana']]])
    expect(scheduler.pending()).toBe(0)
  })

  it('restarts the idle timer on every edit, so a steady stream waits for the max interval instead', async () => {
    const calls: number[] = []
    const scheduler = createCheckpointScheduler({ onCheckpoint: async () => void calls.push(Date.now()) })
    const start = Date.now()
    // one edit every minute for 25 minutes: the idle timer never fires
    for (let i = 0; i < 25; i++) {
      scheduler.noteEdit('deck-1', 'ana')
      await vi.advanceTimersByTimeAsync(MIN)
    }
    // the first checkpoint is at the max interval after the first unsaved edit, then every max interval
    expect(calls).toEqual([start + MAX_CHECKPOINT_INTERVAL_MS, start + 2 * MAX_CHECKPOINT_INTERVAL_MS])
  })

  it('after a checkpoint, the next edit starts a new cycle', async () => {
    const calls: number[] = []
    const scheduler = createCheckpointScheduler({ onCheckpoint: async () => void calls.push(Date.now()) })
    scheduler.noteEdit('deck-1', 'ana')
    await vi.advanceTimersByTimeAsync(IDLE_CHECKPOINT_MS)
    await vi.advanceTimersByTimeAsync(30 * MIN) // quiet: no checkpoint
    expect(calls).toHaveLength(1)
    scheduler.noteEdit('deck-1', 'ana')
    await vi.advanceTimersByTimeAsync(IDLE_CHECKPOINT_MS)
    expect(calls).toHaveLength(2)
  })

  it('records the distinct last editors, most recent first, at most five', async () => {
    const seen: string[][] = []
    const scheduler = createCheckpointScheduler({ onCheckpoint: async (_deck, editors) => void seen.push(editors) })
    for (const who of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) scheduler.noteEdit('deck-1', who)
    await vi.advanceTimersByTimeAsync(IDLE_CHECKPOINT_MS)
    expect(seen).toEqual([['f', 'e', 'd', 'a', 'c']])
  })

  it('keeps decks apart', async () => {
    const seen: string[] = []
    const scheduler = createCheckpointScheduler({ onCheckpoint: async (deck) => void seen.push(deck) })
    scheduler.noteEdit('one', 'ana')
    await vi.advanceTimersByTimeAsync(MIN)
    scheduler.noteEdit('two', 'bo')
    await vi.advanceTimersByTimeAsync(IDLE_CHECKPOINT_MS - MIN)
    expect(seen).toEqual(['one'])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(seen).toEqual(['one', 'two'])
  })

  it('reports a failed checkpoint and carries on', async () => {
    const errors: string[] = []
    const scheduler = createCheckpointScheduler({
      onCheckpoint: async () => {
        throw new Error('database down')
      },
      onError: (deck) => errors.push(deck),
    })
    scheduler.noteEdit('deck-1', 'ana')
    await vi.advanceTimersByTimeAsync(IDLE_CHECKPOINT_MS)
    expect(errors).toEqual(['deck-1'])
    scheduler.noteEdit('deck-1', 'ana')
    expect(scheduler.pending()).toBe(1)
  })

  it('dispose cancels everything that is waiting', async () => {
    const calls: string[] = []
    const scheduler = createCheckpointScheduler({ onCheckpoint: async (deck) => void calls.push(deck) })
    scheduler.noteEdit('deck-1', 'ana')
    scheduler.dispose()
    scheduler.noteEdit('deck-2', 'ana')
    await vi.advanceTimersByTimeAsync(MAX_CHECKPOINT_INTERVAL_MS * 2)
    expect(calls).toEqual([])
  })
})

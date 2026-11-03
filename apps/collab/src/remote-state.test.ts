import { describe, expect, it } from 'vitest'
import { RemoteStateStore } from './remote-state.ts'

const state = { slide: 3, total: 9, slideId: 's3', notes: 'Say hello', title: 'Deck' }

describe('RemoteStateStore', () => {
  it('keeps the last state per deck and session, with its age', () => {
    let now = 1000
    const store = new RemoteStateStore(60_000, () => now)
    store.set('deck-a', 'sid-1', state)
    now = 1500
    expect(store.get('deck-a', 'sid-1')).toEqual({ state, ageMs: 500 })
    expect(store.get('deck-a', 'sid-2')).toBeNull()
    expect(store.get('deck-b', 'sid-1')).toBeNull()
  })

  it('forgets a state after its time to live', () => {
    let now = 0
    const store = new RemoteStateStore(1000, () => now)
    store.set('deck-a', 'sid-1', state)
    now = 1001
    expect(store.get('deck-a', 'sid-1')).toBeNull()
    expect(store.size()).toBe(0)
  })
})

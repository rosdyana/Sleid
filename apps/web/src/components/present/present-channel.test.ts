import { describe, expect, it } from 'vitest'
import { audienceUrl, followUrl, isRemoteAction, newSessionId, presenterUrl, remoteChannelName, SESSION_ID } from './present-channel'

describe('presenter session', () => {
  it('makes session ids that match the server rule, and different each time', () => {
    const a = newSessionId()
    const b = newSessionId()
    expect(a).toMatch(SESSION_ID)
    expect(a).not.toBe(b)
    expect(a.length).toBe(22)
    expect(a).not.toMatch(/[+/=]/)
  })

  it('builds the audience, presenter and follow URLs with the session in the query', () => {
    expect(audienceUrl('deck-id', 'sid-1234567890abcdef', 3)).toBe('/d/deck-id/present?slide=3&sid=sid-1234567890abcdef')
    expect(presenterUrl('deck-id', 'sid-1234567890abcdef', 1)).toBe('/d/deck-id/presenter?slide=1&sid=sid-1234567890abcdef')
    expect(followUrl('deck-id', 'sid-1234567890abcdef')).toBe('/d/deck-id/present?follow=sid-1234567890abcdef')
    expect(remoteChannelName('sid-1234567890abcdef')).toBe('remote:sid-1234567890abcdef')
  })

  it('accepts only the four remote actions', () => {
    expect(['next', 'prev', 'first', 'last'].every(isRemoteAction)).toBe(true)
    expect(isRemoteAction('delete')).toBe(false)
    expect(isRemoteAction(undefined)).toBe(false)
  })
})

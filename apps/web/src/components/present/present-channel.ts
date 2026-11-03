// The presenter session: its id, the messages between the presenter view and the audience window (same browser,
// BroadcastChannel), and the URLs that open each window. A session id is random and not a secret by itself: the
// phone needs a signed remote token on top of it, and followers only see slide positions.
export const REMOTE_ACTIONS = ['next', 'prev', 'first', 'last'] as const
export type RemoteAction = (typeof REMOTE_ACTIONS)[number]

/** Presenter view → audience window. */
export type PresenterMessage = { type: 'hello' } | { type: 'command'; action: RemoteAction }
/** Audience window → presenter view. `index` is 1-based, counting every slide in the deck. */
export type AudienceMessage = { type: 'state'; index: number; total: number; slideId: string }

export const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/

/** 16 random bytes, base64url: 22 characters. */
export function newSessionId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let text = ''
  for (const b of bytes) text += String.fromCharCode(b)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isRemoteAction(value: unknown): value is RemoteAction {
  return typeof value === 'string' && (REMOTE_ACTIONS as readonly string[]).includes(value)
}

export function presenterUrl(deckId: string, sid: string, slide: number): string {
  return `/d/${deckId}/presenter?slide=${slide}&sid=${encodeURIComponent(sid)}`
}

export function audienceUrl(deckId: string, sid: string, slide: number): string {
  return `/d/${deckId}/present?slide=${slide}&sid=${encodeURIComponent(sid)}`
}

/** The link a viewer opens to follow the presenter. Read-only: it only shows the slide the presenter is on. */
export function followUrl(deckId: string, sid: string): string {
  return `/d/${deckId}/present?follow=${encodeURIComponent(sid)}`
}

export function remoteChannelName(sid: string): string {
  return `remote:${sid}`
}

export interface PresentChannel {
  post(message: unknown): void
  close(): void
}

/** Opens the BroadcastChannel for one session. `post` is a no-op where the API is missing. */
export function openPresentChannel<T>(sid: string, onMessage: (message: T) => void): PresentChannel {
  if (typeof BroadcastChannel === 'undefined') return { post() {}, close() {} }
  const channel = new BroadcastChannel(`sleid-present:${sid}`)
  channel.onmessage = (event: MessageEvent) => onMessage(event.data as T)
  return {
    post: (message) => channel.postMessage(message),
    close: () => channel.close(),
  }
}

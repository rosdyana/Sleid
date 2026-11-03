// Google Slides, path A (a public link). Pure rules only: the URL parser, the redirect allowlist and the test-only
// origin override. The fetch itself is in google-slides.server.ts.

export const SLIDES_HOST = 'docs.google.com'
export const NOT_A_SLIDES_LINK = 'Paste the link of a Google Slides presentation, starting with https://docs.google.com/presentation/d/.'
/** Longest link we read. Real links are about 100 characters. */
const MAX_LINK_CHARS = 2000
const PRESENTATION_PATH = /^\/presentation\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/

export class SlidesLinkError extends Error {
  constructor(message = NOT_A_SLIDES_LINK) {
    super(message)
    this.name = 'SlidesLinkError'
  }
}

/**
 * The presentation id from a Google Slides link. Strict: https, host docs.google.com (no port, no user name),
 * path /presentation/d/<id>/... and an id of at least 20 letters, digits, '_' or '-'. Anything else is refused.
 */
export function parseSlidesLink(input: string): { presentationId: string } {
  const text = input.trim()
  if (text.length === 0 || text.length > MAX_LINK_CHARS) throw new SlidesLinkError()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new SlidesLinkError()
  }
  if (url.protocol !== 'https:' || url.hostname !== SLIDES_HOST || url.port !== '' || url.username !== '' || url.password !== '') {
    throw new SlidesLinkError()
  }
  const match = PRESENTATION_PATH.exec(url.pathname)
  if (!match) throw new SlidesLinkError()
  return { presentationId: match[1]! }
}

/**
 * Whether a redirect target may be fetched. Only https to docs.google.com or a subdomain of googleusercontent.com
 * (where Google serves the export), on the default port. The test origin, when set, is the only other allowed origin.
 */
export function isExportRedirectAllowed(target: URL, testOrigin: URL | null = null): boolean {
  if (testOrigin && target.origin === testOrigin.origin) return true
  if (target.protocol !== 'https:' || target.port !== '' || target.username !== '' || target.password !== '') return false
  if (target.hostname === SLIDES_HOST) return true
  return target.hostname.endsWith('.googleusercontent.com')
}

/**
 * Test-only: the origin that replaces https://docs.google.com for the Slides export, so the browser check can serve a
 * fake presentation from a local server. Honoured only when SLEID_TEST_AUTH=1, the same gate as the test login.
 * It is refused outright when NODE_ENV=production, and it must be a local http origin.
 */
export function testGoogleExportOrigin(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env.SLEID_TEST_GOOGLE_EXPORT_ORIGIN
  if (!raw) return null
  if (env.NODE_ENV === 'production') throw new Error('SLEID_TEST_GOOGLE_EXPORT_ORIGIN is refused when NODE_ENV=production')
  if (env.SLEID_TEST_AUTH !== '1') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('SLEID_TEST_GOOGLE_EXPORT_ORIGIN must be an origin such as http://127.0.0.1:4413')
  }
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error('SLEID_TEST_GOOGLE_EXPORT_ORIGIN must be a local http origin')
  }
  return new URL(url.origin)
}

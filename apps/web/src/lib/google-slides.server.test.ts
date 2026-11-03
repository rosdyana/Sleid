// Path A fetch: the redirect allowlist, the HTML-means-private case, the streaming cap, and the test override against a
// local fake server (through the real pinned fetch, which is what the browser check uses).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ImportError } from './import.server'
import { NOT_PUBLIC_SLIDES, fetchPublicPresentation, importPublicSlides } from './google-slides.server'

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-012'
const PK = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8])
const HTML = new TextEncoder().encode('<!doctype html><html><body>Sign in to continue</body></html>')

/** A fetch stand-in that answers from a script. Each entry is a status, headers and body, keyed by URL. */
function scriptedFetch(script: Record<string, { status: number; headers?: Record<string, string>; body?: Uint8Array }>) {
  const calls: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(href)
    const step = script[href]
    if (!step) return new Response('not scripted', { status: 599 })
    return new Response(step.body ? new Uint8Array(step.body) : null, { status: step.status, headers: step.headers })
  }) as typeof fetch
  return { fn, calls }
}

const exportUrl = `https://docs.google.com/presentation/d/${ID}/export/pptx`

describe('fetchPublicPresentation (with an injected fetch)', () => {
  it('returns the bytes of a zip export', async () => {
    const { fn, calls } = scriptedFetch({ [exportUrl]: { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats' }, body: PK } })
    const bytes = await fetchPublicPresentation(ID, { fetch: fn, env: {} })
    expect(Array.from(bytes)).toEqual(Array.from(PK))
    expect(calls).toEqual([exportUrl])
  })

  it('follows a redirect to a Google download host, one hop at a time', async () => {
    const hop = 'https://doc-0k.googleusercontent.com/export/abc/file.pptx'
    const { fn, calls } = scriptedFetch({
      [exportUrl]: { status: 302, headers: { location: hop } },
      [hop]: { status: 200, body: PK },
    })
    const bytes = await fetchPublicPresentation(ID, { fetch: fn, env: {} })
    expect(bytes.byteLength).toBe(PK.byteLength)
    expect(calls).toEqual([exportUrl, hop])
  })

  it('refuses a redirect to any other host, without requesting it', async () => {
    const evil = 'https://evil.example/steal'
    const { fn, calls } = scriptedFetch({ [exportUrl]: { status: 302, headers: { location: evil } }, [evil]: { status: 200, body: PK } })
    await expect(fetchPublicPresentation(ID, { fetch: fn, env: {} })).rejects.toThrow(/not a Google download host/)
    expect(calls).toEqual([exportUrl])
  })

  it('refuses a redirect to a metadata or loopback address', async () => {
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:3002/internal', 'https://docs.google.com.evil.example/x']) {
      const { fn, calls } = scriptedFetch({ [exportUrl]: { status: 302, headers: { location: bad } } })
      await expect(fetchPublicPresentation(ID, { fetch: fn, env: {} }), bad).rejects.toBeInstanceOf(ImportError)
      expect(calls, bad).toEqual([exportUrl])
    }
  })

  it('stops after five redirects', async () => {
    const script: Record<string, { status: number; headers: Record<string, string> }> = {}
    let url = exportUrl
    for (let i = 0; i < 8; i++) {
      const next = `https://docs.google.com/hop/${i}`
      script[url] = { status: 302, headers: { location: next } }
      url = next
    }
    const { fn } = scriptedFetch(script)
    await expect(fetchPublicPresentation(ID, { fetch: fn, env: {} })).rejects.toThrow(/more than 5 times/)
  })

  it('an HTML page (the login page of a private presentation) means it is not public', async () => {
    const { fn } = scriptedFetch({ [exportUrl]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML } })
    const err = await fetchPublicPresentation(ID, { fetch: fn, env: {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toBe(NOT_PUBLIC_SLIDES)
    expect(NOT_PUBLIC_SLIDES).toBe("This presentation isn't public. Share it as 'Anyone with the link' or use Google Drive.")
  })

  it('a 401 or 403 is the same not-public message; a 404 says the link is wrong', async () => {
    for (const status of [401, 403]) {
      const { fn } = scriptedFetch({ [exportUrl]: { status } })
      await expect(fetchPublicPresentation(ID, { fetch: fn, env: {} })).rejects.toThrow(NOT_PUBLIC_SLIDES)
    }
    const { fn } = scriptedFetch({ [exportUrl]: { status: 404 } })
    await expect(fetchPublicPresentation(ID, { fetch: fn, env: {} })).rejects.toThrow(/No presentation was found/)
  })

  it('caps the body while streaming, even without a content-length', async () => {
    const big = new Uint8Array(4000)
    big.set(PK, 0)
    const { fn } = scriptedFetch({ [exportUrl]: { status: 200, body: big } })
    const err = await fetchPublicPresentation(ID, { fetch: fn, env: {}, maxBytes: 1000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).status).toBe(413)
  })

  it('refuses a declared length over the cap before reading the body', async () => {
    const { fn } = scriptedFetch({ [exportUrl]: { status: 200, headers: { 'content-length': '999999' }, body: PK } })
    const err = await fetchPublicPresentation(ID, { fetch: fn, env: {}, maxBytes: 1000 }).catch((e: unknown) => e)
    expect((err as ImportError).status).toBe(413)
  })

  it('a bad link is refused before any request', async () => {
    const { fn, calls } = scriptedFetch({})
    const err = await importPublicSlides({} as never, { id: 'u1' }, 'https://evil.example/presentation/d/x', { fetch: fn, env: {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).status).toBe(400)
    expect(calls).toEqual([])
  })
})

describe('fetchPublicPresentation through the test override (real pinned fetch, local fake server)', () => {
  let server: Server
  let origin: string
  const hits: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url === `/presentation/d/${ID}/export/pptx`) {
        res.writeHead(302, { location: '/files/public.pptx' })
        res.end()
      } else if (req.url === '/files/public.pptx') {
        res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
        res.end(Buffer.from(PK))
      } else if (req.url === `/presentation/d/${ID}X/export/pptx`) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(Buffer.from(HTML))
      } else if (req.url === `/presentation/d/${ID}Y/export/pptx`) {
        res.writeHead(302, { location: 'https://evil.example/x' })
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('fetches the export from the override origin, following the redirect on it', async () => {
    const bytes = await fetchPublicPresentation(ID, { env: { SLEID_TEST_AUTH: '1', SLEID_TEST_GOOGLE_EXPORT_ORIGIN: origin } })
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(hits).toContain(`/presentation/d/${ID}/export/pptx`)
    expect(hits).toContain('/files/public.pptx')
  })

  it('an HTML answer from the local server is the private-presentation refusal', async () => {
    const err = await fetchPublicPresentation(`${ID}X`, { env: { SLEID_TEST_AUTH: '1', SLEID_TEST_GOOGLE_EXPORT_ORIGIN: origin } }).catch((e: unknown) => e)
    expect((err as ImportError).message).toBe(NOT_PUBLIC_SLIDES)
  })

  it('a redirect to a non-Google host is refused even on the override origin', async () => {
    const before = hits.length
    const err = await fetchPublicPresentation(`${ID}Y`, { env: { SLEID_TEST_AUTH: '1', SLEID_TEST_GOOGLE_EXPORT_ORIGIN: origin } }).catch((e: unknown) => e)
    expect((err as ImportError).message).toMatch(/not a Google download host/)
    expect(hits.length).toBe(before + 1)
  })
})

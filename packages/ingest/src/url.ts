// Fetches a reference URL. Always through the SSRF-safe pinned fetch: scheme and address checks on every hop,
// redirects followed here (max 5, each hop checked again), a size cap and a timeout.
import { createPinnedFetch, type UrlPolicy } from '@sleid/llm'
import { bytesMatchMime } from '@sleid/db'
import { htmlToText, cleanText, stripMarkup } from './sanitize.ts'
import { extractFile, type ExtractedTable } from './extract.ts'
import { IngestError, LIMITS } from './limits.ts'

/** Production policy. User-supplied URLs never reach private or loopback addresses, whatever the provider scope. */
export const PUBLIC_URL_POLICY: UrlPolicy = { allowPrivate: false }

export interface FetchUrlOptions {
  /** Test-only override (for example a local test server). Production never passes this. */
  policy?: UrlPolicy
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

export interface FetchedUrl {
  url: string
  status: number
  contentType: string
  body: Uint8Array
}

export interface FetchedImage {
  /** The final address, after any redirects. */
  url: string
  /** The declared type, one of PNG, JPEG, WebP, GIF or SVG. The bytes have been checked against it. */
  mime: string
  body: Uint8Array
}

/** What one kind of fetch accepts. Pages and images share the same hop loop (see fetchWithHops). */
interface FetchKind {
  accept: string
  types: readonly string[]
  /** Used in messages: "The page is larger than…". */
  noun: string
  /** Used in the unsupported-type message, after "which is not read". */
  hint: string
  defaultMaxBytes: number
}

const PAGE_KIND: FetchKind = {
  accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown,text/csv;q=0.9',
  types: ['text/html', 'application/xhtml+xml', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv'],
  noun: 'page',
  hint: 'HTML, PDF, text or CSV only',
  defaultMaxBytes: LIMITS.maxUrlBytes,
}

/** Default cap for a fetched image (a logo or a picture referenced by URL). */
export const MAX_IMAGE_URL_BYTES = 5 * 1024 * 1024

const IMAGE_KIND: FetchKind = {
  accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml;q=0.9',
  types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'],
  noun: 'image',
  hint: 'PNG, JPEG, WebP, GIF or SVG only',
  defaultMaxBytes: MAX_IMAGE_URL_BYTES,
}

export function normaliseContentType(value: string | null): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * Test-only: lets the wizard's URL references point at loopback and private addresses (the browser e2e serves its page
 * locally). Honoured only when SLEID_TEST_AUTH=1 and NODE_ENV is not production, the same gate as the test login.
 * Production never sets it, and the policy in fetchPublicUrl is otherwise unchanged.
 */
export function testPrivateWizardUrls(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SLEID_TEST_AUTH === '1' && env.NODE_ENV !== 'production' && env.SLEID_TEST_PRIVATE_WIZARD_URLS === '1'
}

export async function fetchPublicUrl(input: string, options: FetchUrlOptions = {}): Promise<FetchedUrl> {
  return fetchWithHops(input, options, PAGE_KIND)
}

/**
 * Fetches an image by URL with the same policy as fetchPublicUrl. Only the five raster and SVG types are accepted,
 * and the bytes must match the declared type (bytesMatchMime), so a PNG header on an HTML body is refused.
 */
export async function fetchPublicImage(input: string, options: FetchUrlOptions = {}): Promise<FetchedImage> {
  const fetched = await fetchWithHops(input, options, IMAGE_KIND)
  if (!bytesMatchMime(fetched.contentType, fetched.body)) {
    throw new IngestError('unsupported', `The image content does not match its declared type (${fetched.contentType}).`)
  }
  return { url: fetched.url, mime: fetched.contentType, body: fetched.body }
}

/** The redirect, status, type and size checks shared by pages and images. Each hop goes through the pinned fetch. */
async function fetchWithHops(input: string, options: FetchUrlOptions, kind: FetchKind): Promise<FetchedUrl> {
  const doFetch = options.fetch ?? createPinnedFetch(options.policy ?? PUBLIC_URL_POLICY)
  const maxBytes = options.maxBytes ?? kind.defaultMaxBytes
  const maxRedirects = options.maxRedirects ?? LIMITS.maxRedirects
  let current = input
  for (let hop = 0; ; hop++) {
    let response: Response
    try {
      response = await doFetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? LIMITS.urlTimeoutMs),
        headers: { accept: kind.accept, 'user-agent': 'SleidWizard/1.0' },
      })
    } catch (err) {
      throw new IngestError('blocked', `The address could not be fetched: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new IngestError('fetch-failed', 'The address redirected without a location.')
      if (hop >= maxRedirects) throw new IngestError('fetch-failed', `The address redirected more than ${maxRedirects} times.`)
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new IngestError('fetch-failed', `The address answered HTTP ${response.status}.`)
    }
    const contentType = normaliseContentType(response.headers.get('content-type'))
    if (!kind.types.includes(contentType)) {
      await response.body?.cancel().catch(() => undefined)
      throw new IngestError('unsupported', `The address returned ${contentType || 'no content type'}, which is not read (${kind.hint}).`)
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new IngestError('too-large', `The ${kind.noun} is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`)
    }
    const body = await readCapped(response, maxBytes, kind.noun)
    return { url: current, status: response.status, contentType, body }
  }
}

async function readCapped(response: Response, maxBytes: number, noun: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new IngestError('too-large', `The ${noun} is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export interface UrlExtract {
  title: string
  text: string
  tables: ExtractedTable[]
  warnings: string[]
}

/** Main text of a fetched page: HTML through Readability, PDF through the PDF extractor, text and CSV as they are. */
export async function extractUrl(fetched: FetchedUrl, fallbackTitle: string): Promise<UrlExtract> {
  const decode = () => new TextDecoder('utf-8').decode(fetched.body)
  switch (fetched.contentType) {
    case 'text/html':
    case 'application/xhtml+xml': {
      const r = htmlToText(decode(), fallbackTitle)
      return { title: r.title, text: r.text, tables: [], warnings: [] }
    }
    case 'application/pdf': {
      const r = await extractFile({ fileName: `${fallbackTitle.replace(/\.pdf$/i, '')}.pdf`, bytes: fetched.body })
      return { title: fallbackTitle, text: r.text, tables: r.tables, warnings: r.warnings }
    }
    case 'text/csv': {
      const r = await extractFile({ fileName: 'page.csv', bytes: fetched.body })
      return { title: fallbackTitle, text: r.text, tables: r.tables, warnings: r.warnings }
    }
    default:
      return { title: fallbackTitle, text: stripMarkup(decode()), tables: [], warnings: [] }
  }
}

/** Plain-text check used by tests and summaries. */
export function plain(text: string): string {
  return cleanText(text)
}

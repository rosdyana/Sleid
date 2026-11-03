// Fetches a reference URL. Always through the SSRF-safe pinned fetch: scheme and address checks on every hop,
// redirects followed here (max 5, each hop checked again), a size cap and a timeout.
import { createPinnedFetch, type UrlPolicy } from '@sleid/llm'
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

const ALLOWED_TYPES = ['text/html', 'application/xhtml+xml', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv']

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
  const doFetch = options.fetch ?? createPinnedFetch(options.policy ?? PUBLIC_URL_POLICY)
  const maxBytes = options.maxBytes ?? LIMITS.maxUrlBytes
  const maxRedirects = options.maxRedirects ?? LIMITS.maxRedirects
  let current = input
  for (let hop = 0; ; hop++) {
    let response: Response
    try {
      response = await doFetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? LIMITS.urlTimeoutMs),
        headers: { accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown,text/csv;q=0.9', 'user-agent': 'SleidWizard/1.0' },
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
    if (!ALLOWED_TYPES.includes(contentType)) {
      await response.body?.cancel().catch(() => undefined)
      throw new IngestError('unsupported', `The address returned ${contentType || 'no content type'}, which is not read (HTML, PDF, text or CSV only).`)
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new IngestError('too-large', `The page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`)
    }
    const body = await readCapped(response, maxBytes)
    return { url: current, status: response.status, contentType, body }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
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
      throw new IngestError('too-large', `The page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`)
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

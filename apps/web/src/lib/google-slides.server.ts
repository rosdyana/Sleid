// Google Slides, path A: fetches a public presentation as PPTX through the SSRF-safe pinned fetch.
// Redirects are followed here, one hop at a time, and each target must pass isExportRedirectAllowed.
import { createPinnedFetch, type UrlPolicy } from '@sleid/llm'
import { ImportError, IMPORT_LIMITS, hasZipMagic, readStreamCapped, startImport, type StartImportResult } from './import.server'
import { SlidesLinkError, isExportRedirectAllowed, parseSlidesLink, testGoogleExportOrigin } from './google-slides'
import type { ImportDeps, ImportUser } from './import.server'

/** Shown when Google answers with a login page (or any non-file) for a presentation that is not shared by link. */
export const NOT_PUBLIC_SLIDES = "This presentation isn't public. Share it as 'Anyone with the link' or use Google Drive."
const MAX_HOPS = 5
const TIMEOUT_MS = 60_000
const PPTX_ACCEPT = 'application/vnd.openxmlformats-officedocument.presentationml.presentation,*/*;q=0.5'

export interface FetchSlidesOptions {
  /** Test-only replacement for the pinned fetch. */
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxBytes?: number
}

/** Fetches `https://docs.google.com/presentation/d/<id>/export/pptx` and returns the file bytes. */
export async function fetchPublicPresentation(presentationId: string, options: FetchSlidesOptions = {}): Promise<Uint8Array> {
  const env = options.env ?? process.env
  const testOrigin = testGoogleExportOrigin(env)
  const policy: UrlPolicy = { allowPrivate: testOrigin !== null }
  const doFetch = options.fetch ?? createPinnedFetch(policy)
  const maxBytes = options.maxBytes ?? IMPORT_LIMITS.pptxBytes
  const origin = testOrigin ?? new URL('https://docs.google.com')
  let current = new URL(`/presentation/d/${presentationId}/export/pptx`, origin).href

  for (let hop = 0; ; hop++) {
    let response: Response
    try {
      response = await doFetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        headers: { accept: PPTX_ACCEPT, 'user-agent': 'SleidImport/1.0' },
      })
    } catch (err) {
      console.error('[google-slides] fetch failed', err)
      throw new ImportError('Google Slides could not be reached. Try again.', 502)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new ImportError('Google Slides redirected without an address. Try again.', 502)
      if (hop >= MAX_HOPS) throw new ImportError(`Google Slides redirected more than ${MAX_HOPS} times.`, 502)
      const next = new URL(location, current)
      if (!isExportRedirectAllowed(next, testOrigin)) {
        throw new ImportError("Google Slides redirected to an address that is not a Google download host, so the import was stopped.", 502)
      }
      current = next.href
      continue
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401 || response.status === 403) throw new ImportError(NOT_PUBLIC_SLIDES, 403)
      if (response.status === 404) throw new ImportError('No presentation was found at that link. Check the link and try again.', 404)
      throw new ImportError(`Google Slides answered HTTP ${response.status}. Try again later.`, 502)
    }

    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new ImportError(`PowerPoint files are limited to ${maxBytes / (1024 * 1024)} MB.`, 413)
    }
    const bytes = await readStreamCapped(response.body, maxBytes, `PowerPoint files are limited to ${maxBytes / (1024 * 1024)} MB.`)
    // A login page or any other HTML is not a zip: the presentation is private.
    if (!hasZipMagic(bytes)) throw new ImportError(NOT_PUBLIC_SLIDES, 403)
    return bytes
  }
}

/** Starts an import from a public Slides link: parse, fetch, then the same import path as an upload. */
export async function importPublicSlides(deps: ImportDeps, user: ImportUser, link: string, options: FetchSlidesOptions = {}): Promise<StartImportResult> {
  let presentationId: string
  try {
    presentationId = parseSlidesLink(link).presentationId
  } catch (err) {
    if (err instanceof SlidesLinkError) throw new ImportError(err.message, 400)
    throw err
  }
  const bytes = await fetchPublicPresentation(presentationId, options)
  return startImport(deps, user, { format: 'pptx', fileName: `${presentationId}.pptx`, bytes, google: { fileId: presentationId } })
}

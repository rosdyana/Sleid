// Google Slides, path B: exports a Drive file as PPTX through the Drive v3 API. Behind the DriveExporter interface so
// the tests can point it at a local fake server. The access token comes from Better Auth (drive-auth.server.ts).
import { ImportError, IMPORT_LIMITS, hasZipMagic, readStreamCapped } from './import.server'

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
export const RECONNECT_DRIVE = 'Google Drive refused access to this presentation. Reconnect Google Drive and try again.'
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/
const TIMEOUT_MS = 60_000

export interface DriveExporter {
  /** The PPTX export of one Drive file, as bytes. Throws ImportError with a message for the user. */
  exportPptx(fileId: string, accessToken: string): Promise<Uint8Array>
}

export interface DriveExporterOptions {
  /** Default https://www.googleapis.com. Tests pass a local fake server. */
  baseUrl?: string
  fetch?: typeof fetch
  maxBytes?: number
  timeoutMs?: number
}

export function createDriveExporter(options: DriveExporterOptions = {}): DriveExporter {
  const base = (options.baseUrl ?? 'https://www.googleapis.com').replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch
  const maxBytes = options.maxBytes ?? IMPORT_LIMITS.pptxBytes
  const tooLarge = `PowerPoint files are limited to ${maxBytes / (1024 * 1024)} MB.`
  return {
    async exportPptx(fileId, accessToken) {
      if (!FILE_ID.test(fileId)) throw new ImportError('That is not a Google Drive file id. Pick the presentation again.', 400)
      const url = `${base}/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${PPTX_MIME}`
      let response: Response
      try {
        response = await doFetch(url, {
          headers: { authorization: `Bearer ${accessToken}`, accept: PPTX_MIME },
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        })
      } catch (err) {
        console.error('[drive] export request failed', err)
        throw new ImportError('Google Drive could not be reached. Try again.', 502)
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw driveStatusError(response.status)
      }
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw new ImportError(tooLarge, 413)
      }
      const bytes = await readStreamCapped(response.body, maxBytes, tooLarge)
      if (!hasZipMagic(bytes)) throw new ImportError('Google Drive did not return a PowerPoint file for this presentation.', 415)
      return bytes
    },
  }
}

/** The message for a failed Drive call. A 401 or 403 becomes the "reconnect" message, the one the user can act on. */
export function driveStatusError(status: number): ImportError {
  if (status === 401 || status === 403) return new ImportError(RECONNECT_DRIVE, 403)
  if (status === 404) return new ImportError('That presentation was not found in Google Drive. Pick it again.', 404)
  if (status === 400) return new ImportError('Google Drive cannot export this file as PowerPoint.', 415)
  if (status === 429 || status >= 500) return new ImportError('Google Drive is busy. Try again in a minute.', 502)
  return new ImportError(`Google Drive answered HTTP ${status}. Try again later.`, 502)
}

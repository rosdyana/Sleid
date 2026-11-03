// Client helpers for the Import dialog: the format from a file name (the server still checks the content), the
// raw upload, and the polling loop over getImportFn. No secrets here.
import { getImportFn } from '~/lib/import.functions'
import type { UploadFormat } from './import-format.ts'

export { IMPORT_ACCEPT, IMPORT_HINT, formatForFileName, type UploadFormat } from './import-format.ts'

export type ImportStatus = 'queued' | 'running' | 'done' | 'failed'

export interface ImportView {
  status: ImportStatus
  deckId?: string
  warnings?: string[]
  error?: string
}

/** Uploads the file as raw bytes. The server answers 202 with the import id, or an error message to show. */
export async function uploadImport(file: File, format: UploadFormat): Promise<{ importId: string }> {
  const response = await fetch('/api/imports', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-import-format': format, 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  })
  const body = (await response.json().catch(() => ({}))) as { importId?: string; error?: string }
  if (!response.ok || !body.importId) {
    throw new Error(body.error ?? `The upload failed (HTTP ${response.status}).`)
  }
  return { importId: body.importId }
}

export const STATUS_TEXT: Record<ImportStatus, string> = {
  queued: 'Waiting for the import service…',
  running: 'Converting the slides…',
  done: 'Done.',
  failed: 'The import failed.',
}

/**
 * Polls one import until it is done or failed. Calls `onUpdate` on every answer, and stops when `isCancelled` says so
 * (the dialog was closed). Polling is once a second, and gives up after `maxMs` with a message the user can act on.
 */
export async function pollImport(
  importId: string,
  onUpdate: (view: ImportView) => void,
  isCancelled: () => boolean,
  options: { intervalMs?: number; maxMs?: number } = {},
): Promise<ImportView | null> {
  const intervalMs = options.intervalMs ?? 1000
  const deadline = Date.now() + (options.maxMs ?? 5 * 60 * 1000)
  for (;;) {
    if (isCancelled()) return null
    const view = (await getImportFn({ data: { importId } })) as ImportView
    if (isCancelled()) return null
    onUpdate(view)
    if (view.status === 'done' || view.status === 'failed') return view
    if (Date.now() > deadline) {
      const timedOut: ImportView = { status: 'failed', error: 'The import is still running. It keeps going in the background; look for the new deck on the dashboard shortly.' }
      onUpdate(timedOut)
      return timedOut
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

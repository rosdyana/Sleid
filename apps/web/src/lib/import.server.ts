// Deck import, as plain functions over the database, the storage driver and the job queue, so the tests can call them.
// The server functions (import.functions.ts) and the upload route (routes/api/imports.ts) are thin wrappers, and the
// MCP tool import_deck uses the same functions. The worker does the conversion (apps/worker/src/import).
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { countImportsSince, getImportForUser, insertImportJob, markImportFailed, type Db, type ImportFormat, type ImportJobRow } from '@sleid/db'
import { baseName } from '@sleid/ingest'
import type { StorageDriver } from '@sleid/storage'

const MB = 1024 * 1024

/** Size caps and the per-user rate limit. A pptx is zipped, so it gets the larger cap. */
export const IMPORT_LIMITS = {
  pptxBytes: 50 * MB,
  textBytes: 5 * MB,
  perHour: 10,
} as const

/** Formats an upload (or the raw-bytes route) may send. Google Slides imports come through their own path. */
export type UploadFormat = Exclude<ImportFormat, 'google-slides'>
export const IMPORT_FORMATS: readonly UploadFormat[] = ['pptx', 'markdown', 'json']
const HOUR_MS = 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A zip local file header: every .pptx starts with it. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

export class ImportError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ImportError'
    this.status = status
  }
}

export interface ImportQueue {
  enqueueImport(payload: { importId: string }): Promise<string | null>
}

export interface ImportDeps {
  db: Db
  storage: StorageDriver
  queue: ImportQueue
  now?: () => Date
}

export interface ImportUser {
  id: string
}

export interface StartImportInput {
  /** pptx, markdown or json. A Google Slides import is pptx with `google` set. */
  format: UploadFormat
  fileName: string
  bytes: Uint8Array
  /** Deck title from the caller. Omitted, the title comes from the file. */
  title?: string
  /** Set for a Google Slides import: the presentation id (public link) or the Drive file id. The row is recorded as google-slides. */
  google?: { fileId: string }
}

export interface ImportStatusView {
  status: ImportJobRow['status']
  deckId?: string
  /** Set once the import is done (possibly an empty list). */
  warnings?: string[]
  /** Set when the import failed. Written for the user. */
  error?: string
}

/** Refuses a file by its content: the size cap, the magic bytes, and UTF-8 text for markdown and json. The extension is never trusted. */
export function checkImportBytes(format: UploadFormat, bytes: Uint8Array): void {
  if (!IMPORT_FORMATS.includes(format)) throw new ImportError('Use pptx, markdown or json.', 400)
  if (bytes.byteLength === 0) throw new ImportError('The file is empty.', 400)
  if (format === 'pptx') {
    if (bytes.byteLength > IMPORT_LIMITS.pptxBytes) throw new ImportError(`PowerPoint files are limited to ${IMPORT_LIMITS.pptxBytes / MB} MB.`, 413)
    if (!hasZipMagic(bytes)) throw new ImportError('This is not a PowerPoint file: its content is not a zip package.', 415)
    return
  }
  if (bytes.byteLength > IMPORT_LIMITS.textBytes) throw new ImportError(`Markdown and JSON files are limited to ${IMPORT_LIMITS.textBytes / MB} MB.`, 413)
  if (bytes.includes(0)) throw new ImportError('This file contains NUL bytes, so it is not text.', 415)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ImportError('This file is not valid UTF-8 text.', 415)
  }
  if (format === 'json') {
    try {
      JSON.parse(text)
    } catch {
      throw new ImportError('This file is not valid JSON.', 415)
    }
  }
}

/** Standard base64 from a request. Whitespace is allowed; anything else that is not base64 is refused. */
export function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, '')
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new ImportError('The file is not valid base64.', 400)
  }
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

/**
 * Starts an import: checks the bytes, applies the rate limit, stores the source, inserts the row and queues the job.
 * Returns the import id at once. A storage or queue failure marks the row failed, so the caller sees why when it asks for the status.
 */
export interface StartImportResult {
  importId: string
}

export async function startImport(deps: ImportDeps, user: ImportUser, input: StartImportInput): Promise<StartImportResult> {
  checkImportBytes(input.format, input.bytes)
  if (input.google && input.format !== 'pptx') throw new ImportError('A Google Slides import is always a pptx file.', 400)
  const fileName = baseName(input.fileName).slice(0, 200) || 'import'
  const title = input.title?.trim().slice(0, 200) || null
  const importId = randomUUID()
  const sourceKey = `import/${importId}`
  const since = new Date((deps.now ?? (() => new Date()))().getTime() - HOUR_MS)

  // The lock makes the count and the insert one step per user, so two requests at once cannot both pass the limit.
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id}))`)
    const used = await countImportsSince(tx as unknown as Db, user.id, since)
    if (used >= IMPORT_LIMITS.perHour) {
      throw new ImportError(`You have started ${used} imports in the last hour, and the limit is ${IMPORT_LIMITS.perHour}. Try again later.`, 429)
    }
    await insertImportJob(tx as unknown as Db, {
      id: importId,
      userId: user.id,
      format: input.google ? 'google-slides' : input.format,
      fileName,
      title,
      bytes: input.bytes.byteLength,
      sourceKey,
      googleFileId: input.google?.fileId ?? null,
    })
  })

  try {
    await deps.storage.put(sourceKey, input.bytes)
  } catch (err) {
    console.error('[import] could not store the upload', err)
    await markImportFailed(deps.db, importId, 'The upload could not be stored. Try again.')
    return { importId }
  }
  try {
    await deps.queue.enqueueImport({ importId })
  } catch (err) {
    console.error('[import] could not queue the job', err)
    await deps.storage.delete(sourceKey).catch(() => undefined)
    await markImportFailed(deps.db, importId, 'The import service is not running. Start the worker (pnpm dev runs it) and try again.')
  }
  return { importId }
}

/** The status of one of the caller's imports. Other users get "not found", the same as a missing id. */
export async function getImport(deps: ImportDeps, user: ImportUser, importId: string): Promise<ImportStatusView> {
  if (!UUID.test(importId)) throw new ImportError('Import not found.', 404)
  const row = await getImportForUser(deps.db, user.id, importId)
  if (!row) throw new ImportError('Import not found.', 404)
  return {
    status: row.status,
    ...(row.deckId ? { deckId: row.deckId } : {}),
    ...(row.status === 'done' ? { warnings: row.warnings } : {}),
    ...(row.status === 'failed' && row.error ? { error: row.error } : {}),
  }
}

/** A format from the x-import-format header. */
export function formatFromHeader(value: string | null): UploadFormat {
  const format = (value ?? '').trim() as UploadFormat
  if (!IMPORT_FORMATS.includes(format)) throw new ImportError('Send x-import-format: pptx, markdown or json.', 400)
  return format
}

/** The file name from the x-file-name header (URL-encoded). It is only for display. */
export function fileNameFromHeader(value: string | null): string {
  if (!value) throw new ImportError('The upload needs an x-file-name header.', 400)
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ImportError('The file name is not valid.', 400)
  }
}

/** Reads a raw request body, refusing it as soon as it passes `maxBytes`. */
export async function readImportBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new ImportError('The file is too large.', 413)
  return readStreamCapped(request.body, maxBytes)
}

/** Reads a stream to the end, refusing it as soon as it passes `maxBytes`. Used for uploads and for fetched exports. */
export async function readStreamCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number, tooLarge = 'The file is too large.'): Promise<Uint8Array> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ImportError(tooLarge, 413)
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

/** Whether the bytes start with the zip local file header every .pptx starts with. */
export function hasZipMagic(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b)
}

/** The size cap for a format, for readImportBody. */
export function maxBytesFor(format: UploadFormat): number {
  return format === 'pptx' ? IMPORT_LIMITS.pptxBytes : IMPORT_LIMITS.textBytes
}

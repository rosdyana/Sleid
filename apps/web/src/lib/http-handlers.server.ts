// HTTP handlers for uploads, asset reads and export downloads. The /api routes call these with the
// database, the storage and the caller's user id. Keeping them free of request-context imports makes them testable.
import { createHash, randomUUID } from 'node:crypto'
import { attachmentDisposition, canEdit, getAssetWithDeck, getDeckRole, getExportForUser, insertAsset, type Db } from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'

export const ASSET_MAX_BYTES = 10 * 1024 * 1024

export const ASSET_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Checks the first bytes against the claimed type. SVG must be text with no active content. */
export function bytesMatchMime(mime: string, bytes: Uint8Array): boolean {
  const head = (n: number) => Array.from(bytes.subarray(0, n))
  switch (mime) {
    case 'image/png':
      return head(8).join(',') === '137,80,78,71,13,10,26,10'
    case 'image/jpeg':
      return head(3).join(',') === '255,216,255'
    case 'image/gif': {
      const s = new TextDecoder().decode(bytes.subarray(0, 6))
      return s === 'GIF87a' || s === 'GIF89a'
    }
    case 'image/webp': {
      const riff = new TextDecoder().decode(bytes.subarray(0, 4))
      const webp = new TextDecoder().decode(bytes.subarray(8, 12))
      return riff === 'RIFF' && webp === 'WEBP'
    }
    case 'image/svg+xml': {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, 2_000_000)
      if (!/<svg[\s>]/i.test(text)) return false
      // Active content and external entities are refused. The response also carries a sandbox CSP.
      return !/<script|<!entity|<!doctype[^>]*\[|javascript:|\son[a-z]+\s*=|<foreignobject|<iframe|<embed|<object/i.test(text)
    }
    default:
      return false
  }
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export interface HandlerDeps {
  db: Db
  storage: StorageDriver
  /** The signed-in user, or null for an anonymous request. */
  userId: string | null
}

/** POST /api/decks/:deckId/assets, multipart field "file". Editors and owners only. */
export async function handleAssetUpload(request: Request, deckId: string, deps: HandlerDeps): Promise<Response> {
  if (!UUID.test(deckId)) return json(404, { error: 'Deck not found' })
  if (!deps.userId) return json(401, { error: 'Sign in to upload images' })
  const role = await getDeckRole(deps.db, deps.userId, deckId)
  if (!role) return json(404, { error: 'Deck not found' })
  if (!canEdit(role)) return json(403, { error: 'You need editor access to add images' })

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > ASSET_MAX_BYTES + 64 * 1024) return json(413, { error: 'Images are limited to 10 MB' })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json(400, { error: 'Send the image as multipart form data in a field named "file"' })
  }
  const file = form.get('file')
  if (!(file instanceof File)) return json(400, { error: 'Send the image in a field named "file"' })
  if (file.size > ASSET_MAX_BYTES) return json(413, { error: 'Images are limited to 10 MB' })
  const mime = file.type.toLowerCase()
  if (!(mime in ASSET_MIME_EXTENSIONS)) {
    return json(415, { error: 'Use a PNG, JPEG, GIF, WebP or SVG image' })
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength === 0) return json(400, { error: 'The file is empty' })
  if (bytes.byteLength > ASSET_MAX_BYTES) return json(413, { error: 'Images are limited to 10 MB' })
  if (!bytesMatchMime(mime, bytes)) return json(415, { error: 'The file content does not match its type' })

  const id = randomUUID()
  await deps.storage.put(id, bytes)
  try {
    await insertAsset(deps.db, {
      id,
      deckId,
      ownerId: deps.userId,
      mime,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  } catch (err) {
    await deps.storage.delete(id).catch(() => undefined)
    throw err
  }
  return json(201, { id, url: `/api/assets/${id}`, mime, bytes: bytes.byteLength })
}

/**
 * GET /api/assets/:id. Viewers and up can read an asset of their deck. Anyone can read it when the deck
 * is published. Everyone else gets 404, the same as a missing asset.
 */
export async function handleAssetRead(assetId: string, deps: HandlerDeps): Promise<Response> {
  if (!UUID.test(assetId)) return json(404, { error: 'Not found' })
  const row = await getAssetWithDeck(deps.db, assetId)
  if (!row) return json(404, { error: 'Not found' })
  let allowed = false
  if (deps.userId) allowed = (await getDeckRole(deps.db, deps.userId, row.deckId)) !== null
  if (!allowed) allowed = row.publishedToken !== null
  if (!allowed) return json(404, { error: 'Not found' })

  const bytes = await deps.storage.get(assetId)
  if (!bytes) return json(404, { error: 'Not found' })
  const headers: Record<string, string> = {
    'content-type': row.mime,
    'content-length': String(bytes.byteLength),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=300',
  }
  // An SVG opened on its own runs in a sandbox: no scripts, no same-origin access.
  if (row.mime === 'image/svg+xml') headers['content-security-policy'] = 'sandbox'
  return new Response(new Uint8Array(bytes), { status: 200, headers })
}

/** GET /api/exports/:id/file. Only the user who asked for the export can download it. */
export async function handleExportDownload(exportId: string, deps: HandlerDeps, exportsStorage: StorageDriver): Promise<Response> {
  if (!UUID.test(exportId)) return json(404, { error: 'Not found' })
  if (!deps.userId) return json(401, { error: 'Sign in to download exports' })
  const row = await getExportForUser(deps.db, deps.userId, exportId)
  if (!row) return json(404, { error: 'Not found' })
  if (row.status !== 'done' || !row.fileKey || !row.fileName || !row.contentType) {
    return json(409, { error: 'The export is not ready yet' })
  }
  const bytes = await exportsStorage.get(row.fileKey)
  if (!bytes) return json(404, { error: 'The export file is gone. Start the export again.' })
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': row.contentType,
      'content-length': String(bytes.byteLength),
      'content-disposition': attachmentDisposition(row.fileName),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
}

// HTTP handlers for uploads, asset reads and export downloads. The /api routes call these with the
// database, the storage and the caller's user id. Keeping them free of request-context imports makes them testable.
import { attachmentDisposition, AssetError, canEdit, consumeExportLink, findExportByLink, getAssetWithDeck, getDeckRole, getExportForUser, storeDeckAsset, type Db } from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'

// The image checks live in @sleid/db (image-bytes.ts), shared with the MCP tools and the import.
export { bytesMatchMime, ASSET_MIME_EXTENSIONS } from '@sleid/db'

export const ASSET_MAX_BYTES = 10 * 1024 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = file.type.toLowerCase()

  let stored: Awaited<ReturnType<typeof storeDeckAsset>>
  try {
    stored = await storeDeckAsset(deps.db, deps.storage, { deckId, ownerId: deps.userId, mime, bytes, maxBytes: ASSET_MAX_BYTES })
  } catch (err) {
    if (err instanceof AssetError) return json(assetErrorStatus(err), { error: err.message })
    throw err
  }
  return json(201, { id: stored.id, url: stored.url, mime, bytes: bytes.byteLength })
}

/** The HTTP status for a refused image: 415 for a type problem, 413 for size, 400 for an empty file. */
function assetErrorStatus(err: AssetError): number {
  switch (err.code) {
    case 'type':
    case 'mismatch':
      return 415
    case 'too-large':
      return 413
    case 'empty':
      return 400
    case 'limit':
      return 409
    case 'not-found':
      return 404
  }
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
/**
 * GET /api/exports/:id/file. The owner downloads with a session. An MCP caller passes the one-time `linkToken`
 * from export_deck instead: a finished export is served once, and a link used or expired gets 404. A link
 * sent before the export finished is kept, so the caller can try again.
 */
export async function handleExportDownload(
  exportId: string,
  deps: HandlerDeps,
  exportsStorage: StorageDriver,
  options: { linkToken?: string | null } = {},
): Promise<Response> {
  if (!UUID.test(exportId)) return json(404, { error: 'Not found' })
  let row: Awaited<ReturnType<typeof getExportForUser>>
  if (options.linkToken) {
    const pending = await findExportByLink(deps.db, exportId, options.linkToken)
    if (!pending) return json(404, { error: 'Not found' })
    if (pending.status !== 'done' || !pending.fileKey) return json(409, { error: 'The export is not ready yet' })
    row = await consumeExportLink(deps.db, exportId, options.linkToken)
    if (!row) return json(404, { error: 'Not found' })
  } else {
    if (!deps.userId) return json(401, { error: 'Sign in to download exports' })
    row = await getExportForUser(deps.db, deps.userId, exportId)
    if (!row) return json(404, { error: 'Not found' })
  }
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
      'referrer-policy': 'no-referrer',
    },
  })
}

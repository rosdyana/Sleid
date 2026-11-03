// Image assets (M11): the personal library, and images stored on a deck. Writes here do not check who may edit a
// deck or who may read a source. The caller must do that first (the web app's handlers, or the MCP tools): each
// function below says what the caller has to have checked.
import { createHash, randomUUID } from 'node:crypto'
import { and, count, desc, eq } from 'drizzle-orm'
import type { Db } from './client.ts'
import { getAssetWithDeck, insertAsset } from './assets.ts'
import { ASSET_MIME_EXTENSIONS, bytesMatchMime, imageSize } from './image-bytes.ts'
import { userAssets } from './schema/index.ts'

/** Largest image in a personal library. */
export const USER_ASSET_MAX_BYTES = 5 * 1024 * 1024
/** Images one user may keep in their library. */
export const USER_ASSET_MAX_COUNT = 200
/** Largest image on a deck, the same as the editor's image upload. */
export const DECK_ASSET_MAX_BYTES = 10 * 1024 * 1024

const USER_ASSET_NAME_MAX = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The part of a StorageDriver these functions use. A StorageDriver from @sleid/storage fits it. */
export interface AssetBlobStorage {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

export type AssetErrorCode = 'type' | 'empty' | 'too-large' | 'mismatch' | 'limit' | 'not-found'

/** A refused image. `message` is written for the end user; `code` lets the HTTP layer pick a status. */
export class AssetError extends Error {
  readonly code: AssetErrorCode
  constructor(code: AssetErrorCode, message: string) {
    super(message)
    this.name = 'AssetError'
    this.code = code
  }
}

export interface UserAssetInfo {
  id: string
  name: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  sha256: string
}

export interface UserAssetSummary extends UserAssetInfo {
  createdAt: Date
}

export interface StoredDeckAsset {
  id: string
  url: string
  width: number | null
  height: number | null
}

/** Where copyAssetToDeck reads from: an image on a deck (readable by the caller), or one of the caller's library images. */
export type AssetSource = { kind: 'deck'; assetId: string } | { kind: 'library'; ownerId: string; id: string }

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** Refuses an image that is the wrong type, empty, too large, or whose content does not match its type. Returns the lower-case type. */
function checkImage(mime: string, bytes: Uint8Array, maxBytes: number): string {
  const type = mime.toLowerCase()
  if (!Object.hasOwn(ASSET_MIME_EXTENSIONS, type)) throw new AssetError('type', 'Use a PNG, JPEG, GIF, WebP or SVG image')
  if (bytes.byteLength === 0) throw new AssetError('empty', 'The file is empty')
  if (bytes.byteLength > maxBytes) throw new AssetError('too-large', `Images are limited to ${megabytes(maxBytes)}`)
  if (!bytesMatchMime(type, bytes)) throw new AssetError('mismatch', 'The file content does not match its type')
  return type
}

/**
 * Stores the bytes under a new asset id, then writes the row. If the row cannot be written, the bytes are removed
 * again, so no file is left without a row.
 */
async function putDeckAsset(
  db: Db,
  storage: AssetBlobStorage,
  input: { deckId: string; ownerId: string; mime: string; bytes: Uint8Array },
): Promise<{ id: string; width: number | null; height: number | null }> {
  const id = randomUUID()
  const size = imageSize(input.mime, input.bytes)
  await storage.put(id, input.bytes)
  try {
    await insertAsset(db, {
      id,
      deckId: input.deckId,
      ownerId: input.ownerId,
      mime: input.mime,
      bytes: input.bytes.byteLength,
      sha256: sha256Hex(input.bytes),
      width: size?.width ?? null,
      height: size?.height ?? null,
    })
  } catch (err) {
    await storage.delete(id).catch(() => undefined)
    throw err
  }
  return { id, width: size?.width ?? null, height: size?.height ?? null }
}

/**
 * Adds an image to the user's personal library. Throws AssetError when the image is refused or the library is full.
 * The count check and the insert are not one locked step, so two simultaneous uploads at the limit can both succeed.
 */
export async function createUserAsset(
  db: Db,
  storage: AssetBlobStorage,
  input: { ownerId: string; name: string; mime: string; bytes: Uint8Array },
): Promise<UserAssetInfo> {
  const type = checkImage(input.mime, input.bytes, USER_ASSET_MAX_BYTES)
  const [counted] = await db.select({ total: count() }).from(userAssets).where(eq(userAssets.ownerId, input.ownerId))
  if (Number(counted?.total ?? 0) >= USER_ASSET_MAX_COUNT) {
    throw new AssetError('limit', `Your image library is full (${USER_ASSET_MAX_COUNT} images). Delete an image before adding another.`)
  }
  const id = randomUUID()
  const storageKey = `library/${id}`
  const name = input.name.trim().slice(0, USER_ASSET_NAME_MAX) || 'Untitled image'
  const size = imageSize(type, input.bytes)
  const sha256 = sha256Hex(input.bytes)
  await storage.put(storageKey, input.bytes)
  try {
    await db.insert(userAssets).values({
      id,
      ownerId: input.ownerId,
      name,
      mime: type,
      bytes: input.bytes.byteLength,
      sha256,
      storageKey,
      width: size?.width ?? null,
      height: size?.height ?? null,
    })
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined)
    throw err
  }
  return { id, name, mime: type, bytes: input.bytes.byteLength, width: size?.width ?? null, height: size?.height ?? null, sha256 }
}

/** The user's library images, newest first. Never includes the storage key. */
export async function listUserAssets(db: Db, ownerId: string, limit = 100): Promise<UserAssetSummary[]> {
  const rows = await db
    .select({
      id: userAssets.id,
      name: userAssets.name,
      mime: userAssets.mime,
      bytes: userAssets.bytes,
      sha256: userAssets.sha256,
      width: userAssets.width,
      height: userAssets.height,
      createdAt: userAssets.createdAt,
    })
    .from(userAssets)
    .where(eq(userAssets.ownerId, ownerId))
    .orderBy(desc(userAssets.createdAt), desc(userAssets.id))
    .limit(limit)
  return rows
}

/** One library image, only when the caller owns it. */
export async function getUserAsset(db: Db, ownerId: string, id: string): Promise<UserAssetSummary | null> {
  if (!UUID.test(id)) return null
  const [row] = await db
    .select({
      id: userAssets.id,
      name: userAssets.name,
      mime: userAssets.mime,
      bytes: userAssets.bytes,
      sha256: userAssets.sha256,
      width: userAssets.width,
      height: userAssets.height,
      createdAt: userAssets.createdAt,
    })
    .from(userAssets)
    .where(and(eq(userAssets.id, id), eq(userAssets.ownerId, ownerId)))
    .limit(1)
  return row ?? null
}

/**
 * Removes one library image, only when the caller owns it. Decks that copied the image keep their own copy.
 * The row goes first, so a row never points at missing bytes. Returns false when there is no such image.
 */
export async function deleteUserAsset(db: Db, storage: AssetBlobStorage, ownerId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false
  const [removed] = await db
    .delete(userAssets)
    .where(and(eq(userAssets.id, id), eq(userAssets.ownerId, ownerId)))
    .returning({ storageKey: userAssets.storageKey })
  if (!removed) return false
  await storage.delete(removed.storageKey).catch(() => undefined)
  return true
}

/**
 * Stores an image on a deck and returns its asset URL. Throws AssetError when the image is refused.
 * Caller must have checked that `ownerId` may edit `deckId` (editor or owner), and that the deck exists.
 */
export async function storeDeckAsset(
  db: Db,
  storage: AssetBlobStorage,
  input: { deckId: string; ownerId: string; mime: string; bytes: Uint8Array; maxBytes?: number },
): Promise<StoredDeckAsset> {
  const type = checkImage(input.mime, input.bytes, input.maxBytes ?? DECK_ASSET_MAX_BYTES)
  const stored = await putDeckAsset(db, storage, { deckId: input.deckId, ownerId: input.ownerId, mime: type, bytes: input.bytes })
  return { id: stored.id, url: `/api/assets/${stored.id}`, width: stored.width, height: stored.height }
}

/**
 * Copies an image into a deck as a new deck asset, so the copy does not depend on its source. Throws AssetError
 * 'not-found' when the source is missing. Caller must have checked both sides:
 * - `ownerId` may edit `deckId` (editor or owner);
 * - for a deck source, `ownerId` may read that deck; for a library source, `source.ownerId` is the caller (the
 *   library lookup filters by owner, so another user's library image is not found).
 */
export async function copyAssetToDeck(
  db: Db,
  storage: AssetBlobStorage,
  input: { source: AssetSource; deckId: string; ownerId: string },
): Promise<StoredDeckAsset> {
  const source = await readSource(db, storage, input.source)
  const type = checkImage(source.mime, source.bytes, DECK_ASSET_MAX_BYTES)
  const stored = await putDeckAsset(db, storage, { deckId: input.deckId, ownerId: input.ownerId, mime: type, bytes: source.bytes })
  return { id: stored.id, url: `/api/assets/${stored.id}`, width: stored.width, height: stored.height }
}

async function readSource(db: Db, storage: AssetBlobStorage, source: AssetSource): Promise<{ mime: string; bytes: Uint8Array }> {
  const missing = () => new AssetError('not-found', 'That image could not be found.')
  if (source.kind === 'deck') {
    if (!UUID.test(source.assetId)) throw missing()
    // Deck assets are stored under their own id. Deleted decks are excluded by getAssetWithDeck.
    const row = await getAssetWithDeck(db, source.assetId)
    if (!row) throw missing()
    const bytes = await storage.get(row.id)
    if (!bytes) throw missing()
    return { mime: row.mime, bytes }
  }
  if (!UUID.test(source.id)) throw missing()
  const [row] = await db
    .select({ mime: userAssets.mime, storageKey: userAssets.storageKey })
    .from(userAssets)
    .where(and(eq(userAssets.id, source.id), eq(userAssets.ownerId, source.ownerId)))
    .limit(1)
  if (!row) throw missing()
  const bytes = await storage.get(row.storageKey)
  if (!bytes) throw missing()
  return { mime: row.mime, bytes }
}

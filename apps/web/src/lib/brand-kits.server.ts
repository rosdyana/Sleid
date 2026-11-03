// Brand kits (M9): palette, fonts, an optional logo, its placement, and an optional default template. Plain functions
// over the database, the storage driver and the collab internal API, so the tests can call them.
//
// Logo decision: the uploaded logo is a PNG, JPEG or SVG, checked by its first bytes. An SVG must be plain text with no
// script, event handler, foreignObject, embed or external entity (the same rule as a deck image, see bytesMatchMime).
// The kit keeps the bytes in storage under `brand-logos/`. Applying the kit copies them into the deck as one of the
// deck's own assets, so render and export read the deck's assets and never this kit.
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import {
  BrandTokensSchema,
  LogoPlacementSchema,
  themeFromBrandTokens,
  type BrandTokens,
  type Deck,
  type LogoPlacement,
} from '@sleid/model'
import {
  canEdit,
  deleteBrandKitRow,
  getBrandKitRow,
  getDeckRole,
  getTemplateRow,
  insertAsset,
  insertBrandKitRow,
  listBrandKitRows,
  deleteAssetRow,
  setBrandKitLogo,
  updateBrandKitRow,
  type BrandKitRow,
  type Db,
} from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'
import { bytesMatchMime, ASSET_MIME_EXTENSIONS } from './http-handlers.server.ts'
import { LibraryError } from './templates.server.ts'
import type { CollabInternalClient } from './collab-client.server.ts'

/** The largest logo accepted for a brand kit. Smaller than a deck image (10 MB): a logo is a small file. */
export const BRAND_LOGO_MAX_BYTES = 2 * 1024 * 1024
export const BRAND_LOGO_MIME = ['image/png', 'image/jpeg', 'image/svg+xml'] as const

export const DEFAULT_LOGO_PLACEMENT: LogoPlacement = { corner: 'tr', widthPct: 12, margin: 48, slides: 'all-but-title' }

export interface BrandDeps {
  db: Db
  storage: StorageDriver
  /** The collab internal API. Live deck changes go through it (null when collab is not configured). */
  collab: Pick<CollabInternalClient, 'applyOps'> | null
  /** Reads a deck (live when possible). Used to find the previous logo of a deck, so it can be removed. */
  readDeck: (deckId: string) => Promise<Deck>
  logger?: { warn: (message: string, err?: unknown) => void }
}

export interface BrandKitSummary {
  id: string
  name: string
  visibility: 'private' | 'instance'
  owned: boolean
  tokens: BrandTokens
  logoPlacement: LogoPlacement
  hasLogo: boolean
  defaultTemplateId: string | null
}

const BrandKitFields = {
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(['private', 'instance']),
  tokens: BrandTokensSchema,
  logoPlacement: LogoPlacementSchema,
  defaultTemplateId: z.uuid().nullable(),
}
// Defaults apply on create only. A patch leaves out what it does not name (see templates.server.ts).
export const BrandKitInputSchema = z.object({
  name: BrandKitFields.name,
  visibility: BrandKitFields.visibility.default('private'),
  tokens: BrandKitFields.tokens,
  logoPlacement: BrandKitFields.logoPlacement.optional(),
  defaultTemplateId: BrandKitFields.defaultTemplateId.optional(),
})
export const BrandKitPatchSchema = z.object(BrandKitFields).partial()
export type BrandKitInput = z.infer<typeof BrandKitInputSchema>

function summaryOf(row: BrandKitRow, userId: string): BrandKitSummary {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    owned: row.ownerId === userId,
    tokens: row.tokens,
    logoPlacement: row.logoPlacement,
    hasLogo: Boolean(row.logoKey),
    defaultTemplateId: row.defaultTemplateId,
  }
}

async function readableKit(deps: Pick<BrandDeps, 'db'>, userId: string, kitId: string): Promise<BrandKitRow> {
  if (!z.uuid().safeParse(kitId).success) throw new LibraryError('Brand kit not found', 404)
  const row = await getBrandKitRow(deps.db, kitId)
  if (!row || (row.ownerId !== userId && row.visibility !== 'instance')) throw new LibraryError('Brand kit not found', 404)
  return row
}

async function ownedKit(deps: BrandDeps, userId: string, kitId: string): Promise<BrandKitRow> {
  const row = await readableKit(deps, userId, kitId)
  if (row.ownerId !== userId) throw new LibraryError('Only the owner can change this brand kit.', 403)
  return row
}

export async function listBrandKitsFor(deps: BrandDeps, userId: string): Promise<BrandKitSummary[]> {
  return (await listBrandKitRows(deps.db, userId)).map((row) => summaryOf(row, userId))
}

export async function getBrandKitFor(deps: BrandDeps, userId: string, kitId: string): Promise<BrandKitSummary> {
  return summaryOf(await readableKit(deps, userId, kitId), userId)
}

/** A default template must be one the caller can read (a user template). Built-in templates have no row, so they cannot be a default. */
async function assertReadableTemplate(deps: BrandDeps, userId: string, templateId: string): Promise<void> {
  const row = await getTemplateRow(deps.db, templateId)
  if (!row || (row.ownerId !== userId && row.visibility !== 'instance')) throw new LibraryError('Template not found', 404)
}

export async function createBrandKit(deps: BrandDeps, userId: string, input: z.input<typeof BrandKitInputSchema>): Promise<{ id: string }> {
  const parsed = BrandKitInputSchema.parse(input)
  if (parsed.defaultTemplateId) await assertReadableTemplate(deps, userId, parsed.defaultTemplateId)
  const id = randomUUID()
  await insertBrandKitRow(deps.db, {
    id,
    ownerId: userId,
    name: parsed.name,
    visibility: parsed.visibility,
    tokens: parsed.tokens,
    logoPlacement: parsed.logoPlacement ?? DEFAULT_LOGO_PLACEMENT,
    defaultTemplateId: parsed.defaultTemplateId ?? null,
  })
  return { id }
}

export async function updateBrandKit(deps: BrandDeps, userId: string, kitId: string, patch: Partial<BrandKitInput>): Promise<void> {
  await ownedKit(deps, userId, kitId)
  const parsed = BrandKitPatchSchema.parse(patch)
  if (parsed.defaultTemplateId) await assertReadableTemplate(deps, userId, parsed.defaultTemplateId)
  const ok = await updateBrandKitRow(deps.db, userId, kitId, {
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.visibility !== undefined ? { visibility: parsed.visibility } : {}),
    ...(parsed.tokens !== undefined ? { tokens: parsed.tokens } : {}),
    ...(parsed.logoPlacement !== undefined ? { logoPlacement: parsed.logoPlacement } : {}),
    ...(parsed.defaultTemplateId !== undefined ? { defaultTemplateId: parsed.defaultTemplateId } : {}),
  })
  if (!ok) throw new LibraryError('Brand kit not found', 404)
}

/** Deletes the kit and its logo file. Decks that have the kit applied keep their theme and logo (they hold copies). */
export async function deleteBrandKit(deps: BrandDeps, userId: string, kitId: string): Promise<void> {
  const row = await ownedKit(deps, userId, kitId)
  const ok = await deleteBrandKitRow(deps.db, userId, kitId)
  if (!ok) throw new LibraryError('Brand kit not found', 404)
  if (row.logoKey) await deps.storage.delete(row.logoKey).catch(() => undefined)
}

/** Checks a logo's bytes against the declared type and the size cap. Returns the normalised mime. */
export function checkLogoBytes(mime: string, bytes: Uint8Array): void {
  if (!(BRAND_LOGO_MIME as readonly string[]).includes(mime)) throw new LibraryError('A logo must be a PNG, JPEG or SVG image.', 415)
  if (bytes.byteLength === 0) throw new LibraryError('The logo file is empty.', 400)
  if (bytes.byteLength > BRAND_LOGO_MAX_BYTES) throw new LibraryError('The logo is larger than 2 MB.', 413)
  let ok = false
  try {
    ok = bytesMatchMime(mime, bytes)
  } catch {
    ok = false
  }
  if (!ok) throw new LibraryError('The file is not a valid logo of the type it claims to be.', 415)
}

/** Stores a new logo for the kit, and removes the old one. Owner only. */
export async function uploadBrandLogo(deps: BrandDeps, userId: string, kitId: string, input: { mime: string; bytes: Uint8Array }): Promise<void> {
  const row = await ownedKit(deps, userId, kitId)
  checkLogoBytes(input.mime, input.bytes)
  const key = `brand-logos/${kitId}-${randomUUID()}.${ASSET_MIME_EXTENSIONS[input.mime] ?? 'bin'}`
  await deps.storage.put(key, input.bytes)
  const ok = await setBrandKitLogo(deps.db, userId, kitId, {
    key,
    mime: input.mime,
    bytes: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
  })
  if (!ok) {
    await deps.storage.delete(key).catch(() => undefined)
    throw new LibraryError('Brand kit not found', 404)
  }
  if (row.logoKey) await deps.storage.delete(row.logoKey).catch(() => undefined)
}

export async function removeBrandLogo(deps: BrandDeps, userId: string, kitId: string): Promise<void> {
  const row = await ownedKit(deps, userId, kitId)
  await setBrandKitLogo(deps.db, userId, kitId, null)
  if (row.logoKey) await deps.storage.delete(row.logoKey).catch(() => undefined)
}

/**
 * GET /api/brand-kits/:id/logo. A session is needed. The logo is readable by whoever can read the kit (its owner, or
 * everyone when the kit is on this server, the same rule as the kit itself). Anyone else, a kit with no logo and a
 * missing file are all "not found".
 */
export async function handleBrandLogo(kitId: string, deps: { db: Db; storage: StorageDriver; userId: string | null }): Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!deps.userId) return json(401, { error: 'Sign in to see this logo.' })
  let row: BrandKitRow
  try {
    row = await readableKit(deps, deps.userId, kitId)
  } catch (err) {
    if (err instanceof LibraryError && err.status === 404) return json(404, { error: 'Not found' })
    throw err
  }
  if (!row.logoKey || !row.logoMime) return json(404, { error: 'Not found' })
  const bytes = await deps.storage.get(row.logoKey)
  if (!bytes) return json(404, { error: 'Not found' })
  const headers: Record<string, string> = {
    'content-type': row.logoMime,
    'content-length': String(bytes.byteLength),
    'x-content-type-options': 'nosniff',
    // The preview in the kit editor reads this after a logo is replaced, so it must not be cached for long.
    'cache-control': 'private, no-cache',
  }
  // An SVG opened on its own runs in a sandbox: no scripts, no same-origin access.
  if (row.logoMime === 'image/svg+xml') headers['content-security-policy'] = 'sandbox'
  return new Response(new Uint8Array(bytes), { status: 200, headers })
}

const ASSET_URL = /^\/api\/assets\/([0-9a-f-]{36})$/i

/** The asset id a deck's brand logo points at, when it points at one. */
function logoAssetId(deck: Deck): string | null {
  const src = deck.brand?.logo?.src ?? ''
  const match = ASSET_URL.exec(src)
  return match ? match[1]!.toLowerCase() : null
}

/** Removes a deck asset (row and file). Failures are logged, not raised: the deck change has already been made. */
async function removeDeckAsset(deps: BrandDeps, assetId: string): Promise<void> {
  try {
    await deleteAssetRow(deps.db, assetId)
    await deps.storage.delete(assetId)
  } catch (err) {
    deps.logger?.warn('old brand logo was not removed', err)
  }
}

async function requireEditorOn(deps: BrandDeps, userId: string, deckId: string): Promise<void> {
  const role = await getDeckRole(deps.db, userId, deckId)
  if (!role) throw new LibraryError('Deck not found', 404)
  if (!canEdit(role)) throw new LibraryError('You need editor access to this deck to change its brand.', 403)
}

async function sendOps(deps: BrandDeps, deckId: string, userId: string, ops: unknown[], actor: string): Promise<void> {
  if (!deps.collab) throw new LibraryError('The editor service is not running, so the deck was not changed. Try again in a moment.', 503)
  try {
    await deps.collab.applyOps(deckId, actor, ops, userId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new LibraryError(`The deck was not changed: ${message}`, 422)
  }
}

/**
 * Applies a kit to a deck (editor or owner of the deck). The theme is replaced by the kit's theme; the logo is copied into
 * the deck as its own asset and placed by the kit's placement. The change goes through the live document, so open
 * editors see it, and Undo works for them.
 */
export async function applyBrandKit(
  deps: BrandDeps,
  userId: string,
  deckId: string,
  kitId: string,
  actor = 'brand-kit',
): Promise<{ theme: string; logo: boolean }> {
  await requireEditorOn(deps, userId, deckId)
  const kit = await readableKit(deps, userId, kitId)
  const theme = themeFromBrandTokens(kit.name, kit.tokens)

  let newAssetId: string | null = null
  let logo: { src: string; placement: LogoPlacement } | null = null
  try {
    if (kit.logoKey && kit.logoMime && kit.logoSha256 && kit.logoBytes !== null) {
      const bytes = await deps.storage.get(kit.logoKey)
      if (!bytes) throw new LibraryError('The logo file of this brand kit is missing. Upload the logo again.', 409)
      newAssetId = randomUUID()
      await deps.storage.put(newAssetId, bytes)
      await insertAsset(deps.db, {
        id: newAssetId,
        deckId,
        ownerId: userId,
        mime: kit.logoMime,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      logo = { src: `/api/assets/${newAssetId}`, placement: kit.logoPlacement }
    }
    const before = await deps.readDeck(deckId)
    const op = { op: 'setBrandKit', brandKitId: kit.id, theme, ...(logo ? { logo } : {}) }
    await sendOps(deps, deckId, userId, [op], actor)
    const previous = logoAssetId(before)
    if (previous && previous !== newAssetId) await removeDeckAsset(deps, previous)
    return { theme: theme.name, logo: Boolean(logo) }
  } catch (err) {
    if (newAssetId) await removeDeckAsset(deps, newAssetId)
    throw err
  }
}

/** Removes the kit from a deck: the theme stays, the logo is removed. Editor or owner of the deck. */
export async function removeBrandKit(deps: BrandDeps, userId: string, deckId: string, actor = 'brand-kit'): Promise<void> {
  await requireEditorOn(deps, userId, deckId)
  const before = await deps.readDeck(deckId)
  await sendOps(deps, deckId, userId, [{ op: 'setBrandKit', brandKitId: null }], actor)
  const previous = logoAssetId(before)
  if (previous) await removeDeckAsset(deps, previous)
}

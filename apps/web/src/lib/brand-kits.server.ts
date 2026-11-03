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
  type BrandLogoVariant,
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

/** The footer line's length cap (characters, after trimming). */
export const FOOTER_TEXT_MAX = 200

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
  /** A logo for dark slides is saved (M11). */
  hasDarkLogo: boolean
  /** The footer line, or null when the kit has none (M11). */
  footerText: string | null
  defaultTemplateId: string | null
}

/** The footer line: trimmed, at most 200 characters. Empty (or missing) means none, stored as null. */
const FooterText = z
  .string()
  .trim()
  .max(FOOTER_TEXT_MAX)
  .nullable()
  .transform((value) => (value === null || value === '' ? null : value))

const BrandKitFields = {
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(['private', 'instance']),
  tokens: BrandTokensSchema,
  logoPlacement: LogoPlacementSchema,
  defaultTemplateId: z.uuid().nullable(),
  footerText: FooterText,
}
export const BrandKitInputSchema = z.object({
  name: BrandKitFields.name,
  visibility: BrandKitFields.visibility.default('private'),
  tokens: BrandKitFields.tokens,
  logoPlacement: BrandKitFields.logoPlacement.optional(),
  defaultTemplateId: BrandKitFields.defaultTemplateId.optional(),
  footerText: BrandKitFields.footerText.optional(),
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
    hasDarkLogo: Boolean(row.logoDarkKey),
    footerText: row.footerText ?? null,
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
    footerText: parsed.footerText ?? null,
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
    ...(parsed.footerText !== undefined ? { footerText: parsed.footerText } : {}),
  })
  if (!ok) throw new LibraryError('Brand kit not found', 404)
}

/** Deletes the kit and its logo files. Decks that have the kit applied keep their theme and logo (they hold copies). */
export async function deleteBrandKit(deps: BrandDeps, userId: string, kitId: string): Promise<void> {
  const row = await ownedKit(deps, userId, kitId)
  const ok = await deleteBrandKitRow(deps.db, userId, kitId)
  if (!ok) throw new LibraryError('Brand kit not found', 404)
  if (row.logoKey) await deps.storage.delete(row.logoKey).catch(() => undefined)
  if (row.logoDarkKey) await deps.storage.delete(row.logoDarkKey).catch(() => undefined)
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

/**
 * Reads the `variant` query value of a logo request. Missing or `light` is the light logo, `dark` is the logo for dark
 * slides, anything else is null (refused by the caller).
 */
export function logoVariantFrom(value: string | null): BrandLogoVariant | null {
  if (value === null || value === '' || value === 'light') return 'light'
  if (value === 'dark') return 'dark'
  return null
}

/** Stores a new logo for the kit (the light one, or the dark one), and removes the old one of that variant. Owner only. */
export async function uploadBrandLogo(
  deps: BrandDeps,
  userId: string,
  kitId: string,
  input: { mime: string; bytes: Uint8Array; variant?: BrandLogoVariant },
): Promise<void> {
  const variant = input.variant ?? 'light'
  const row = await ownedKit(deps, userId, kitId)
  checkLogoBytes(input.mime, input.bytes)
  const key = `brand-logos/${kitId}-${randomUUID()}.${ASSET_MIME_EXTENSIONS[input.mime] ?? 'bin'}`
  await deps.storage.put(key, input.bytes)
  const ok = await setBrandKitLogo(
    deps.db,
    userId,
    kitId,
    {
      key,
      mime: input.mime,
      bytes: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
    },
    variant,
  )
  if (!ok) {
    await deps.storage.delete(key).catch(() => undefined)
    throw new LibraryError('Brand kit not found', 404)
  }
  const previous = variant === 'dark' ? row.logoDarkKey : row.logoKey
  if (previous) await deps.storage.delete(previous).catch(() => undefined)
}

export async function removeBrandLogo(deps: BrandDeps, userId: string, kitId: string, variant: BrandLogoVariant = 'light'): Promise<void> {
  const row = await ownedKit(deps, userId, kitId)
  await setBrandKitLogo(deps.db, userId, kitId, null, variant)
  const previous = variant === 'dark' ? row.logoDarkKey : row.logoKey
  if (previous) await deps.storage.delete(previous).catch(() => undefined)
}

/**
 * GET /api/brand-kits/:id/logo. A session is needed. The logo is readable by whoever can read the kit (its owner, or
 * everyone when the kit is on this server, the same rule as the kit itself). Anyone else, a kit with no logo of that
 * variant and a missing file are all "not found".
 */
export async function handleBrandLogo(
  kitId: string,
  deps: { db: Db; storage: StorageDriver; userId: string | null },
  variant: BrandLogoVariant = 'light',
): Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!deps.userId) return json(401, { error: 'Sign in to see this logo.' })
  let row: BrandKitRow
  try {
    row = await readableKit(deps, deps.userId, kitId)
  } catch (err) {
    if (err instanceof LibraryError && err.status === 404) return json(404, { error: 'Not found' })
    throw err
  }
  const logoKey = variant === 'dark' ? row.logoDarkKey : row.logoKey
  const logoMime = variant === 'dark' ? row.logoDarkMime : row.logoMime
  if (!logoKey || !logoMime) return json(404, { error: 'Not found' })
  const bytes = await deps.storage.get(logoKey)
  if (!bytes) return json(404, { error: 'Not found' })
  const headers: Record<string, string> = {
    'content-type': logoMime,
    'content-length': String(bytes.byteLength),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache',
  }
  if (logoMime === 'image/svg+xml') headers['content-security-policy'] = 'sandbox'
  return new Response(new Uint8Array(bytes), { status: 200, headers })
}

const ASSET_URL = /^\/api\/assets\/([0-9a-f-]{36})$/i

/** The asset id an asset url points at, when it points at one. */
function assetIdOf(src: string | undefined): string | null {
  const match = ASSET_URL.exec(src ?? '')
  return match ? match[1]!.toLowerCase() : null
}

/** The asset id a deck's brand logo points at, when it points at one. */
function logoAssetId(deck: Deck): string | null {
  return assetIdOf(deck.brand?.logo?.src)
}

/** Every deck asset that the deck's brand logo and its theme chrome logos point at. */
function brandAssetIds(deck: Deck): string[] {
  const chrome = deck.theme.components?.chrome
  return [logoAssetId(deck), assetIdOf(chrome?.logoLight), assetIdOf(chrome?.logoDark)].filter((id): id is string => id !== null)
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
 * Copies one of the kit's logo files into the deck as its own asset. The new asset id is pushed to `created` before
 * the row is written, so a failure later can remove it.
 */
async function copyLogoIntoDeck(
  deps: BrandDeps,
  userId: string,
  deckId: string,
  logo: { key: string; mime: string },
  created: string[],
): Promise<string> {
  const bytes = await deps.storage.get(logo.key)
  if (!bytes) throw new LibraryError('The logo file of this brand kit is missing. Upload the logo again.', 409)
  const assetId = randomUUID()
  created.push(assetId)
  await deps.storage.put(assetId, bytes)
  await insertAsset(deps.db, {
    id: assetId,
    deckId,
    ownerId: userId,
    mime: logo.mime,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  return `/api/assets/${assetId}`
}

/**
 * Applies a kit to a deck (editor or owner of the deck). The theme is replaced by the kit's theme; the light logo is
 * copied into the deck as its own asset and placed by the kit's placement (deck.brand.logo). The dark logo and the
 * footer text go into the theme's chrome (theme.components.chrome), with the dark logo copied the same way. The change
 * goes through the live document, so open editors see it, and Undo works for them.
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

  const created: string[] = []
  try {
    let logo: { src: string; placement: LogoPlacement } | null = null
    const chrome: { logoLight?: string; logoDark?: string; footerText?: string } = {}
    if (kit.logoKey && kit.logoMime && kit.logoSha256 && kit.logoBytes !== null) {
      const src = await copyLogoIntoDeck(deps, userId, deckId, { key: kit.logoKey, mime: kit.logoMime }, created)
      logo = { src, placement: kit.logoPlacement }
      chrome.logoLight = src
    }
    if (kit.logoDarkKey && kit.logoDarkMime && kit.logoDarkSha256 && kit.logoDarkBytes !== null) {
      chrome.logoDark = await copyLogoIntoDeck(deps, userId, deckId, { key: kit.logoDarkKey, mime: kit.logoDarkMime }, created)
    }
    if (kit.footerText) chrome.footerText = kit.footerText

    const themed = Object.keys(chrome).length > 0 ? { ...theme, components: { chrome } } : theme
    const before = await deps.readDeck(deckId)
    const op = { op: 'setBrandKit', brandKitId: kit.id, theme: themed, ...(logo ? { logo } : {}) }
    await sendOps(deps, deckId, userId, [op], actor)
    // The logo assets of the previous kit that this change no longer uses are removed.
    const kept = new Set(created)
    for (const previous of brandAssetIds(before)) {
      if (!kept.has(previous)) await removeDeckAsset(deps, previous)
    }
    return { theme: theme.name, logo: Boolean(logo) }
  } catch (err) {
    for (const assetId of created) await removeDeckAsset(deps, assetId)
    throw err
  }
}

/**
 * Removes the kit from a deck: the theme stays, the logos are removed (the brand logo and the theme's chrome logos, in
 * the same change). The footer text stays. Editor or owner of the deck.
 */
export async function removeBrandKit(deps: BrandDeps, userId: string, deckId: string, actor = 'brand-kit'): Promise<void> {
  await requireEditorOn(deps, userId, deckId)
  const before = await deps.readDeck(deckId)
  const ops: unknown[] = [{ op: 'setBrandKit', brandKitId: null }]
  const chrome = before.theme.components?.chrome
  if (chrome?.logoLight || chrome?.logoDark) {
    // Without a footer left, the whole components block goes (null removes it); with one, only the logos are cleared.
    const components = chrome.footerText ? { chrome: { logoLight: null, logoDark: null } } : null
    ops.push({ op: 'setTheme', theme: { components } })
  }
  await sendOps(deps, deckId, userId, ops, actor)
  for (const assetId of brandAssetIds(before)) await removeDeckAsset(deps, assetId)
}

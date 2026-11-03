// Templates (M9): built-in templates from code, and user templates in the database. Plain functions over the database,
// the storage driver, the collab service (for live reads) and the job queue, so the tests can call them.
// Server functions (templates.functions.ts) are thin wrappers.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  BUILT_IN_TEMPLATES,
  builtInTemplateDeck,
  deckFromBuiltInTemplate,
  isBuiltInTemplateId,
  DeckSchema,
  withFreshIds,
  type Deck,
} from '@sleid/model'
import {
  createImportedDeck,
  canEdit,
  deleteTemplateRow,
  getAssetWithDeck,
  getDeckRole,
  getTemplateRow,
  insertTemplateRow,
  listTemplateRows,
  updateTemplateRow,
  type Db,
  type TemplateRow,
} from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'
import { collectAssetIds, rewriteAssetRefs } from '@sleid/render'

/** Largest total of embedded image bytes in one template. Each image is at most the asset cap (10 MB). */
export const TEMPLATE_IMAGE_TOTAL_BYTES = 30 * 1024 * 1024
const EMBEDDABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export class LibraryError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'LibraryError'
    this.status = status
  }
}

export interface TemplateDeps {
  db: Db
  /** Holds template thumbnails and, through the asset store, deck images. */
  storage: StorageDriver
  /** Reads a deck: the live document when the collab service is up, the saved state otherwise. */
  readDeck: (deckId: string) => Promise<Deck>
  /** Asks the worker to render a thumbnail. Best effort: a failure leaves the template without one. */
  enqueueThumbnail?: (templateId: string) => Promise<void>
  logger?: { warn: (message: string, err?: unknown) => void }
}

export interface TemplateSummary {
  id: string
  name: string
  description: string
  category: string
  visibility: 'builtin' | 'private' | 'instance'
  builtIn: boolean
  /** True when the caller owns it (only owners can change or delete). */
  owned: boolean
  slideCount: number
  themeName: string
  hasThumbnail: boolean
}

export interface TemplateDetail {
  summary: TemplateSummary
  deck: Deck
}

// Defaults apply on create only. A patch is the same fields without defaults, so a missing field is left alone
// (zod's partial() would otherwise keep the defaults and overwrite, for example, a visibility).
const TemplateFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000),
  category: z.enum(['business', 'education', 'general']),
  visibility: z.enum(['private', 'instance']),
}
export const TemplateMetaSchema = z.object({
  name: TemplateFields.name,
  description: TemplateFields.description.default(''),
  category: TemplateFields.category.default('general'),
  visibility: TemplateFields.visibility.default('private'),
})
export const TemplatePatchSchema = z.object(TemplateFields).partial()
export type TemplateMeta = z.infer<typeof TemplateMetaSchema>

function summaryOfRow(row: TemplateRow, userId: string): TemplateSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    visibility: row.visibility,
    builtIn: false,
    owned: row.ownerId === userId,
    slideCount: row.slideCount,
    themeName: row.themeName,
    hasThumbnail: Boolean(row.thumbnailKey),
  }
}

/** The built-in templates first, then the user's own and the instance-visible ones. */
export async function listTemplatesFor(deps: TemplateDeps, userId: string): Promise<TemplateSummary[]> {
  const builtIn: TemplateSummary[] = BUILT_IN_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    visibility: 'builtin',
    builtIn: true,
    owned: false,
    slideCount: t.slideCount,
    themeName: t.themeName,
    hasThumbnail: false,
  }))
  const rows = await listTemplateRows(deps.db, userId)
  return [...builtIn, ...rows.map((row) => summaryOfRow(row, userId))]
}

/** One template the caller may read: built-in, owned by the caller, or instance-visible. Otherwise not found. */
export async function getTemplateFor(deps: TemplateDeps, userId: string, templateId: string): Promise<TemplateDetail> {
  if (isBuiltInTemplateId(templateId)) {
    const info = BUILT_IN_TEMPLATES.find((t) => t.id === templateId)
    const deck = builtInTemplateDeck(templateId)
    if (!info || !deck) throw new LibraryError('Template not found', 404)
    return {
      summary: { id: info.id, name: info.name, description: info.description, category: info.category, visibility: 'builtin', builtIn: true, owned: false, slideCount: info.slideCount, themeName: info.themeName, hasThumbnail: false },
      deck,
    }
  }
  const row = await readableRow(deps, userId, templateId)
  return { summary: summaryOfRow(row, userId), deck: DeckSchema.parse(row.deck) }
}

async function readableRow(deps: TemplateDeps, userId: string, templateId: string): Promise<TemplateRow> {
  if (!z.uuid().safeParse(templateId).success) throw new LibraryError('Template not found', 404)
  const row = await getTemplateRow(deps.db, templateId)
  if (!row || (row.ownerId !== userId && row.visibility !== 'instance')) throw new LibraryError('Template not found', 404)
  return row
}

async function ownedRow(deps: TemplateDeps, userId: string, templateId: string): Promise<TemplateRow> {
  if (isBuiltInTemplateId(templateId)) throw new LibraryError('Built-in templates cannot be changed. Save a copy from a deck instead.', 403)
  const row = await readableRow(deps, userId, templateId)
  if (row.ownerId !== userId) throw new LibraryError('Only the owner can change this template.', 403)
  return row
}

/**
 * Saves a template from a deck the caller can edit. Images are copied into the template as data URLs, so the
 * template does not depend on the deck's assets. The brand reference is left out: a template carries its theme and
 * slides, not a brand kit. The thumbnail is queued after the row is written.
 */
export async function saveTemplateFromDeck(
  deps: TemplateDeps,
  userId: string,
  input: { deckId: string } & z.input<typeof TemplateMetaSchema>,
): Promise<{ id: string }> {
  const meta = TemplateMetaSchema.parse(input)
  const role = await getDeckRole(deps.db, userId, input.deckId)
  if (!role) throw new LibraryError('Deck not found', 404)
  if (!canEdit(role)) throw new LibraryError('You need editor access to this deck to save a template from it.', 403)

  const source = await deps.readDeck(input.deckId)
  const { brand: _brand, ...withoutBrand } = source
  const embedded = await embedImages(deps, input.deckId, withoutBrand)
  const deck = DeckSchema.parse({ ...embedded, id: randomUUID() })

  const id = randomUUID()
  await insertTemplateRow(deps.db, {
    id,
    ownerId: userId,
    name: meta.name,
    description: meta.description,
    category: meta.category,
    visibility: meta.visibility,
    deck,
    themeName: deck.theme.name,
    slideCount: deck.slides.length,
  })
  await queueThumbnail(deps, id)
  return { id }
}

const MAX_TEMPLATE_IMAGES = 200

/** Replaces every asset URL in the deck with a data URL of the same bytes. Only images of this deck are read. */
async function embedImages(deps: TemplateDeps, deckId: string, deck: Deck): Promise<Deck> {
  const ids = collectAssetIds(deck)
  if (ids.length > MAX_TEMPLATE_IMAGES) throw new LibraryError(`A template can hold at most ${MAX_TEMPLATE_IMAGES} images.`)
  const urls = new Map<string, string>()
  let total = 0
  for (const id of ids) {
    const row = await getAssetWithDeck(deps.db, id)
    if (!row || row.deckId !== deckId) throw new LibraryError('The deck refers to an image that is not in it. Remove the image and try again.')
    if (!EMBEDDABLE_MIME.has(row.mime)) {
      throw new LibraryError(`An image of type ${row.mime} cannot be saved in a template. Use PNG, JPEG, GIF or WebP.`)
    }
    const bytes = await deps.storage.get(id)
    if (!bytes) throw new LibraryError('An image in the deck is missing from storage.', 500)
    total += bytes.byteLength
    if (total > TEMPLATE_IMAGE_TOTAL_BYTES) throw new LibraryError('The images in this deck are too large for a template (30 MB in all).')
    urls.set(id, `data:${row.mime};base64,${Buffer.from(bytes).toString('base64')}`)
  }
  return rewriteAssetRefs(deck, (id) => {
    const url = urls.get(id)
    if (!url) throw new LibraryError('An image in the deck is missing from storage.', 500)
    return url
  })
}

async function queueThumbnail(deps: TemplateDeps, templateId: string): Promise<void> {
  if (!deps.enqueueThumbnail) return
  try {
    await deps.enqueueThumbnail(templateId)
  } catch (err) {
    deps.logger?.warn('template thumbnail was not queued', err)
  }
}

/** Changes a template's name, description, category or visibility. Owner only. */
export async function updateTemplateMeta(deps: TemplateDeps, userId: string, templateId: string, patch: Partial<TemplateMeta>): Promise<void> {
  await ownedRow(deps, userId, templateId)
  const parsed = TemplatePatchSchema.parse(patch)
  const ok = await updateTemplateRow(deps.db, userId, templateId, parsed)
  if (!ok) throw new LibraryError('Template not found', 404)
}

/** Deletes a template and its thumbnail. Owner only. Brand kits that defaulted to it keep working. */
export async function deleteTemplate(deps: TemplateDeps, userId: string, templateId: string): Promise<void> {
  const row = await ownedRow(deps, userId, templateId)
  const ok = await deleteTemplateRow(deps.db, userId, templateId)
  if (!ok) throw new LibraryError('Template not found', 404)
  if (row.thumbnailKey) await deps.storage.delete(row.thumbnailKey).catch(() => undefined)
}

/**
 * A new deck from a template: fresh ids for every slide, element and section, the same owner membership and first
 * snapshot as an import (createImportedDeck). Embedded images become the new deck's own assets.
 */
export async function newDeckFromTemplate(
  deps: TemplateDeps,
  userId: string,
  input: { templateId: string; title?: string },
): Promise<{ deckId: string; droppedImages: number }> {
  let deck: Deck | null
  if (isBuiltInTemplateId(input.templateId)) {
    deck = deckFromBuiltInTemplate(input.templateId, input.title)
    if (!deck) throw new LibraryError('Template not found', 404)
  } else {
    const row = await readableRow(deps, userId, input.templateId)
    const fresh = withFreshIds(DeckSchema.parse(row.deck))
    const { brand: _brand, ...rest } = fresh
    deck = { ...rest, title: input.title?.trim() || row.name }
  }
  const created = await createImportedDeck(deps.db, {
    userId,
    deck,
    storeAsset: (id, bytes) => deps.storage.put(id, bytes),
    deleteAsset: (id) => deps.storage.delete(id),
  })
  return { deckId: created.id, droppedImages: created.droppedImages }
}

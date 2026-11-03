// Templates and brand kits (M9): plain queries. Authorisation (who may read or write) is decided by the web app
// (apps/web/src/lib/templates.server.ts and brand-kits.server.ts). The write functions here also filter by owner,
// so a write from any other path still cannot touch someone else's row.
import { and, desc, eq, or } from 'drizzle-orm'
import type { Deck, BrandTokens, LogoPlacement } from '@sleid/model'
import type { Db } from './client.ts'
import { brandKits, templates, type BrandKitRow, type TemplateRow } from './schema/index.ts'

export type LibraryVisibility = 'private' | 'instance'

/** Templates the user owns, plus every instance-visible template. */
export async function listTemplateRows(db: Db, userId: string): Promise<TemplateRow[]> {
  return db
    .select()
    .from(templates)
    .where(or(eq(templates.ownerId, userId), eq(templates.visibility, 'instance')))
    .orderBy(desc(templates.createdAt))
}

export async function getTemplateRow(db: Db, id: string): Promise<TemplateRow | null> {
  const [row] = await db.select().from(templates).where(eq(templates.id, id)).limit(1)
  return row ?? null
}

export interface NewTemplateRow {
  id: string
  ownerId: string
  name: string
  description: string
  category: string
  visibility: LibraryVisibility
  deck: Deck
  themeName: string
  slideCount: number
}

export async function insertTemplateRow(db: Db, row: NewTemplateRow): Promise<void> {
  await db.insert(templates).values(row)
}

export type TemplatePatch = Partial<Pick<NewTemplateRow, 'name' | 'description' | 'category' | 'visibility' | 'deck' | 'themeName' | 'slideCount'>>

/** Updates the owner's template. False when there is no such template for this owner. */
export async function updateTemplateRow(db: Db, ownerId: string, id: string, patch: TemplatePatch): Promise<boolean> {
  const rows = await db
    .update(templates)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(templates.id, id), eq(templates.ownerId, ownerId)))
    .returning({ id: templates.id })
  return rows.length > 0
}

/** Removes the owner's template. Brand kits that defaulted to it keep working (the reference is cleared). */
export async function deleteTemplateRow(db: Db, ownerId: string, id: string): Promise<boolean> {
  const rows = await db.delete(templates).where(and(eq(templates.id, id), eq(templates.ownerId, ownerId))).returning({ id: templates.id })
  return rows.length > 0
}

export async function setTemplateThumbnail(db: Db, id: string, key: string): Promise<void> {
  await db.update(templates).set({ thumbnailKey: key, updatedAt: new Date() }).where(eq(templates.id, id))
}

/** Brand kits the user owns, plus every instance-visible kit. */
export async function listBrandKitRows(db: Db, userId: string): Promise<BrandKitRow[]> {
  return db
    .select()
    .from(brandKits)
    .where(or(eq(brandKits.ownerId, userId), eq(brandKits.visibility, 'instance')))
    .orderBy(desc(brandKits.createdAt))
}

export async function getBrandKitRow(db: Db, id: string): Promise<BrandKitRow | null> {
  const [row] = await db.select().from(brandKits).where(eq(brandKits.id, id)).limit(1)
  return row ?? null
}

export interface NewBrandKitRow {
  id: string
  ownerId: string
  name: string
  visibility: LibraryVisibility
  tokens: BrandTokens
  logoPlacement: LogoPlacement
  defaultTemplateId: string | null
}

export async function insertBrandKitRow(db: Db, row: NewBrandKitRow): Promise<void> {
  await db.insert(brandKits).values(row)
}

export type BrandKitPatch = Partial<Pick<NewBrandKitRow, 'name' | 'visibility' | 'tokens' | 'logoPlacement' | 'defaultTemplateId'>>

export async function updateBrandKitRow(db: Db, ownerId: string, id: string, patch: BrandKitPatch): Promise<boolean> {
  const rows = await db
    .update(brandKits)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(brandKits.id, id), eq(brandKits.ownerId, ownerId)))
    .returning({ id: brandKits.id })
  return rows.length > 0
}

export interface BrandLogoRecord {
  key: string
  mime: string
  bytes: number
  sha256: string
}

/** Records the kit's logo (or clears it with null). The bytes themselves are in storage under `key`. */
export async function setBrandKitLogo(db: Db, ownerId: string, id: string, logo: BrandLogoRecord | null): Promise<boolean> {
  const rows = await db
    .update(brandKits)
    .set({
      logoKey: logo?.key ?? null,
      logoMime: logo?.mime ?? null,
      logoBytes: logo?.bytes ?? null,
      logoSha256: logo?.sha256 ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(brandKits.id, id), eq(brandKits.ownerId, ownerId)))
    .returning({ id: brandKits.id })
  return rows.length > 0
}

export async function deleteBrandKitRow(db: Db, ownerId: string, id: string): Promise<boolean> {
  const rows = await db.delete(brandKits).where(and(eq(brandKits.id, id), eq(brandKits.ownerId, ownerId))).returning({ id: brandKits.id })
  return rows.length > 0
}

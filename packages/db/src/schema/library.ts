import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { Deck, LogoPlacement, BrandTokens } from '@sleid/model'
import { user } from './auth.ts'

/** Who can see a template or brand kit. Only the owner can change or delete it. */
export const libraryVisibility = pgEnum('library_visibility', ['private', 'instance'])

/**
 * A user template (M9): a deck's theme and slides, with its images embedded as data URLs, so it does not depend on
 * the deck it came from. The thumbnail is a PNG in storage under `thumbnailKey`, filled in by the worker.
 */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default('general'),
    visibility: libraryVisibility('visibility').notNull().default('private'),
    /** The deck: theme, slides and sections. No brand reference and no deck id. */
    deck: jsonb('deck').$type<Deck>().notNull(),
    themeName: text('theme_name').notNull(),
    slideCount: integer('slide_count').notNull(),
    thumbnailKey: text('thumbnail_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('templates_owner_idx').on(t.ownerId), index('templates_visibility_idx').on(t.visibility)],
)

/**
 * A brand kit (M9): palette and fonts (`tokens`), an optional logo in storage, where the logo goes, and an optional
 * default template. The logo is copied into each deck the kit is applied to, so a deck never depends on the kit row.
 */
export const brandKits = pgTable(
  'brand_kits',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    visibility: libraryVisibility('visibility').notNull().default('private'),
    tokens: jsonb('tokens').$type<BrandTokens>().notNull(),
    logoKey: text('logo_key'),
    logoMime: text('logo_mime'),
    logoBytes: integer('logo_bytes'),
    logoSha256: text('logo_sha256'),
    /** Optional logo for dark backgrounds (M11). Same rules as the logo. */
    logoDarkKey: text('logo_dark_key'),
    logoDarkMime: text('logo_dark_mime'),
    logoDarkBytes: integer('logo_dark_bytes'),
    logoDarkSha256: text('logo_dark_sha256'),
    /** Footer line shown on slides when the kit is applied (M11). */
    footerText: text('footer_text'),
    logoPlacement: jsonb('logo_placement').$type<LogoPlacement>().notNull(),
    defaultTemplateId: uuid('default_template_id').references(() => templates.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('brand_kits_owner_idx').on(t.ownerId), index('brand_kits_visibility_idx').on(t.visibility)],
)

/**
 * A personal image library (M11): images the user uploads once and copies into any deck they can edit. Only the
 * owner sees or changes them. The bytes live in storage under `storageKey` (`library/<id>`). Deleting a library
 * image does not touch decks that already copied it.
 */
export const userAssets = pgTable(
  'user_assets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    /** Size of the stored file in bytes. */
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_assets_owner_idx').on(t.ownerId)],
)

export type TemplateRow = typeof templates.$inferSelect
export type BrandKitRow = typeof brandKits.$inferSelect
export type UserAssetRecord = typeof userAssets.$inferSelect

import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { decks } from './decks.ts'

export const importFormat = pgEnum('import_format', ['pptx', 'markdown', 'json', 'google-slides'])
export const importStatus = pgEnum('import_status', ['queued', 'running', 'done', 'failed'])

/**
 * One row per import request. The worker creates the deck and records its id and the warnings.
 * The bytes live in storage under `sourceKey` until the worker is done; a Google Slides import also records the file id.
 */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    format: importFormat('format').notNull(),
    status: importStatus('status').notNull().default('queued'),
    fileName: text('file_name'),
    /** Deck title given by the caller (MCP). Null means the title comes from the file. */
    title: text('title'),
    bytes: integer('bytes'),
    /** Storage key of the bytes to convert (the upload, or the fetched Google Slides export). */
    sourceKey: text('source_key'),
    /** Google Slides: the presentation id from a validated URL, or the Drive file id from the Picker. */
    googleFileId: text('google_file_id'),
    /** The deck the import created, once it is done. */
    deckId: uuid('deck_id').references(() => decks.id, { onDelete: 'set null' }),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('import_jobs_user_created_idx').on(t.userId, t.createdAt)],
)

export type ImportJobRow = typeof importJobs.$inferSelect

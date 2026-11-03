import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { decks } from './decks.ts'

export const wizardStatus = pgEnum('wizard_status', ['draft', 'ingesting', 'outlining', 'ready', 'generating', 'done', 'failed', 'cancelled'])
export const wizardSourceKind = pgEnum('wizard_source_kind', ['file', 'url', 'search'])
export const wizardSourceStatus = pgEnum('wizard_source_status', ['queued', 'running', 'ready', 'failed'])

/**
 * One prompt-to-deck run. The deck is created when generation starts (deck_id is null before that).
 * `brief` and `outline` hold no secrets. `provider_id` is the provider chosen for the run; the key is read by the worker.
 */
export const wizardRuns = pgTable(
  'wizard_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deckId: uuid('deck_id').references(() => decks.id, { onDelete: 'set null' }),
    brief: jsonb('brief').$type<Record<string, unknown>>().notNull(),
    outline: jsonb('outline').$type<Record<string, unknown>>(),
    status: wizardStatus('status').notNull().default('draft'),
    /** Slides written so far, out of `total`. */
    progress: integer('progress').notNull().default(0),
    total: integer('total').notNull().default(0),
    error: text('error'),
    providerId: uuid('provider_id'),
    /** Last time the worker made progress on this run (a slide written, a source ingested). A run that is still
     * `generating` or `ingesting` with no heartbeat for five minutes lost its worker, and is marked failed on startup. */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wizard_runs_user_idx').on(t.userId, t.createdAt), index('wizard_runs_deck_idx').on(t.deckId)],
)

/**
 * A reference: an uploaded file, a URL the user gave, or a search result. Uploaded bytes live in the storage driver
 * under `file_key` (run-scoped, not in `assets`, because assets need a deck). `extracted` holds the cleaned text,
 * tables and images (see @sleid/ingest IngestedSource). Failures keep their message in `error`.
 */
export const wizardSources = pgTable(
  'wizard_sources',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => wizardRuns.id, { onDelete: 'cascade' }),
    kind: wizardSourceKind('kind').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    fileName: text('file_name'),
    mime: text('mime'),
    fileKey: text('file_key'),
    /** Size of the uploaded file in bytes (uploads only). Counts toward the run's 50 MB total. */
    bytes: integer('bytes'),
    status: wizardSourceStatus('status').notNull().default('queued'),
    wordCount: integer('word_count').notNull().default(0),
    extracted: jsonb('extracted').$type<Record<string, unknown>>(),
    error: text('error'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wizard_sources_run_idx').on(t.runId, t.position)],
)

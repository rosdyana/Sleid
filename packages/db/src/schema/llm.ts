import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, bigserial } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { decks } from './decks.ts'

export const llmProviderKind = pgEnum('llm_provider_kind', ['foundry-claude', 'azure-openai', 'openai-compatible'])
/** 'user' is visible to its owner only. 'workspace' is instance-wide and changed by admins only (ADMIN_EMAILS). */
export const llmScope = pgEnum('llm_scope', ['user', 'workspace'])

/**
 * A model provider. `config` holds only non-secret settings. The API key, when there is one, is in
 * `secret_ciphertext` (AES-256-GCM, see @sleid/llm secret-box). Nothing here is ever returned to a client with the key.
 */
export const llmProviders = pgTable(
  'llm_providers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    scope: llmScope('scope').notNull(),
    /** Set for user providers. Null for workspace providers. */
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: llmProviderKind('kind').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secretCiphertext: text('secret_ciphertext'),
    defaultModel: text('default_model').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('llm_providers_owner_idx').on(t.ownerId),
    uniqueIndex('llm_providers_one_default_per_user').on(t.ownerId).where(sql`${t.isDefault} and ${t.scope} = 'user'`),
    uniqueIndex('llm_providers_one_default_workspace').on(t.scope).where(sql`${t.isDefault} and ${t.scope} = 'workspace'`),
  ],
)

/** One row per assistant request (success or failure). Used for usage display and the per-user rate limit. */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Null for calls made before a deck exists (wizard research and outline). */
    deckId: uuid('deck_id').references(() => decks.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id').references(() => llmProviders.id, { onDelete: 'set null' }),
    ability: text('ability').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    ok: boolean('ok').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_usage_user_created_idx').on(t.userId, t.createdAt)],
)

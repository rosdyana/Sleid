import { sql } from 'drizzle-orm'
import { bigserial, index, integer, pgTable, text, timestamp, uuid, boolean } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'

/**
 * A personal access token for the MCP server. Only the SHA-256 of the secret is stored; the secret itself is
 * shown once, when the token is created. `scopes` are checked on every MCP call, together with the user's
 * current deck role. `deckIds` null means every deck the user can access.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Last six characters of the secret, so the list can tell tokens apart. Not enough to use the token. */
    hint: text('hint').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes').array().notNull(),
    deckIds: uuid('deck_ids').array(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
)

/**
 * One row per MCP tool call. No foreign keys, so the history outlives the token, the deck and the user.
 * `error` holds the short message the agent saw, never a stack trace.
 */
export const mcpAudit = pgTable(
  'mcp_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id').notNull(),
    tokenId: uuid('token_id'),
    tool: text('tool').notNull(),
    deckId: uuid('deck_id'),
    ok: boolean('ok').notNull(),
    ms: integer('ms').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mcp_audit_user_created_idx').on(t.userId, t.createdAt)],
)

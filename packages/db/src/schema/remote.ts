import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { decks } from './decks.ts'

/**
 * A phone-remote session, one per presenter window (its id is the session id, `sid`). A row is what makes a
 * remote token revocable: closing the remote sets revoked_at, and every command checks it.
 */
export const remoteSessions = pgTable(
  'remote_sessions',
  {
    id: text('id').primaryKey(),
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('remote_sessions_deck_idx').on(t.deckId)],
)

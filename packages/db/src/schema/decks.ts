import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { bytea } from './custom-types.ts'

/** Roles that can be held by a deck member. Owner is only ever assigned to the creator. */
export const deckRole = pgEnum('deck_role', ['owner', 'editor', 'commenter', 'viewer'])
/** Roles a share link or invite can grant. Ownership is never granted this way. */
export const shareRole = pgEnum('share_role', ['editor', 'commenter', 'viewer'])

export const decks = pgTable('decks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('Untitled presentation'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

export const deckMembers = pgTable(
  'deck_members',
  {
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: deckRole('role').notNull(),
    /** Per user: each collaborator stars decks for themselves. Moved here from decks in M2. */
    starred: boolean('starred').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.deckId, t.userId] })],
)

/**
 * "General access" link. A deck has at most one active link (revokedAt null and not expired).
 * Restricted means every link is revoked. Redeeming a link adds a deck_members row.
 */
export const shareLinks = pgTable('share_links', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  deckId: uuid('deck_id')
    .notNull()
    .references(() => decks.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  role: shareRole('role').notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

/** Email invites. `email` is stored lower-case. An invite becomes a deck_members row when its email signs in. */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  deckId: uuid('deck_id')
    .notNull()
    .references(() => decks.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: shareRole('role').notNull(),
  invitedBy: text('invited_by')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
})

/** Full Yjs document state at a point in time. `name` is set for named versions. */
export const deckSnapshots = pgTable(
  'deck_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    ydoc: bytea('ydoc').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    name: text('name'),
  },
  (t) => [index('deck_snapshots_deck_id_idx').on(t.deckId, t.createdAt)],
)

/** Append-only Yjs update log. Written by the collab service (onStoreDocument) and compacted into deck_snapshots. */
export const deckUpdates = pgTable(
  'deck_updates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('deck_updates_deck_id_idx').on(t.deckId, t.id)],
)

import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { decks } from './decks.ts'

/** Where a thread is pinned, in slide coordinates (the canvas is 1920 x 1080). */
export interface CommentAnchor {
  x: number
  y: number
}

/**
 * A comment thread on one slide. element_id is set when the thread is about an element; when that element is
 * later deleted the thread stays and the UI says so. Resolved threads keep their replies.
 */
export const commentThreads = pgTable(
  'comment_threads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    slideId: text('slide_id').notNull(),
    elementId: text('element_id'),
    anchor: jsonb('anchor').$type<CommentAnchor | null>(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by').references(() => user.id, { onDelete: 'set null' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comment_threads_deck_slide_idx').on(t.deckId, t.slideId, t.createdAt)],
)

/**
 * One comment in a thread. `mentions` holds the user ids the body mentions that are members of the deck.
 * Deleting sets deleted_at and keeps the row, so the thread's shape does not change under other people.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => commentThreads.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    mentions: text('mentions').array().notNull().default(sql`'{}'`),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('comments_thread_idx').on(t.threadId, t.createdAt),
    index('comments_mentions_idx').using('gin', t.mentions),
    check('comments_body_length', sql`char_length(${t.body}) between 1 and 5000`),
  ],
)

/** When each user last opened their mentions list. Mentions after this time are unread. */
export const mentionReads = pgTable('comment_mention_reads', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
})

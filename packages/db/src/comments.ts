// Comment threads: reads, writes and mentions. Permissions are checked by the callers (the server functions and the
// MCP tools) with the role helpers in permissions.ts. The functions here check only what the data itself requires:
// that a comment belongs to the deck, and that only its author edits or deletes it.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { extractMentionIds, validateCommentBody, type CommentInline, parseCommentBody } from '@sleid/model'
import type { Db } from './client.ts'
import { decks, deckMembers, mentionReads, user, comments, commentThreads, type CommentAnchor } from './schema/index.ts'
import { getDeckRole } from './deck-access.ts'

export interface CommentView {
  id: string
  authorId: string
  authorName: string
  authorImage: string | null
  /** Empty for a deleted comment. `deletedAt` says why. */
  body: string
  mentions: string[]
  editedAt: string | null
  deletedAt: string | null
  createdAt: string
}

export interface ThreadView {
  id: string
  deckId: string
  slideId: string
  elementId: string | null
  anchor: CommentAnchor | null
  resolved: boolean
  resolvedAt: string | null
  resolvedByName: string | null
  createdAt: string
  createdBy: string
  comments: CommentView[]
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

/** Mentions are kept only for people who are members of the deck, so a mention cannot reach someone outside it. */
async function memberIdsOf(db: Db, deckId: string): Promise<Set<string>> {
  const rows = await db.select({ userId: deckMembers.userId }).from(deckMembers).where(eq(deckMembers.deckId, deckId))
  return new Set(rows.map((r) => r.userId))
}

async function mentionsFor(db: Db, deckId: string, body: string): Promise<string[]> {
  const ids = extractMentionIds(body)
  if (ids.length === 0) return []
  const members = await memberIdsOf(db, deckId)
  return ids.filter((id) => members.has(id))
}

type ThreadRow = {
  id: string
  deckId: string
  slideId: string
  elementId: string | null
  anchor: CommentAnchor | null
  resolvedAt: Date | null
  resolvedBy: string | null
  createdBy: string
  createdAt: Date
}

const THREAD_COLUMNS = {
  id: commentThreads.id,
  deckId: commentThreads.deckId,
  slideId: commentThreads.slideId,
  elementId: commentThreads.elementId,
  anchor: commentThreads.anchor,
  resolvedAt: commentThreads.resolvedAt,
  resolvedBy: commentThreads.resolvedBy,
  createdBy: commentThreads.createdBy,
  createdAt: commentThreads.createdAt,
}

/** Builds views for several threads with two queries (threads, then their comments), not one per thread. */
async function viewsFor(db: Db, rows: ThreadRow[]): Promise<ThreadView[]> {
  if (rows.length === 0) return []
  const threadIds = rows.map((r) => r.id)
  const resolverIds = [...new Set(rows.map((r) => r.resolvedBy).filter((id): id is string => id !== null))]
  const [commentRows, resolvers] = await Promise.all([
    db
      .select({
        threadId: comments.threadId,
        id: comments.id,
        authorId: comments.authorId,
        authorName: user.name,
        authorImage: user.image,
        body: comments.body,
        mentions: comments.mentions,
        editedAt: comments.editedAt,
        deletedAt: comments.deletedAt,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .innerJoin(user, eq(user.id, comments.authorId))
      .where(inArray(comments.threadId, threadIds))
      .orderBy(comments.createdAt, comments.id),
    resolverIds.length
      ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, resolverIds))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ])
  const names = new Map(resolvers.map((r) => [r.id, r.name]))
  const byThread = new Map<string, CommentView[]>()
  for (const r of commentRows) {
    const list = byThread.get(r.threadId) ?? []
    list.push({
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName,
      authorImage: r.authorImage ?? null,
      body: r.deletedAt ? '' : r.body,
      mentions: r.deletedAt ? [] : r.mentions,
      editedAt: iso(r.editedAt),
      deletedAt: iso(r.deletedAt),
      createdAt: r.createdAt.toISOString(),
    })
    byThread.set(r.threadId, list)
  }
  return rows.map((thread) => ({
    id: thread.id,
    deckId: thread.deckId,
    slideId: thread.slideId,
    elementId: thread.elementId,
    anchor: thread.anchor,
    resolved: thread.resolvedAt !== null,
    resolvedAt: iso(thread.resolvedAt),
    resolvedByName: thread.resolvedBy ? (names.get(thread.resolvedBy) ?? null) : null,
    createdAt: thread.createdAt.toISOString(),
    createdBy: thread.createdBy,
    comments: byThread.get(thread.id) ?? [],
  }))
}

/** One thread with its comments, oldest first. Null when the thread does not exist. */
export async function loadThreadView(db: Db, threadId: string): Promise<ThreadView | null> {
  const [thread] = await db.select(THREAD_COLUMNS).from(commentThreads).where(eq(commentThreads.id, threadId)).limit(1)
  if (!thread) return null
  const [view] = await viewsFor(db, [thread])
  return view ?? null
}

/** Threads of a deck, oldest first. Filter by slide, and leave out resolved threads unless asked. */
export async function listThreadViews(db: Db, deckId: string, options: { slideId?: string; includeResolved?: boolean } = {}): Promise<ThreadView[]> {
  const conditions = [eq(commentThreads.deckId, deckId)]
  if (options.slideId) conditions.push(eq(commentThreads.slideId, options.slideId))
  if (!options.includeResolved) conditions.push(isNull(commentThreads.resolvedAt))
  const rows = await db
    .select(THREAD_COLUMNS)
    .from(commentThreads)
    .where(and(...conditions))
    .orderBy(commentThreads.createdAt, commentThreads.id)
  return viewsFor(db, rows)
}

/** The people a mention can name: members of the deck. */
export async function listMentionableMembers(db: Db, deckId: string): Promise<Array<{ id: string; name: string; image: string | null }>> {
  const rows = await db
    .select({ id: user.id, name: user.name, image: user.image })
    .from(deckMembers)
    .innerJoin(user, eq(user.id, deckMembers.userId))
    .where(eq(deckMembers.deckId, deckId))
    .orderBy(user.name)
  return rows.map((r) => ({ id: r.id, name: r.name, image: r.image ?? null }))
}

export interface CreateThreadInput {
  deckId: string
  authorId: string
  slideId: string
  elementId: string | null
  anchor: CommentAnchor | null
  body: string
}

/** Starts a thread with its first comment. The caller has checked the role and that the slide and element exist. */
export async function createThread(db: Db, input: CreateThreadInput): Promise<{ threadId: string; commentId: string }> {
  const body = validateCommentBody(input.body)
  const mentions = await mentionsFor(db, input.deckId, body)
  return db.transaction(async (tx) => {
    const [thread] = await tx
      .insert(commentThreads)
      .values({ deckId: input.deckId, slideId: input.slideId, elementId: input.elementId, anchor: input.anchor, createdBy: input.authorId })
      .returning({ id: commentThreads.id })
    if (!thread) throw new Error('could not create the thread')
    const [comment] = await tx
      .insert(comments)
      .values({ threadId: thread.id, authorId: input.authorId, body, mentions })
      .returning({ id: comments.id })
    if (!comment) throw new Error('could not create the comment')
    return { threadId: thread.id, commentId: comment.id }
  })
}

/** Adds a reply. Throws when the thread is not in the deck. */
export async function addReply(db: Db, input: { deckId: string; threadId: string; authorId: string; body: string }): Promise<{ commentId: string }> {
  const body = validateCommentBody(input.body)
  const mentions = await mentionsFor(db, input.deckId, body)
  const [thread] = await db
    .select({ id: commentThreads.id })
    .from(commentThreads)
    .where(and(eq(commentThreads.id, input.threadId), eq(commentThreads.deckId, input.deckId)))
    .limit(1)
  if (!thread) throw new Error('Thread not found')
  const [comment] = await db.insert(comments).values({ threadId: input.threadId, authorId: input.authorId, body, mentions }).returning({ id: comments.id })
  if (!comment) throw new Error('could not add the comment')
  return { commentId: comment.id }
}

/** Finds a live comment in a deck. Used before edit and delete, which only the author may do. */
async function ownComment(db: Db, deckId: string, commentId: string, authorId: string) {
  const [row] = await db
    .select({ id: comments.id, threadId: comments.threadId, deletedAt: comments.deletedAt })
    .from(comments)
    .innerJoin(commentThreads, eq(commentThreads.id, comments.threadId))
    .where(and(eq(comments.id, commentId), eq(commentThreads.deckId, deckId), eq(comments.authorId, authorId)))
    .limit(1)
  if (!row) throw new Error('Comment not found, or it is not yours')
  return row
}

export async function editComment(db: Db, input: { deckId: string; commentId: string; authorId: string; body: string; now?: Date }): Promise<{ threadId: string }> {
  const body = validateCommentBody(input.body)
  const row = await ownComment(db, input.deckId, input.commentId, input.authorId)
  if (row.deletedAt) throw new Error('A deleted comment cannot be edited')
  const mentions = await mentionsFor(db, input.deckId, body)
  await db
    .update(comments)
    .set({ body, mentions, editedAt: input.now ?? new Date() })
    .where(eq(comments.id, input.commentId))
  return { threadId: row.threadId }
}

export async function deleteComment(db: Db, input: { deckId: string; commentId: string; authorId: string; now?: Date }): Promise<{ threadId: string }> {
  const row = await ownComment(db, input.deckId, input.commentId, input.authorId)
  if (!row.deletedAt) {
    await db
      .update(comments)
      .set({ deletedAt: input.now ?? new Date() })
      .where(eq(comments.id, input.commentId))
  }
  return { threadId: row.threadId }
}

/** Resolves or reopens a thread. The caller checks that the user is an editor or owner. */
export async function setThreadResolved(db: Db, input: { deckId: string; threadId: string; userId: string; resolved: boolean; now?: Date }): Promise<void> {
  const [thread] = await db
    .select({ id: commentThreads.id })
    .from(commentThreads)
    .where(and(eq(commentThreads.id, input.threadId), eq(commentThreads.deckId, input.deckId)))
    .limit(1)
  if (!thread) throw new Error('Thread not found')
  await db
    .update(commentThreads)
    .set(input.resolved ? { resolvedAt: input.now ?? new Date(), resolvedBy: input.userId } : { resolvedAt: null, resolvedBy: null })
    .where(eq(commentThreads.id, input.threadId))
}

/** The deck a thread belongs to, or null. */
export async function threadDeckId(db: Db, threadId: string): Promise<string | null> {
  const [row] = await db.select({ deckId: commentThreads.deckId }).from(commentThreads).where(eq(commentThreads.id, threadId)).limit(1)
  return row?.deckId ?? null
}

export interface MentionItem {
  commentId: string
  threadId: string
  deckId: string
  deckTitle: string
  slideId: string
  authorName: string
  snippet: string
  createdAt: string
  unread: boolean
}

/**
 * The comments that mention `userId`, in decks the user can still access, newest first. A mention is unread
 * when it is newer than the user's last opening of the mentions list.
 */
export async function listMentions(db: Db, userId: string, options: { limit?: number } = {}): Promise<{ unread: number; items: MentionItem[] }> {
  const [read] = await db.select({ seenAt: mentionReads.seenAt }).from(mentionReads).where(eq(mentionReads.userId, userId)).limit(1)
  const seenAt = read?.seenAt ?? null
  const rows = await db
    .select({
      commentId: comments.id,
      threadId: comments.threadId,
      deckId: commentThreads.deckId,
      deckTitle: decks.title,
      slideId: commentThreads.slideId,
      authorName: user.name,
      body: comments.body,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(commentThreads, eq(commentThreads.id, comments.threadId))
    .innerJoin(decks, eq(decks.id, commentThreads.deckId))
    .innerJoin(user, eq(user.id, comments.authorId))
    .where(and(sql`${userId} = any(${comments.mentions})`, isNull(comments.deletedAt), isNull(decks.deletedAt), sql`${comments.authorId} <> ${userId}`))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(200)

  const accessible = new Map<string, boolean>()
  const items: MentionItem[] = []
  for (const row of rows) {
    if (!accessible.has(row.deckId)) accessible.set(row.deckId, (await getDeckRole(db, userId, row.deckId)) !== null)
    if (!accessible.get(row.deckId)) continue
    items.push({
      commentId: row.commentId,
      threadId: row.threadId,
      deckId: row.deckId,
      deckTitle: row.deckTitle,
      slideId: row.slideId,
      authorName: row.authorName,
      snippet: snippetOf(row.body),
      createdAt: row.createdAt.toISOString(),
      unread: seenAt === null || row.createdAt > seenAt,
    })
    if (items.length >= (options.limit ?? 100)) break
  }
  return { unread: items.filter((i) => i.unread).length, items }
}

/** Records that the user has seen their mentions now. */
export async function markMentionsSeen(db: Db, userId: string, now: Date = new Date()): Promise<void> {
  await db
    .insert(mentionReads)
    .values({ userId, seenAt: now })
    .onConflictDoUpdate({ target: mentionReads.userId, set: { seenAt: now } })
}

/** Plain-text preview of a comment, for lists. */
export function snippetOf(body: string, max = 160): string {
  const flat = parseCommentBody(body)
    .map((line: CommentInline[]) =>
      line
        .map((n) => (n.kind === 'mention' ? `@${n.name}` : n.text))
        .join(''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}


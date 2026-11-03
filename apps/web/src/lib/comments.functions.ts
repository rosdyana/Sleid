import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { COMMENT_MAX_LENGTH } from '@sleid/model'
import {
  addReply,
  canComment,
  canResolveComments,
  createThread,
  deleteComment,
  editComment,
  listMentionableMembers,
  listMentions,
  listThreadViews,
  loadThreadView,
  markMentionsSeen,
  setThreadResolved,
} from '@sleid/db'
import { requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'
import { anchorFor, broadcastCommentChange, currentDeck } from '~/lib/comments.server'

const deckId = z.uuid()
const threadId = z.uuid()
const commentId = z.uuid()
const body = z.string().trim().min(1, 'A comment cannot be empty.').max(COMMENT_MAX_LENGTH, `A comment can be at most ${COMMENT_MAX_LENGTH} characters.`)
const anchorSchema = z.object({ x: z.number().min(0).max(1920), y: z.number().min(0).max(1080) }).nullable().optional()

/** Commenting needs commenter access or higher. Viewers may read threads, not start them. */
async function commenterOn(userId: string, id: string) {
  const role = await requireDeckRole(userId, id, 'viewer')
  if (!canComment(role)) throw new Error('Commenting needs commenter access or higher.')
  return role
}

/** Every thread of the deck (resolved too), with the caller's commenting and resolving rights. */
export const listThreadsFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ deckId: deckId }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await requireDeckRole(user.id, data.deckId, 'viewer')
    const threads = await listThreadViews(db, data.deckId, { includeResolved: true })
    return { threads, userId: user.id, canComment: canComment(role), canResolve: canResolveComments(role) }
  })

/** One thread again, after another person changed it. */
export const getThreadFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ deckId: deckId, threadId: threadId }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    const view = await loadThreadView(db, data.threadId)
    if (!view || view.deckId !== data.deckId) return { thread: null }
    return { thread: view }
  })

/** Starts a thread on a slide (optionally on an element). Commenters and up. */
export const createThreadFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z.object({ deckId: deckId, slideId: z.string().min(1).max(100), elementId: z.string().min(1).max(100).nullable().optional(), anchor: anchorSchema, body }).parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    await commenterOn(user.id, data.deckId)
    const deck = await currentDeck(data.deckId)
    const placed = anchorFor(deck, data.slideId, data.elementId ?? null, data.anchor)
    const { threadId: id } = await createThread(db, {
      deckId: data.deckId,
      authorId: user.id,
      slideId: data.slideId,
      elementId: placed.elementId,
      anchor: placed.anchor,
      body: data.body,
    })
    await broadcastCommentChange(data.deckId, id)
    return { thread: await loadThreadView(db, id) }
  })

export const replyFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: deckId, threadId: threadId, body }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await commenterOn(user.id, data.deckId)
    await addReply(db, { deckId: data.deckId, threadId: data.threadId, authorId: user.id, body: data.body })
    await broadcastCommentChange(data.deckId, data.threadId)
    return { thread: await loadThreadView(db, data.threadId) }
  })

/** Edits one of your own comments. */
export const editCommentFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: deckId, commentId: commentId, body }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await commenterOn(user.id, data.deckId)
    const { threadId: id } = await editComment(db, { deckId: data.deckId, commentId: data.commentId, authorId: user.id, body: data.body })
    await broadcastCommentChange(data.deckId, id)
    return { thread: await loadThreadView(db, id) }
  })

/** Deletes one of your own comments. The row stays, marked deleted, so the thread keeps its shape. */
export const deleteCommentFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: deckId, commentId: commentId }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await commenterOn(user.id, data.deckId)
    const { threadId: id } = await deleteComment(db, { deckId: data.deckId, commentId: data.commentId, authorId: user.id })
    await broadcastCommentChange(data.deckId, id)
    return { thread: await loadThreadView(db, id) }
  })

/** Resolves or reopens a thread. Editors and owners. */
export const setThreadResolvedFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: deckId, threadId: threadId, resolved: z.boolean() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canResolveComments(role)) throw new Error('Only editors and owners can resolve comments.')
    await setThreadResolved(db, { deckId: data.deckId, threadId: data.threadId, userId: user.id, resolved: data.resolved })
    await broadcastCommentChange(data.deckId, data.threadId)
    return { thread: await loadThreadView(db, data.threadId) }
  })

/** The people a comment can mention: the deck's members. Commenters and up (they are the ones who write). */
export const mentionableMembersFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ deckId: deckId }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await commenterOn(user.id, data.deckId)
    return { members: await listMentionableMembers(db, data.deckId) }
  })

/** Comments that mention the signed-in user, across decks they can open, and how many are unread. */
export const myMentionsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  return listMentions(db, user.id)
})

/** Marks the mentions list as seen, which clears the unread badge. */
export const markMentionsSeenFn = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser()
  await markMentionsSeen(db, user.id)
  return { ok: true as const }
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mentionMarkup } from '@sleid/model'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { addReply, createThread, deleteComment, editComment, listMentions, listThreadViews, loadThreadView, markMentionsSeen, setThreadResolved, threadDeckId } from './comments.ts'
import { canComment, canResolveComments } from './permissions.ts'
import { grantMembership } from './sharing.ts'
import type { Db } from './client.ts'
import { roleAtLeast, type DeckRole } from './permissions.ts'

let db: Db | null = null
const users: string[] = []

beforeAll(async () => {
  db = await connectOrNull()
})
afterAll(async () => {
  if (!db) return
  await removeUsers(db, users)
  await db.$client.end({ timeout: 1 })
})

describe('comment roles (pure)', () => {
  const roles: DeckRole[] = ['owner', 'editor', 'commenter', 'viewer']
  it('commenters and up comment; only editors and up resolve', () => {
    expect(roles.map((r) => canComment(r))).toEqual([true, true, true, false])
    expect(roles.map((r) => canResolveComments(r))).toEqual([true, true, false, false])
    expect(roleAtLeast('commenter', 'commenter')).toBe(true)
  })
})

async function setup(label: string) {
  const owner = await makeUser(db!, `${label}-owner`)
  const commenter = await makeUser(db!, `${label}-commenter`)
  const member = await makeUser(db!, `${label}-member`)
  const outsider = await makeUser(db!, `${label}-outsider`)
  users.push(owner.id, commenter.id, member.id, outsider.id)
  const deckId = await makeDeck(db!, owner.id, `${label} deck`)
  await db!.transaction(async (tx) => {
    await grantMembership(tx, deckId, commenter.id, 'commenter')
    await grantMembership(tx, deckId, member.id, 'viewer')
  })
  return { owner, commenter, member, outsider, deckId }
}

describe('comment threads in Postgres', () => {
  it('stores a thread with its anchor, and mentions only deck members', async (ctx) => {
    if (!db) return ctx.skip()
    const { commenter, member, outsider, deckId } = await setup('mention')
    const body = `Please check ${mentionMarkup('Member', member.id)} and ${mentionMarkup('Outside', outsider.id)}`
    const { threadId } = await createThread(db, { deckId, authorId: commenter.id, slideId: 's1', elementId: 'e1', anchor: { x: 100, y: 50 }, body })
    const view = await loadThreadView(db, threadId)
    expect(view).toMatchObject({ slideId: 's1', elementId: 'e1', anchor: { x: 100, y: 50 }, resolved: false, createdBy: commenter.id })
    expect(view!.comments).toHaveLength(1)
    expect(view!.comments[0]!.mentions).toEqual([member.id])
    expect(await threadDeckId(db, threadId)).toBe(deckId)
  })

  it('adds replies in the same deck only, and edits and deletes only the author\'s comments', async (ctx) => {
    if (!db) return ctx.skip()
    const { owner, commenter, member, deckId } = await setup('edit')
    const { threadId } = await createThread(db, { deckId, authorId: commenter.id, slideId: 's1', elementId: null, anchor: null, body: 'First' })
    const reply = await addReply(db, { deckId, threadId, authorId: owner.id, body: 'Reply' })
    expect(reply.commentId).toBeTruthy()
    await expect(addReply(db, { deckId: '00000000-0000-4000-8000-000000000000', threadId, authorId: owner.id, body: 'x' })).rejects.toThrow('Thread not found')

    const mine = (await loadThreadView(db, threadId))!.comments[0]!
    await expect(editComment(db, { deckId, commentId: mine.id, authorId: owner.id, body: 'hijack' })).rejects.toThrow('not yours')
    await expect(deleteComment(db, { deckId, commentId: mine.id, authorId: member.id })).rejects.toThrow('not yours')

    await editComment(db, { deckId, commentId: mine.id, authorId: commenter.id, body: `Edited ${mentionMarkup('Owner', owner.id)}` })
    const edited = (await loadThreadView(db, threadId))!.comments[0]!
    expect(edited.editedAt).toBeTruthy()
    expect(edited.mentions).toEqual([owner.id])

    await deleteComment(db, { deckId, commentId: mine.id, authorId: commenter.id })
    const gone = (await loadThreadView(db, threadId))!.comments[0]!
    expect(gone).toMatchObject({ body: '', mentions: [] })
    expect(gone.deletedAt).toBeTruthy()
    await expect(editComment(db, { deckId, commentId: mine.id, authorId: commenter.id, body: 'back' })).rejects.toThrow('deleted')
  })

  it('resolves and reopens a thread, recording who did it', async (ctx) => {
    if (!db) return ctx.skip()
    const { owner, commenter, deckId } = await setup('resolve')
    const { threadId } = await createThread(db, { deckId, authorId: commenter.id, slideId: 's2', elementId: null, anchor: null, body: 'Open me' })
    await setThreadResolved(db, { deckId, threadId, userId: owner.id, resolved: true })
    const resolved = await loadThreadView(db, threadId)
    expect(resolved).toMatchObject({ resolved: true, resolvedByName: 'resolve-owner' })
    expect(await listThreadViews(db, deckId, { slideId: 's2' })).toHaveLength(0)
    expect(await listThreadViews(db, deckId, { slideId: 's2', includeResolved: true })).toHaveLength(1)
    await setThreadResolved(db, { deckId, threadId, userId: owner.id, resolved: false })
    expect((await loadThreadView(db, threadId))!.resolved).toBe(false)
  })

  it('filters threads by slide', async (ctx) => {
    if (!db) return ctx.skip()
    const { commenter, deckId } = await setup('filter')
    await createThread(db, { deckId, authorId: commenter.id, slideId: 'a', elementId: null, anchor: null, body: 'on a' })
    await createThread(db, { deckId, authorId: commenter.id, slideId: 'b', elementId: null, anchor: null, body: 'on b' })
    expect((await listThreadViews(db, deckId, { slideId: 'a' })).map((t) => t.comments[0]!.body)).toEqual(['on a'])
    expect(await listThreadViews(db, deckId)).toHaveLength(2)
  })

  it('lists mentions of a user in decks they can access, with an unread count that markMentionsSeen clears', async (ctx) => {
    if (!db) return ctx.skip()
    const { owner, commenter, member, deckId } = await setup('mentions')
    await createThread(db, { deckId, authorId: commenter.id, slideId: 's', elementId: null, anchor: null, body: `Hey ${mentionMarkup('Owner', owner.id)}` })
    const before = await listMentions(db, owner.id)
    expect(before.unread).toBe(1)
    expect(before.items[0]).toMatchObject({ deckId, authorName: 'mentions-commenter', unread: true })
    expect(before.items[0]!.snippet).toBe('Hey @Owner')

    await markMentionsSeen(db, owner.id, new Date(Date.now() + 1000))
    const after = await listMentions(db, owner.id)
    expect(after.unread).toBe(0)
    expect(after.items).toHaveLength(1)

    // A mention of someone who is not in the deck is never stored, so it never appears for them.
    expect((await listMentions(db, member.id)).items).toHaveLength(0)
  })
})

// The Comments tab: a composer for a new thread, the threads of this slide (or all slides), replies, edit and delete
// of your own comments, and resolve or reopen for editors. Changes go to the server, which broadcasts them, and the
// server's copy of the thread replaces the local one at once.
import { useCallback, useEffect, useState } from 'react'
import type { ThreadView } from '@sleid/db'
import type { Deck, Element } from '@sleid/model'
import { createThreadFn, deleteCommentFn, editCommentFn, markMentionsSeenFn, mentionableMembersFn, replyFn, setThreadResolvedFn } from '~/lib/comments.functions'
import { CommentBody } from './CommentBody'
import { MentionTextarea, type MentionMember } from './MentionTextarea'
import { anchorLabel, pinNumbers, slideNumber } from './comment-view'
import type { CommentsStore } from './useComments'

export { anchorLabel, elementName, pinNumbers, slideNumber } from './comment-view'

export interface PendingComment {
  slideId: string
  elementId: string | null
  /** What the composer says it is on, for example "Slide 3" or "Title". */
  label: string
}

export interface CommentsPanelProps {
  deckId: string
  deck: Deck
  slideId: string
  store: CommentsStore
  scope: 'slide' | 'all'
  onScope(scope: 'slide' | 'all'): void
  showResolved: boolean
  onShowResolved(show: boolean): void
  pending: PendingComment | null
  onPendingDone(thread: ThreadView): void
  onPendingCancel(): void
  focusThreadId: string | null
  onFocus(threadId: string | null): void
  onGoToSlide(slideId: string): void
  toast(message: string): void
}

export function CommentsPanel(props: CommentsPanelProps) {
  const { deckId, deck, slideId, store, scope, onScope, showResolved, onShowResolved, pending, onPendingDone, onPendingCancel, focusThreadId, onFocus, onGoToSlide, toast } = props
  const [members, setMembers] = useState<MentionMember[] | null>(null)
  const [composeText, setComposeText] = useState('')
  const [busy, setBusy] = useState(false)

  const loadMembers = useCallback(() => {
    mentionableMembersFn({ data: { deckId } })
      .then((result) => setMembers(result.members))
      .catch(() => setMembers([]))
  }, [deckId])

  useEffect(() => {
    if (pending) setComposeText('')
  }, [pending])

  const numbers = pinNumbers(store.threads)
  const visible = store.threads.filter((t) => (scope === 'all' || t.slideId === slideId) && (showResolved || !t.resolved))
  const openHere = store.threads.filter((t) => t.slideId === slideId && !t.resolved).length

  async function submitNew() {
    if (!pending || busy) return
    const body = composeText.trim()
    if (!body) return
    setBusy(true)
    try {
      const result = await createThreadFn({ data: { deckId, slideId: pending.slideId, elementId: pending.elementId, anchor: null, body } })
      if (result.thread) {
        store.upsert(result.thread.id, result.thread)
        onFocus(result.thread.id)
        onPendingDone(result.thread)
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The comment was not saved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="comments-panel">
      {pending && (
        <section aria-label="New comment" className="flex flex-col gap-2 rounded border border-accent/40 bg-accent/5 p-2">
          <div className="text-[12px] text-ink-muted">
            New comment on <strong className="font-medium text-ink">{pending.label}</strong>
          </div>
          <MentionTextarea
            testId="comment-composer"
            label="New comment"
            placeholder="Write a comment. Type @ to mention someone."
            value={composeText}
            onChange={setComposeText}
            members={members}
            onNeedMembers={loadMembers}
            autoFocus
            onSubmit={submitNew}
            rows={3}
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onPendingCancel} className="rounded px-2 py-1 text-[12px] text-ink-muted hover:bg-hover">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || composeText.trim() === ''}
              onClick={submitNew}
              className="rounded bg-accent px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            >
              Comment
            </button>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <div role="group" aria-label="Which comments" className="flex overflow-hidden rounded border border-rule">
          <button type="button" aria-pressed={scope === 'slide'} onClick={() => onScope('slide')} className={`px-2 py-1 ${scope === 'slide' ? 'bg-accent/10 text-accent' : 'text-ink-muted hover:bg-hover'}`}>
            This slide
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => onScope('all')} className={`px-2 py-1 ${scope === 'all' ? 'bg-accent/10 text-accent' : 'text-ink-muted hover:bg-hover'}`}>
            All
          </button>
        </div>
        <label className="flex items-center gap-1 text-ink-muted">
          <input type="checkbox" checked={showResolved} onChange={(e) => onShowResolved(e.target.checked)} />
          Resolved
        </label>
        <span className="ml-auto text-ink-muted" data-testid="open-thread-count">
          {openHere} open here
        </span>
      </div>

      {store.unread > 0 && (
        <div className="flex items-center justify-between rounded bg-amber-50 px-2 py-1 text-[12px] text-amber-900" data-testid="mention-banner">
          <span>
            {store.unread} unread {store.unread === 1 ? 'mention' : 'mentions'} of you
          </span>
          <button
            type="button"
            className="font-medium underline"
            onClick={() => {
              void markMentionsSeenFn().then(() => store.refreshUnread())
            }}
          >
            Mark read
          </button>
        </div>
      )}

      {store.error && <p role="alert" className="text-[12px] text-red-700">{store.error}</p>}
      {!store.loaded && !store.error && <p className="text-[12px] text-ink-muted">Loading comments…</p>}
      {store.loaded && visible.length === 0 && (
        <p className="text-[12px] text-ink-muted" data-testid="comments-empty">
          {scope === 'slide' ? 'No comments on this slide.' : 'No comments in this deck.'} Select an element or a slide and press Ctrl+Alt+M (Cmd+Option+M on a Mac).
        </p>
      )}

      <ul className="flex flex-col gap-2" aria-label="Comment threads">
        {visible.map((thread) => (
          <ThreadCard
            key={thread.id}
            deckId={deckId}
            deck={deck}
            thread={thread}
            number={numbers.get(thread.id) ?? 0}
            showSlide={scope === 'all'}
            focused={focusThreadId === thread.id}
            canComment={store.canComment}
            canResolve={store.canResolve}
            userId={store.userId}
            members={members}
            onNeedMembers={loadMembers}
            onFocus={() => {
              onFocus(thread.id)
              if (thread.slideId !== slideId) onGoToSlide(thread.slideId)
            }}
            onChange={(result) => store.upsert(thread.id, result)}
            toast={toast}
            busy={busy}
            setBusy={setBusy}
          />
        ))}
      </ul>
    </div>
  )
}

function ThreadCard({
  deckId,
  deck,
  thread,
  number,
  showSlide,
  focused,
  canComment,
  canResolve,
  userId,
  members,
  onNeedMembers,
  onFocus,
  onChange,
  toast,
  busy,
  setBusy,
}: {
  deckId: string
  deck: Deck
  thread: ThreadView
  number: number
  showSlide: boolean
  focused: boolean
  canComment: boolean
  canResolve: boolean
  userId: string | null
  members: MentionMember[] | null
  onNeedMembers(): void
  onFocus(): void
  onChange(thread: ThreadView | null): void
  toast(message: string): void
  busy: boolean
  setBusy(busy: boolean): void
}) {
  const [reply, setReply] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const anchor = anchorLabel(deck, thread)

  async function run(action: () => Promise<{ thread: ThreadView | null }>) {
    if (busy) return
    setBusy(true)
    try {
      const result = await action()
      onChange(result.thread)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      id={`thread-${thread.id}`}
      data-testid="comment-thread"
      data-thread-id={thread.id}
      data-resolved={thread.resolved ? 'true' : 'false'}
      className={`rounded border bg-white p-2 text-[13px] ${focused ? 'border-accent ring-1 ring-accent' : 'border-rule'} ${thread.resolved ? 'opacity-70' : ''}`}
      onClick={onFocus}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white ${thread.resolved ? 'bg-ink-muted' : 'bg-accent'}`} aria-hidden>
          {number}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[12px] ${anchor.removed ? 'italic text-ink-muted' : 'text-ink-muted'}`} data-testid="thread-anchor">
          {showSlide && `${slideNumber(deck, thread.slideId) > 0 ? `Slide ${slideNumber(deck, thread.slideId)}` : 'Slide removed'} · `}
          {anchor.text}
        </span>
        {thread.resolved && (
          <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800" data-testid="thread-resolved">
            Resolved{thread.resolvedByName ? ` by ${thread.resolvedByName}` : ''}
          </span>
        )}
      </div>

      <ol className="flex flex-col gap-2">
        {thread.comments.map((comment) => {
          const mine = comment.authorId === userId
          const isEditing = editing?.id === comment.id
          return (
            <li key={comment.id} data-testid="comment" data-comment-id={comment.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className="font-medium text-ink">{comment.authorName}</span>
                <time className="text-ink-muted" dateTime={comment.createdAt}>
                  {formatWhen(comment.createdAt)}
                </time>
                {comment.editedAt && !comment.deletedAt && <span className="text-ink-muted">(edited)</span>}
              </div>
              {comment.deletedAt ? (
                <p className="text-[13px] italic text-ink-muted">Comment deleted</p>
              ) : isEditing ? (
                <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
                  <MentionTextarea
                    label="Edit comment"
                    value={editing.text}
                    onChange={(text) => setEditing({ id: comment.id, text })}
                    members={members}
                    onNeedMembers={onNeedMembers}
                    rows={2}
                    onSubmit={() =>
                      void run(async () => {
                        const result = await editCommentFn({ data: { deckId, commentId: comment.id, body: editing.text } })
                        setEditing(null)
                        return result
                      })
                    }
                  />
                  <div className="flex justify-end gap-2 text-[12px]">
                    <button type="button" className="rounded px-2 py-1 text-ink-muted hover:bg-hover" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy || editing.text.trim() === ''}
                      className="rounded bg-accent px-2 py-1 font-medium text-white disabled:opacity-50"
                      onClick={() =>
                        void run(async () => {
                          const result = await editCommentFn({ data: { deckId, commentId: comment.id, body: editing.text } })
                          setEditing(null)
                          return result
                        })
                      }
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <CommentBody body={comment.body} />
              )}
              {mine && !comment.deletedAt && !isEditing && canComment && (
                <div className="flex gap-3 text-[11px] text-ink-muted" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="hover:text-accent" onClick={() => setEditing({ id: comment.id, text: comment.body })}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="hover:text-red-700"
                    onClick={() => void run(() => deleteCommentFn({ data: { deckId, commentId: comment.id } }))}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      <div className="mt-2 flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
        {canComment && (
          <>
            <MentionTextarea
              label="Reply"
              placeholder="Reply"
              value={reply}
              onChange={setReply}
              members={members}
              onNeedMembers={onNeedMembers}
              rows={1}
              onSubmit={() =>
                void run(async () => {
                  const result = await replyFn({ data: { deckId, threadId: thread.id, body: reply } })
                  setReply('')
                  return result
                })
              }
            />
            {reply.trim() !== '' && (
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={busy}
                  className="rounded bg-accent px-2 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                  onClick={() =>
                    void run(async () => {
                      const result = await replyFn({ data: { deckId, threadId: thread.id, body: reply } })
                      setReply('')
                      return result
                    })
                  }
                >
                  Reply
                </button>
              </div>
            )}
          </>
        )}
        {canResolve && (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              className="rounded px-2 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
              onClick={() => void run(() => setThreadResolvedFn({ data: { deckId, threadId: thread.id, resolved: !thread.resolved } }))}
            >
              {thread.resolved ? 'Reopen' : 'Resolve'}
            </button>
          </div>
        )}
      </div>
    </li>
  )
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

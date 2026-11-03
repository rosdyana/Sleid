// The comment threads of the open deck, kept current. Loaded once; then, whenever the collab service says a thread
// changed, that one thread is fetched again. Also the caller's rights on the deck and their unread mention count.
import { useCallback, useEffect, useState } from 'react'
import type { ThreadView } from '@sleid/db'
import { getThreadFn, listThreadsFn } from '~/lib/comments.functions'
import { myMentionsFn } from '~/lib/comments.functions'
import type { CollabSession } from '../collab-session.ts'

export interface CommentsStore {
  loaded: boolean
  threads: ThreadView[]
  userId: string | null
  canComment: boolean
  canResolve: boolean
  unread: number
  error: string | null
  /** Replaces one thread with the server's copy, or removes it when `thread` is null. */
  upsert(threadId: string, thread: ThreadView | null): void
  refreshUnread(): void
}

const byCreated = (a: ThreadView, b: ThreadView) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)

export function useComments(deckId: string, session: CollabSession): CommentsStore {
  const [threads, setThreads] = useState<ThreadView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [rights, setRights] = useState<{ userId: string | null; canComment: boolean; canResolve: boolean }>({ userId: null, canComment: false, canResolve: false })
  const [unread, setUnread] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const upsert = useCallback((threadId: string, thread: ThreadView | null) => {
    setThreads((prev) => {
      const rest = prev.filter((t) => t.id !== threadId)
      return thread ? [...rest, thread].sort(byCreated) : rest
    })
  }, [])

  const refreshUnread = useCallback(() => {
    myMentionsFn()
      .then((result) => setUnread(result.unread))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    listThreadsFn({ data: { deckId } })
      .then((result) => {
        if (cancelled) return
        setThreads([...result.threads].sort(byCreated))
        setRights({ userId: result.userId, canComment: result.canComment, canResolve: result.canResolve })
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load comments')
      })
    refreshUnread()
    return () => {
      cancelled = true
    }
  }, [deckId, refreshUnread])

  useEffect(
    () =>
      session.subscribeStateless((payload) => {
        let message: { channel?: unknown; threadId?: unknown }
        try {
          message = JSON.parse(payload) as { channel?: unknown; threadId?: unknown }
        } catch {
          return
        }
        if (message.channel !== 'comments' || typeof message.threadId !== 'string') return
        const threadId = message.threadId
        getThreadFn({ data: { deckId, threadId } })
          .then((result) => {
            upsert(threadId, result.thread)
            refreshUnread()
          })
          .catch(() => undefined)
      }),
    [session, deckId, upsert, refreshUnread],
  )

  return { loaded, threads, userId: rights.userId, canComment: rights.canComment, canResolve: rights.canResolve, unread, error, upsert, refreshUnread }
}

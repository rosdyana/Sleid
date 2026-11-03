import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

/**
 * The phone remote. Anyone with the link can use it: the token in the path is the only credential, and it lasts
 * 30 minutes or until the presenter closes it. The page shows the presenter's current slide and notes, and sends
 * Prev and Next. It sends no referrer and asks search engines not to index it.
 */
export const Route = createFileRoute('/r/$token')({
  head: () => ({
    meta: [
      { name: 'robots', content: 'noindex, nofollow' },
      { name: 'referrer', content: 'no-referrer' },
      { title: 'Sleid remote' },
    ],
  }),
  component: RemotePage,
})

interface RemoteState {
  presenterOnline: boolean
  state: { slide: number; total: number; slideId: string; notes: string; title: string } | null
}

const POLL_MS = 1000
const STOP_STATUSES = new Set([401, 403, 410])

function RemotePage() {
  const { token } = Route.useParams()
  const [remote, setRemote] = useState<RemoteState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const stopped = useRef(false)

  useEffect(() => {
    stopped.current = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const res = await fetch(`/api/remote/${encodeURIComponent(token)}/state`, { cache: 'no-store', referrerPolicy: 'no-referrer' })
        const body = (await res.json().catch(() => ({}))) as RemoteState & { error?: string }
        if (!res.ok) {
          setProblem(body.error ?? 'The remote is not available.')
          if (STOP_STATUSES.has(res.status)) {
            stopped.current = true
            return
          }
        } else {
          setProblem(null)
          setRemote(body)
        }
      } catch {
        setProblem('No connection. Trying again…')
      }
      if (!stopped.current) timer = setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => {
      stopped.current = true
      if (timer) clearTimeout(timer)
    }
  }, [token])

  async function send(action: 'next' | 'prev') {
    if (sending) return
    setSending(true)
    try {
      const res = await fetch(`/api/remote/${encodeURIComponent(token)}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setProblem(body.error ?? 'The command was not sent.')
      } else {
        setProblem(null)
      }
    } catch {
      setProblem('The command was not sent. Check the connection.')
    } finally {
      setSending(false)
    }
  }

  const state = remote?.state ?? null
  const online = remote?.presenterOnline ?? false
  return (
    <main className="flex min-h-screen flex-col bg-[#202124] text-white" data-testid="phone-remote">
      <header className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="truncate text-[15px] font-medium">{state?.title ?? 'Sleid remote'}</span>
        <span className={`shrink-0 text-[12px] ${online ? 'text-emerald-300' : 'text-amber-300'}`} data-testid="phone-presenter-status">
          {online ? 'Connected' : 'Presenter not open'}
        </span>
      </header>
      <div className="px-4 pb-2 text-center">
        <div className="text-[28px] font-semibold tabular-nums" data-testid="phone-counter">
          {state ? `${state.slide} / ${state.total}` : '…'}
        </div>
      </div>
      <section aria-label="Notes" className="mx-4 min-h-0 flex-1 overflow-y-auto rounded bg-white/5 p-4">
        <p data-testid="phone-notes" className="whitespace-pre-wrap text-[18px] leading-snug">
          {state ? state.notes || <span className="text-white/50">No notes for this slide.</span> : 'Waiting for the presenter…'}
        </p>
      </section>
      {problem && (
        <p role="alert" className="px-4 pt-2 text-center text-[14px] text-amber-200" data-testid="phone-problem">
          {problem}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 p-4" style={{ height: '34vh' }}>
        <button
          type="button"
          onClick={() => send('prev')}
          disabled={sending}
          className="rounded-2xl bg-white/15 text-[24px] font-semibold active:bg-white/30 disabled:opacity-60"
          data-testid="phone-prev"
        >
          ← Prev
        </button>
        <button
          type="button"
          onClick={() => send('next')}
          disabled={sending}
          className="rounded-2xl bg-accent text-[24px] font-semibold active:brightness-90 disabled:opacity-60"
          data-testid="phone-next"
        >
          Next →
        </button>
      </div>
    </main>
  )
}

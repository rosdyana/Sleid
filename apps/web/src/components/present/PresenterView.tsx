// The presenter view: what the presenter sees while the audience sees the slide. It shows the current slide, the
// next slide, the notes in large type, the elapsed time and the clock, and sends prev/next to the audience window
// over BroadcastChannel. It does not need a collab connection: the audience window is the one that talks to the
// phone and to followers.
import { useEffect, useRef, useState } from 'react'
import type { Deck } from '@sleid/model'
import { CANVAS_W } from '~/components/editor/commands'
import { SlideSurface } from '~/components/editor/ElementView'
import { audienceUrl, openPresentChannel, type AudienceMessage, type PresentChannel, type PresenterMessage, type RemoteAction } from './present-channel'
import { RemotePanel } from './RemotePanel'

const CURRENT_WIDTH = 880
const NEXT_WIDTH = 420
const AUDIENCE_SILENCE_MS = 2500

export function PresenterView({ deck, deckId, sid, startSlide, origin }: { deck: Deck; deckId: string; sid: string; startSlide: number; origin: string }) {
  const total = deck.slides.length
  const [index, setIndex] = useState(() => clamp(startSlide, total))
  const [audienceAt, setAudienceAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const startedAt = useRef(Date.now())
  const channelRef = useRef<PresentChannel | null>(null)
  const audienceWindow = useRef<Window | null>(null)

  useEffect(() => {
    const channel = openPresentChannel<AudienceMessage>(sid, (message) => {
      if (message.type !== 'state') return
      setIndex(clamp(message.index, total))
      setAudienceAt(Date.now())
    })
    channelRef.current = channel
    channel.post({ type: 'hello' } satisfies PresenterMessage)
    return () => {
      channel.close()
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [sid, total])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  const send = (action: RemoteAction) => channelRef.current?.post({ type: 'command', action } satisfies PresenterMessage)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        channelRef.current?.post({ type: 'command', action: 'next' } satisfies PresenterMessage)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        channelRef.current?.post({ type: 'command', action: 'prev' } satisfies PresenterMessage)
      } else if (e.key === 'Home') {
        channelRef.current?.post({ type: 'command', action: 'first' } satisfies PresenterMessage)
      } else if (e.key === 'End') {
        channelRef.current?.post({ type: 'command', action: 'last' } satisfies PresenterMessage)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const current = deck.slides[index - 1]
  const next = deck.slides[index]
  const elapsed = formatElapsed(now - startedAt.current)
  const clock = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const audienceOpen = audienceAt !== null && now - audienceAt < AUDIENCE_SILENCE_MS

  function openAudience() {
    audienceWindow.current = window.open(audienceUrl(deckId, sid, index), `sleid-audience-${sid}`)
  }

  return (
    <div className="flex h-screen flex-col bg-[#202124] text-white" data-testid="presenter-view">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-[14px] font-medium">{deck.title}</span>
          <span className="rounded bg-white/10 px-2 py-0.5 text-[12px]" data-testid="presenter-counter">
            Slide {index} of {total}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-[13px]">
          <span data-testid="presenter-elapsed" className="tabular-nums">
            {elapsed}
          </span>
          <span className="tabular-nums text-white/70">{clock}</span>
          <span data-testid="audience-status" className={audienceOpen ? 'text-emerald-300' : 'text-amber-300'}>
            {audienceOpen ? 'Audience window open' : 'Audience window not connected'}
          </span>
          {!audienceOpen && (
            <button type="button" onClick={openAudience} className="rounded bg-accent px-3 py-1 font-medium text-white hover:brightness-110">
              Open audience window
            </button>
          )}
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_360px] gap-4 p-4">
        <div className="flex min-h-0 flex-col gap-4">
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {current && (
              <div className="overflow-hidden rounded bg-white shadow-lg" data-testid="presenter-current">
                <SlideSurface slide={current} theme={deck.theme} brand={deck.brand} scale={CURRENT_WIDTH / CANVAS_W} />
              </div>
            )}
          </div>
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-white/60">Next</div>
              {next ? (
                <div className="overflow-hidden rounded bg-white opacity-90" data-testid="presenter-next">
                  <SlideSurface slide={next} theme={deck.theme} brand={deck.brand} scale={NEXT_WIDTH / CANVAS_W} />
                </div>
              ) : (
                <div className="grid h-[236px] w-[420px] place-items-center rounded border border-white/20 text-white/60">End of deck</div>
              )}
            </div>
            <div className="flex flex-1 gap-2 self-end">
              <button type="button" onClick={() => send('prev')} className="rounded bg-white/15 px-5 py-3 text-[15px] font-medium hover:bg-white/25" aria-label="Previous slide">
                ← Prev
              </button>
              <button type="button" onClick={() => send('next')} className="rounded bg-accent px-5 py-3 text-[15px] font-medium hover:brightness-110" aria-label="Next slide">
                Next →
              </button>
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-4">
          <section aria-label="Speaker notes" className="flex min-h-[10rem] flex-1 flex-col rounded bg-white/5 p-3">
            <h2 className="mb-2 text-[11px] uppercase tracking-wide text-white/60">Notes</h2>
            <p data-testid="presenter-notes" className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[18px] leading-snug">
              {current?.notes || <span className="text-white/50">No notes for this slide.</span>}
            </p>
          </section>
          <div className="max-h-[55%] shrink-0 overflow-y-auto rounded bg-white/5 p-3">
            <RemotePanel deckId={deckId} sid={sid} origin={origin} />
          </div>
        </div>
      </div>
    </div>
  )
}

function clamp(n: number, total: number): number {
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, Math.max(1, total))
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

import { ClientOnly, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Deck } from '@sleid/model'
import { PresentDeck, type PresentControl, type PresentPosition } from '~/components/present/PresentDeck'
import { RemoteChannel } from '~/components/present/remote-channel'
import {
  newSessionId,
  openPresentChannel,
  presenterUrl,
  type PresentChannel,
  SESSION_ID,
  type PresenterMessage,
  type RemoteAction,
} from '~/components/present/present-channel'
import { getPresentDeckFn } from '~/lib/deck-doc.functions'
import { getCollabTokenFn } from '~/lib/collab.functions'

/**
 * The audience window. `sid` is the presenter session: this window answers the presenter view, applies phone
 * commands, and publishes its slide. `follow` is another session: this window only shows the slide that session is on.
 */
export const Route = createFileRoute('/_authed/d/$deckId/present')({
  validateSearch: (search: Record<string, unknown>) => {
    const n = Number(search.slide)
    const sid = typeof search.sid === 'string' && SESSION_ID.test(search.sid) ? search.sid : undefined
    const follow = typeof search.follow === 'string' && SESSION_ID.test(search.follow) ? search.follow : undefined
    return { slide: Number.isInteger(n) && n > 0 ? n : undefined, sid, follow }
  },
  loader: ({ params }) => getPresentDeckFn({ data: { deckId: params.deckId } }),
  component: PresentPage,
})

function PresentPage() {
  const { deckJson } = Route.useLoaderData()
  const { deckId } = Route.useParams()
  const { slide, sid, follow } = Route.useSearch()
  const navigate = useNavigate()

  // A presentation always has a session id: the editor passes one, and a bare link gets one here.
  useEffect(() => {
    if (sid || follow) return
    void navigate({ to: '/d/$deckId/present', params: { deckId }, search: (prev) => ({ slide: prev.slide, follow: prev.follow, sid: newSessionId() }), replace: true })
  }, [sid, follow, deckId, navigate])

  return (
    <ClientOnly fallback={<div className="fixed inset-0 bg-black" />}>
      <PresentFromState deckId={deckId} deckJson={deckJson} startSlide={slide} sid={sid} follow={follow} />
    </ClientOnly>
  )
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

function PresentFromState({ deckId, deckJson, startSlide, sid, follow }: { deckId: string; deckJson: string; startSlide?: number; sid?: string; follow?: string }) {
  const deck: Deck = useMemo(() => JSON.parse(deckJson) as Deck, [deckJson])

  const control = useRef<PresentControl | null>(null)
  const position = useRef<PresentPosition | null>(null)
  const deckRef = useRef(deck)
  deckRef.current = deck
  const remoteRef = useRef<RemoteChannel | null>(null)
  const localRef = useRef<PresentChannel | null>(null)
  const [following, setFollowing] = useState(false)

  const applyAction = useRef((action: RemoteAction) => {
    const c = control.current
    if (!c) return
    if (action === 'next') c.next()
    else if (action === 'prev') c.prev()
    else if (action === 'first') c.first()
    else c.last()
  })

  // Presenting: answer the presenter view and run its commands. Phone commands arrive through the remote channel below.
  useEffect(() => {
    if (!sid) return
    const local = openPresentChannel<PresenterMessage>(sid, (message) => {
      if (message.type === 'hello') {
        if (position.current) local.post({ type: 'state', ...position.current })
      } else if (message.type === 'command') {
        applyAction.current(message.action)
      }
    })
    localRef.current = local
    return () => {
      local.close()
      if (localRef.current === local) localRef.current = null
    }
  }, [sid])

  // The collab channel: presenting publishes this window's slide; following listens to another session's slide.
  useEffect(() => {
    const listen = sid ?? follow
    if (!listen) return
    const remote = new RemoteChannel({
      deckId,
      sid: listen,
      publish: !!sid,
      fetchToken: async () => (await getCollabTokenFn({ data: { deckId } })).token,
      onCommand: (action) => applyAction.current(action),
      onState: (reported) => {
        if (!sid && follow) control.current?.goToSlide(reported.slideId)
      },
    })
    remoteRef.current = remote
    setFollowing(!sid && !!follow)
    return () => {
      remote.destroy()
      if (remoteRef.current === remote) remoteRef.current = null
    }
  }, [deckId, sid, follow])

  // Presenter keys: S opens the presenter view for this session, at the slide on screen.
  useEffect(() => {
    if (!sid) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return
      e.preventDefault()
      window.open(presenterUrl(deckId, sid, position.current?.index ?? startSlide ?? 1), `sleid-presenter-${sid}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deckId, sid, startSlide])

  const onPosition = useMemo(
    () => (next: PresentPosition) => {
      position.current = next
      if (!sid) return
      const current = deckRef.current
      const notes = current.slides[next.index - 1]?.notes ?? ''
      remoteRef.current?.publish({ slide: next.index, total: next.total, slideId: next.slideId, notes, title: current.title })
      localRef.current?.post({ type: 'state', ...next })
    },
    [sid],
  )

  return (
    <>
      <PresentDeck deck={deck} startSlide={startSlide} control={control} onPosition={onPosition} />
      {following && (
        <div className="pointer-events-none fixed bottom-2 left-3 z-[60] rounded bg-black/50 px-2 py-1 text-[12px] text-white" data-testid="follow-badge">
          Following the presenter
        </div>
      )}
    </>
  )
}

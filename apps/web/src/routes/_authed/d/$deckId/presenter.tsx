import { ClientOnly, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import type { Deck } from '@sleid/model'
import { PresenterView } from '~/components/present/PresenterView'
import { newSessionId, SESSION_ID } from '~/components/present/present-channel'
import { getPresentDeckFn } from '~/lib/deck-doc.functions'

/** The presenter view: notes, next slide, timer, and the phone remote. Controls the audience window for the same session. */
export const Route = createFileRoute('/_authed/d/$deckId/presenter')({
  validateSearch: (search: Record<string, unknown>) => {
    const n = Number(search.slide)
    const sid = typeof search.sid === 'string' && SESSION_ID.test(search.sid) ? search.sid : undefined
    return { slide: Number.isInteger(n) && n > 0 ? n : undefined, sid }
  },
  loader: ({ params }) => getPresentDeckFn({ data: { deckId: params.deckId } }),
  component: PresenterPage,
})

function PresenterPage() {
  const { deckJson } = Route.useLoaderData()
  const { deckId } = Route.useParams()
  const { slide, sid } = Route.useSearch()
  const navigate = useNavigate()

  useEffect(() => {
    if (sid) return
    void navigate({ to: '/d/$deckId/presenter', params: { deckId }, search: (prev) => ({ slide: prev.slide, sid: newSessionId() }), replace: true })
  }, [sid, deckId, navigate])

  return (
    <ClientOnly fallback={<div className="fixed inset-0 bg-[#202124]" />}>
      {sid && <PresenterFromState deckId={deckId} deckJson={deckJson} startSlide={slide ?? 1} sid={sid} />}
    </ClientOnly>
  )
}

function PresenterFromState({ deckId, deckJson, startSlide, sid }: { deckId: string; deckJson: string; startSlide: number; sid: string }) {
  const deck: Deck = useMemo(() => JSON.parse(deckJson) as Deck, [deckJson])
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return <PresenterView deck={deck} deckId={deckId} sid={sid} startSlide={startSlide} origin={origin} />
}

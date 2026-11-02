import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import * as Y from 'yjs'
import { yDocToDeck } from '@sleid/model'
import { PresentDeck } from '~/components/present/PresentDeck'
import { base64ToBytes } from '~/lib/base64'
import { getDeckStateFn } from '~/lib/deck-doc.functions'

export const Route = createFileRoute('/_authed/d/$deckId/present')({
  validateSearch: (search: Record<string, unknown>) => {
    const n = Number(search.slide)
    return { slide: Number.isInteger(n) && n > 0 ? n : undefined }
  },
  loader: ({ params }) => getDeckStateFn({ data: { deckId: params.deckId } }),
  component: PresentPage,
})

function PresentPage() {
  const { state } = Route.useLoaderData()
  const { slide } = Route.useSearch()
  return (
    <ClientOnly fallback={<div className="fixed inset-0 bg-black" />}>
      <PresentFromState state={state} startSlide={slide} />
    </ClientOnly>
  )
}

function PresentFromState({ state, startSlide }: { state: string; startSlide?: number }) {
  const deck = useMemo(() => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, base64ToBytes(state))
    return yDocToDeck(doc)
  }, [state])
  return <PresentDeck deck={deck} startSlide={startSlide} />
}

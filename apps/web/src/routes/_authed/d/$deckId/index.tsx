import { ClientOnly, createFileRoute, notFound, useRouteContext } from '@tanstack/react-router'
import { EditorShell } from '~/components/editor/EditorShell'
import { getDeckFn } from '~/lib/decks.functions'
import { getDeckStateFn } from '~/lib/deck-doc.functions'

export const Route = createFileRoute('/_authed/d/$deckId/')({
  loader: async ({ params }) => {
    const [deck, doc] = await Promise.all([getDeckFn({ data: { deckId: params.deckId } }), getDeckStateFn({ data: { deckId: params.deckId } })])
    if (!deck) throw notFound()
    return { deck, state: doc.state }
  },
  component: DeckPage,
})

function DeckPage() {
  const { deck, state } = Route.useLoaderData()
  const { session } = useRouteContext({ from: '/_authed' })
  return (
    <ClientOnly fallback={<div className="grid h-screen place-items-center text-ink-muted">Opening deck…</div>}>
      <EditorShell key={deck.id} deck={deck} user={session} state={state} />
    </ClientOnly>
  )
}

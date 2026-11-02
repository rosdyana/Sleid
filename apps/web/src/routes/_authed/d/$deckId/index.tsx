import { createFileRoute, notFound, useRouteContext } from '@tanstack/react-router'
import { EditorShell } from '~/components/editor/EditorShell'
import { getDeckFn } from '~/lib/decks.functions'

export const Route = createFileRoute('/_authed/d/$deckId/')({
  loader: async ({ params }) => {
    const deck = await getDeckFn({ data: { deckId: params.deckId } })
    if (!deck) throw notFound()
    return deck
  },
  component: DeckPage,
})

function DeckPage() {
  const deck = Route.useLoaderData()
  const { session } = useRouteContext({ from: '/_authed' })
  return <EditorShell key={deck.id} deck={deck} user={session} />
}

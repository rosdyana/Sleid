import { ClientOnly, createFileRoute, notFound, useRouteContext } from '@tanstack/react-router'
import { EditorShell } from '~/components/editor/EditorShell'
import { getDeckFn } from '~/lib/decks.functions'
import { redeemShareLinkFn } from '~/lib/sharing.functions'

export const Route = createFileRoute('/_authed/d/$deckId/')({
  validateSearch: (search: Record<string, unknown>): { share?: string } => {
    const share = typeof search.share === 'string' && search.share.length >= 16 && search.share.length <= 128 ? search.share : undefined
    return share ? { share } : {}
  },
  loaderDeps: ({ search }) => ({ share: search.share }),
  loader: async ({ params, deps }) => {
    if (deps.share) {
      // A stale or wrong link is not an error here: the membership check below decides access.
      await redeemShareLinkFn({ data: { deckId: params.deckId, token: deps.share } }).catch(() => undefined)
    }
    const deck = await getDeckFn({ data: { deckId: params.deckId } })
    if (!deck) throw notFound()
    return { deck }
  },
  component: DeckPage,
})

function DeckPage() {
  const { deck } = Route.useLoaderData()
  const { session } = useRouteContext({ from: '/_authed' })
  return (
    <ClientOnly fallback={<div className="grid h-screen place-items-center text-ink-muted">Opening deck…</div>}>
      <EditorShell key={deck.id} deck={deck} user={session} />
    </ClientOnly>
  )
}

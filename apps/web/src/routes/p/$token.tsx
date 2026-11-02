import { ClientOnly, createFileRoute, notFound } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { Deck } from '@sleid/model'
import { PresentDeck } from '~/components/present/PresentDeck'
import { getPublishedDeckFn } from '~/lib/publish.functions'

/** Public read-only presentation of a published deck. No sign-in. */
export const Route = createFileRoute('/p/$token')({
  loader: async ({ params }) => {
    const result = await getPublishedDeckFn({ data: { token: params.token } })
    if (!result.found) throw notFound()
    return result
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${(JSON.parse(loaderData.deckJson) as Deck).title} · Sleid` : 'Sleid' },
      ...(loaderData && !loaderData.indexable ? [{ name: 'robots', content: 'noindex, nofollow' }] : []),
    ],
  }),
  component: PublishedPage,
})

function PublishedPage() {
  const { deckJson } = Route.useLoaderData()
  const deck = useMemo(() => JSON.parse(deckJson) as Deck, [deckJson])
  return (
    <ClientOnly fallback={<div className="fixed inset-0 bg-black" />}>
      <PresentDeck deck={deck} />
      <a
        href="/"
        className="fixed bottom-2 right-3 z-[60] rounded bg-black/50 px-2 py-1 text-[12px] text-white no-underline hover:bg-black/70"
      >
        Made with Sleid
      </a>
    </ClientOnly>
  )
}

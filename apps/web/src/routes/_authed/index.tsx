import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createBlankDeckFn, listRecentDecksFn } from '~/lib/decks.functions'
import { authClient } from '~/lib/auth-client'

export const Route = createFileRoute('/_authed/')({
  loader: () => listRecentDecksFn(),
  component: Dashboard,
})

function Dashboard() {
  const decks = Route.useLoaderData()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function newBlankDeck() {
    setBusy(true)
    setError(null)
    try {
      const { id } = await createBlankDeckFn()
      await navigate({ to: '/d/$deckId', params: { deckId: id } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create deck')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-rule bg-white px-4">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded bg-accent text-white font-semibold">S</span>
          <span className="text-lg font-medium">Sleid</span>
        </div>
        <SignOutButton />
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-medium">Recent decks</h1>
          <button
            type="button"
            onClick={newBlankDeck}
            disabled={busy}
            className="rounded bg-accent px-4 py-2 font-medium text-white hover:brightness-95 disabled:opacity-60"
          >
            {busy ? 'Creating…' : 'Blank deck'}
          </button>
        </div>
        {error && <p className="mt-3 text-red-700">{error}</p>}

        {decks.length === 0 ? (
          <p className="mt-10 text-ink-muted">No decks yet. Create a blank deck to start.</p>
        ) : (
          <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {decks.map((deck) => (
              <li key={deck.id}>
                <Link
                  to="/d/$deckId"
                  params={{ deckId: deck.id }}
                  className="block rounded-lg border border-rule bg-white p-4 hover:border-accent hover:shadow-sm"
                >
                  <div className="aspect-video rounded border border-rule-soft bg-white shadow-inner" />
                  <div className="mt-3 flex items-center gap-1">
                    {deck.starred && <span className="text-accent" aria-label="Starred">★</span>}
                    <span className="truncate font-medium">{deck.title}</span>
                  </div>
                  <div className="mt-1 text-ink-muted">
                    Updated {new Date(deck.updatedAt).toLocaleDateString()}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function SignOutButton() {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover"
      onClick={async () => {
        await authClient.signOut()
        await navigate({ to: '/login' })
      }}
    >
      Sign out
    </button>
  )
}

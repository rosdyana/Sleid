import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { createBlankDeckFn, listRecentDecksFn, setStarredFn } from '~/lib/decks.functions'
import { authClient } from '~/lib/auth-client'

export const Route = createFileRoute('/_authed/')({
  loader: () => listRecentDecksFn(),
  component: Dashboard,
})

type Filter = 'all' | 'shared'
const ROLE_LABEL: Record<string, string> = { editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' }

function Dashboard() {
  const loaded = Route.useLoaderData()
  const [decks, setDecks] = useState(loaded)
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const visible = useMemo(() => (filter === 'shared' ? decks.filter((d) => d.role !== 'owner') : decks), [decks, filter])

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

  async function toggleStar(deckId: string, starred: boolean) {
    setDecks((prev) => prev.map((d) => (d.id === deckId ? { ...d, starred: !starred } : d)))
    try {
      await setStarredFn({ data: { deckId, starred: !starred } })
    } catch (e) {
      setDecks((prev) => prev.map((d) => (d.id === deckId ? { ...d, starred } : d)))
      setError(e instanceof Error ? e.message : 'Could not update star')
    }
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-rule bg-white px-4">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded bg-accent text-white font-semibold">S</span>
          <span className="text-lg font-medium">Sleid</span>
        </div>
        <div className="flex items-center gap-1">
          <Link to="/settings/ai" className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
            AI settings
          </Link>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1" role="tablist" aria-label="Deck filter">
            {(
              [
                ['all', 'All decks'],
                ['shared', 'Shared with me'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                onClick={() => setFilter(id)}
                className={`rounded px-3 py-1.5 font-medium ${filter === id ? 'bg-accent-soft text-[#001d35]' : 'text-ink-muted hover:bg-hover'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Link to="/wizard/new" className="rounded border border-accent px-4 py-2 font-medium text-accent hover:bg-hover">✨ New from prompt</Link>
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

        {visible.length === 0 ? (
          <p className="mt-10 text-ink-muted">
            {filter === 'shared' ? 'Nothing has been shared with you yet.' : 'No decks yet. Create a blank deck to start.'}
          </p>
        ) : (
          <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {visible.map((deck) => (
              <li key={deck.id} className="relative">
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
                  <div className="mt-1 flex items-center gap-2 text-ink-muted">
                    <span>Updated {new Date(deck.updatedAt).toLocaleDateString()}</span>
                    {deck.role !== 'owner' && (
                      <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">{ROLE_LABEL[deck.role] ?? deck.role}</span>
                    )}
                  </div>
                </Link>
                <button
                  type="button"
                  aria-label={deck.starred ? `Unstar ${deck.title}` : `Star ${deck.title}`}
                  aria-pressed={deck.starred}
                  onClick={() => void toggleStar(deck.id, deck.starred)}
                  className={`absolute right-2 top-2 rounded bg-white/90 px-1.5 py-0.5 shadow-sm hover:bg-hover ${deck.starred ? 'text-amber-500' : 'text-ink-muted'}`}
                >
                  ★
                </button>
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

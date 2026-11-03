import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { createBlankDeckFn, listRecentDecksFn, setStarredFn } from '~/lib/decks.functions'
import { markMentionsSeenFn, myMentionsFn } from '~/lib/comments.functions'
import { authClient } from '~/lib/auth-client'
import { ImportDialog, type Tab as ImportTab } from '~/components/import/ImportDialog'
import { TemplateGallery, type GalleryTab } from '~/components/templates/TemplateGallery'
import { TemplateCard, type TemplateItem } from '~/components/templates/TemplateCard'
import { useStartFromTemplate } from '~/components/templates/start-from-template'
import { listTemplatesFn } from '~/lib/templates.functions'

export const Route = createFileRoute('/_authed/')({
  // ?gallery=builtin|mine|shared opens the template gallery on that tab (the save-template dialog links here).
  validateSearch: (search: Record<string, unknown>): { gallery?: GalleryTab } =>
    search.gallery === 'builtin' || search.gallery === 'mine' || search.gallery === 'shared' ? { gallery: search.gallery } : {},
  loader: async () => ({ decks: await listRecentDecksFn(), mentions: await myMentionsFn(), templates: await listTemplatesFn() }),
  component: Dashboard,
})

type Filter = 'all' | 'shared'
const ROLE_LABEL: Record<string, string> = { editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' }

function Dashboard() {
  const { decks: loadedDecks, mentions: loadedMentions, templates: loadedTemplates } = Route.useLoaderData()
  const search = Route.useSearch()
  const [decks, setDecks] = useState(loadedDecks)
  const [mentions, setMentions] = useState(loadedMentions)
  const [templates, setTemplates] = useState<TemplateItem[]>(loadedTemplates)
  const [gallery, setGallery] = useState<GalleryTab | null>(search.gallery ?? null)
  const startTemplate = useStartFromTemplate()
  const [mentionsOpen, setMentionsOpen] = useState(false)
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [menuOpen, setMenuOpen] = useState(false)
  const [importTab, setImportTab] = useState<ImportTab | null>(null)
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

  /** Opening the list marks the mentions as seen, which clears the badge. */
  function openMentions() {
    setMentionsOpen(true)
    if (mentions.unread > 0) {
      void markMentionsSeenFn().catch(() => undefined)
      setMentions((m) => ({ ...m, unread: 0, items: m.items.map((i) => ({ ...i, unread: false })) }))
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
          <button type="button" onClick={openMentions} className="relative rounded px-3 py-1.5 text-ink-muted hover:bg-hover" aria-haspopup="dialog">
            Mentions
            {mentions.unread > 0 && (
              <span data-testid="mentions-badge" aria-label={`${mentions.unread} unread mentions`} className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
                {mentions.unread}
              </span>
            )}
          </button>
          <Link to="/settings/ai" className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
            AI settings
          </Link>
          <SignOutButton />
        </div>
      </header>
      {mentionsOpen && <MentionsList items={mentions.items} onClose={() => setMentionsOpen(false)} />}
      {importTab && <ImportDialog initialTab={importTab} openInNewTab={false} onClose={() => setImportTab(null)} />}
      {gallery && (
        <TemplateGallery
          initialTab={gallery}
          onClose={() => {
            setGallery(null)
            void listTemplatesFn().then(setTemplates).catch(() => undefined)
          }}
        />
      )}

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
          <div className="relative flex" data-testid="new-menu">
            <button
              type="button"
              onClick={newBlankDeck}
              disabled={busy}
              className="rounded-l bg-accent px-4 py-2 font-medium text-white hover:brightness-95 disabled:opacity-60"
            >
              {busy ? 'Creating…' : 'New'}
            </button>
            <button
              type="button"
              aria-label="More ways to start a deck"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="grid place-items-center rounded-r border-l border-white/30 bg-accent px-2.5 text-white hover:brightness-95"
            >
              <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
                <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onMouseDown={() => setMenuOpen(false)} />
                <ul role="menu" aria-label="New" className="absolute right-0 top-full z-40 mt-1 w-64 rounded border border-rule bg-white py-1 shadow-lg">
                  <li role="none">
                    <button role="menuitem" type="button" className="block w-full px-3 py-2 text-left hover:bg-hover" onClick={() => { setMenuOpen(false); void newBlankDeck() }}>
                      Blank deck
                    </button>
                  </li>
                  <li role="none">
                    <Link role="menuitem" to="/wizard/new" className="block px-3 py-2 text-ink no-underline hover:bg-hover" onClick={() => setMenuOpen(false)}>
                      From wizard
                    </Link>
                  </li>
                  <li role="none">
                    <button role="menuitem" type="button" className="block w-full px-3 py-2 text-left hover:bg-hover" onClick={() => { setMenuOpen(false); setGallery('builtin') }}>
                      From template…
                    </button>
                  </li>
                  <li role="none" className="my-1 border-t border-rule" />
                  <li role="none">
                    <button role="menuitem" type="button" className="block w-full px-3 py-2 text-left hover:bg-hover" onClick={() => { setMenuOpen(false); setImportTab('file') }}>
                      Import file…
                    </button>
                  </li>
                  <li role="none">
                    <button role="menuitem" type="button" className="block w-full px-3 py-2 text-left hover:bg-hover" onClick={() => { setMenuOpen(false); setImportTab('google') }}>
                      Import from Google Slides…
                    </button>
                  </li>
                </ul>
              </>
            )}
          </div>
        </div>
        {error && <p className="mt-3 text-red-700">{error}</p>}

        <section aria-label="Start a new deck" className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-medium">Start a new deck</h2>
            <button type="button" data-testid="open-template-gallery" onClick={() => setGallery('builtin')} className="text-[13px] font-medium text-accent hover:underline">
              Template gallery
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-3" data-testid="start-row">
            <button
              type="button"
              data-testid="start-blank"
              onClick={newBlankDeck}
              disabled={busy || startTemplate.busyId !== null}
              className="flex w-44 shrink-0 flex-col gap-2 rounded-lg border border-dashed border-rule bg-white p-2 text-left hover:border-accent disabled:opacity-60"
            >
              <span className="grid aspect-video w-full place-items-center rounded bg-hover text-2xl text-ink-muted" aria-hidden="true">
                +
              </span>
              <span className="text-[13px] font-medium">Blank</span>
            </button>
            {templates.map((t) => (
              <TemplateCard key={t.id} template={t} testId={`start-template-${t.id}`} disabled={busy || startTemplate.busyId !== null} onPick={(picked) => void startTemplate.start(picked.id)} />
            ))}
          </div>
          {startTemplate.busyId !== null && <p role="status" className="mt-2 text-[13px] text-ink-muted">Creating the deck…</p>}
          {startTemplate.error && <p role="alert" className="mt-2 text-red-700">{startTemplate.error}</p>}
        </section>

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

function MentionsList({ items, onClose }: { items: Awaited<ReturnType<typeof myMentionsFn>>['items']; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Mentions" className="flex max-h-[80vh] w-[32rem] flex-col rounded-lg bg-white p-4 shadow-xl" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium">Mentions</h2>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-ink-muted hover:bg-hover">
            Close
          </button>
        </div>
        {items.length === 0 ? (
          <p className="text-ink-muted">Nobody has mentioned you in a comment yet.</p>
        ) : (
          <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto" data-testid="mentions-list">
            {items.map((item) => (
              <li key={item.commentId} data-unread={item.unread ? 'true' : 'false'} className="rounded border border-rule p-2">
                <Link to="/d/$deckId" params={{ deckId: item.deckId }} className="block no-underline hover:text-accent">
                  <div className="flex items-center gap-2 text-[12px] text-ink-muted">
                    {item.unread && <span className="rounded bg-red-600 px-1 text-[10px] font-semibold text-white">New</span>}
                    <span className="truncate font-medium text-ink">{item.deckTitle}</span>
                    <span className="ml-auto shrink-0">{new Date(item.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div className="mt-1 text-[13px]">
                    <span className="font-medium">{item.authorName}</span>: {item.snippet}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

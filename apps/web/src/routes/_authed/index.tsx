import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { z } from 'zod'
import {
  createBlankDeckFn,
  deleteDeckForeverFn,
  listRecentDecksFn,
  listTrashedDecksFn,
  moveDeckToTrashFn,
  restoreDeckFn,
  setStarredFn,
} from '~/lib/decks.functions'
import { copyDeckFn } from '~/lib/deck-doc.functions'
import { markMentionsSeenFn, myMentionsFn } from '~/lib/comments.functions'
import { authClient } from '~/lib/auth-client'
import { ImportDialog, type Tab as ImportTab } from '~/components/import/ImportDialog'
import { TemplateGallery, type GalleryTab } from '~/components/templates/TemplateGallery'
import { TemplateCard, type TemplateItem } from '~/components/templates/TemplateCard'
import { useStartFromTemplate } from '~/components/templates/start-from-template'
import { listTemplatesFn } from '~/lib/templates.functions'
import { MoreVertical, Plus, Restore, Star, Trash } from '~/components/icons'

export const Route = createFileRoute('/_authed/')({
  // ?gallery=builtin|mine|shared opens the template gallery on that tab (the save-template dialog links here).
  // ?trashed=<id>&trashedTitle=<title> comes from the editor's File menu. The dashboard shows the undo toast once, then strips them.
  validateSearch: (search: Record<string, unknown>): { view?: View; gallery?: GalleryTab; trashed?: string; trashedTitle?: string } => {
    const out: { view?: View; gallery?: GalleryTab; trashed?: string; trashedTitle?: string } = {}
    if (search.view === 'all' || search.view === 'shared' || search.view === 'trash') out.view = search.view
    if (search.gallery === 'builtin' || search.gallery === 'mine' || search.gallery === 'shared') out.gallery = search.gallery
    if (typeof search.trashed === 'string' && z.uuid().safeParse(search.trashed).success) {
      out.trashed = search.trashed
      if (typeof search.trashedTitle === 'string') out.trashedTitle = search.trashedTitle.slice(0, 200)
    }
    return out
  },
  loader: async () => ({ decks: await listRecentDecksFn(), mentions: await myMentionsFn(), templates: await listTemplatesFn() }),
  component: Dashboard,
})

type View = 'all' | 'shared' | 'trash'
const VIEWS: Array<[View, string]> = [
  ['all', 'All decks'],
  ['shared', 'Shared with me'],
  ['trash', 'Trash'],
]
type DeckItem = Awaited<ReturnType<typeof listRecentDecksFn>>[number]
type TrashItem = Awaited<ReturnType<typeof listTrashedDecksFn>>[number]
const ROLE_LABEL: Record<string, string> = { editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' }
const MENU_ITEM = 'block w-full px-3 py-2 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none'
const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

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
  const [view, setView] = useState<View>(search.view ?? 'all')
  const [menuOpen, setMenuOpen] = useState(false)
  const [importTab, setImportTab] = useState<ImportTab | null>(null)
  const [cardMenu, setCardMenu] = useState<string | null>(null)
  const cardMenuRef = useRef<HTMLUListElement>(null)
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  // The undo toast. It starts open when the editor sent the user here after a trash.
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(() =>
    search.trashed ? { id: search.trashed, title: search.trashedTitle ?? 'Untitled deck' } : null,
  )
  const undoButton = useRef<HTMLButtonElement>(null)
  // Set when a trash comes from a card menu, which is gone once the deck leaves the list. Focus moves to Undo instead.
  const focusUndo = useRef(false)
  const visible = useMemo(() => (view === 'shared' ? decks.filter((d) => d.role !== 'owner') : decks), [decks, view])
  // The trash list is loaded each time its tab opens, so it reflects decks trashed or restored on other tabs.
  const [trash, setTrash] = useState<TrashItem[] | null>(null)
  const [trashLoading, setTrashLoading] = useState(false)
  const [trashError, setTrashError] = useState<string | null>(null)
  const [restored, setRestored] = useState<{ id: string; title: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string; trigger: HTMLElement | null } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const trashSection = useRef<HTMLElement>(null)

  // Strip the trash params once the toast is up, so a reload does not show it again.
  useEffect(() => {
    if (search.trashed) void navigate({ to: '/', search: search.gallery ? { gallery: search.gallery } : {}, replace: true })
  }, [search.trashed, search.gallery, navigate])

  // The undo toast hides after 8 seconds. A new trash starts the timer again.
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), 8000)
    return () => window.clearTimeout(timer)
  }, [undo])

  useEffect(() => {
    if (undo && focusUndo.current) {
      focusUndo.current = false
      undoButton.current?.focus()
    }
  }, [undo])

  // Opening a card menu puts focus on its first item.
  useEffect(() => {
    if (cardMenu) cardMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [cardMenu])

  useEffect(() => {
    if (view !== 'trash') return
    let cancelled = false
    setTrashLoading(true)
    setTrashError(null)
    listTrashedDecksFn()
      .then((rows) => {
        if (!cancelled) setTrash(rows)
      })
      .catch((e: unknown) => {
        if (!cancelled) setTrashError(e instanceof Error ? e.message : 'Could not load the trash')
      })
      .finally(() => {
        if (!cancelled) setTrashLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view])

  useEffect(() => {
    if (!restored) return
    const timer = window.setTimeout(() => setRestored(null), 8000)
    return () => window.clearTimeout(timer)
  }, [restored])

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

  /** Closes a card menu. Focus goes back to its trigger when `returnFocus` is set (not after a trash, when the card is gone). */
  function closeCardMenu(deckId: string, returnFocus: boolean) {
    setCardMenu(null)
    if (returnFocus) triggers.current.get(deckId)?.focus()
  }

  async function makeCopy(deckId: string) {
    setCardMenu(null)
    setError(null)
    try {
      const { id } = await copyDeckFn({ data: { deckId } })
      await navigate({ to: '/d/$deckId', params: { deckId: id } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not copy deck')
    }
  }

  /** No confirm: the undo toast is the safety net. The card leaves at once and comes back if the server refuses. */
  async function moveToTrash(deck: DeckItem) {
    setCardMenu(null)
    setError(null)
    setRestored(null)
    const index = decks.findIndex((d) => d.id === deck.id)
    setDecks((prev) => prev.filter((d) => d.id !== deck.id))
    try {
      await moveDeckToTrashFn({ data: { deckId: deck.id } })
      focusUndo.current = true
      setUndo({ id: deck.id, title: deck.title })
    } catch (e) {
      setDecks((prev) => {
        const next = prev.slice()
        next.splice(index < 0 ? next.length : index, 0, deck)
        return next
      })
      setError(e instanceof Error ? e.message : 'Could not move the deck to trash')
    }
  }

  async function undoTrash() {
    if (!undo) return
    const { id } = undo
    setUndo(null)
    setError(null)
    try {
      await restoreDeckFn({ data: { deckId: id } })
      setDecks(await listRecentDecksFn())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This deck could not be restored')
    }
  }

  /** Brings a deck back from the Trash tab. The row leaves the list; the toast links to the deck. */
  async function restoreFromTrash(item: TrashItem) {
    setUndo(null)
    setTrashError(null)
    try {
      await restoreDeckFn({ data: { deckId: item.id } })
      setTrash((prev) => prev?.filter((t) => t.id !== item.id) ?? null)
      setRestored({ id: item.id, title: item.title })
      void listRecentDecksFn().then(setDecks).catch(() => undefined)
    } catch (e) {
      setTrashError(e instanceof Error ? e.message : 'This deck could not be restored')
    }
  }

  async function deleteForever() {
    if (!confirmDelete) return
    const { id } = confirmDelete
    setDeleting(true)
    setTrashError(null)
    try {
      await deleteDeckForeverFn({ data: { deckId: id } })
      setTrash((prev) => prev?.filter((t) => t.id !== id) ?? null)
      setConfirmDelete(null)
      // The row and its button are gone, so focus moves to the section instead of the trigger.
      trashSection.current?.focus()
    } catch (e) {
      setTrashError(e instanceof Error ? e.message : 'Could not delete the deck')
      setConfirmDelete(null)
    } finally {
      setDeleting(false)
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
            {VIEWS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`rounded px-3 py-1.5 font-medium ${view === id ? 'bg-accent-soft text-[#001d35]' : 'text-ink-muted hover:bg-hover'}`}
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

        {view !== 'trash' && (
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
                <span className="grid aspect-video w-full place-items-center rounded bg-hover text-ink-muted" aria-hidden="true">
                  <Plus size={24} />
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
        )}

        {view === 'trash' ? (
          <section ref={trashSection} tabIndex={-1} aria-label="Trash" className="mt-6 focus:outline-none">
            {trashLoading && trash === null && <p role="status" className="text-ink-muted">Loading trash…</p>}
            {trashError && <p role="alert" className="mt-2 text-red-700">{trashError}</p>}
            {trash && trash.length === 0 && (
              <p className="mt-6 text-ink-muted">Trash is empty. Decks you move to trash stay here until you delete them forever.</p>
            )}
            {trash && trash.length > 0 && (
              <ul aria-label="Trashed decks" className="divide-y divide-rule rounded-lg border border-rule bg-white">
                {trash.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{item.title}</div>
                      <div className="text-[13px] text-ink-muted">Moved to trash {new Date(item.deletedAt).toLocaleDateString()}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void restoreFromTrash(item)}
                      className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-hover ${FOCUS_RING}`}
                    >
                      <Restore size={14} />
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={(e) => setConfirmDelete({ id: item.id, title: item.title, trigger: e.currentTarget })}
                      className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] font-medium text-red-700 hover:bg-hover ${FOCUS_RING}`}
                    >
                      <Trash size={14} />
                      Delete forever
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : visible.length === 0 ? (
          <p className="mt-10 text-ink-muted">
            {view === 'shared' ? 'Nothing has been shared with you yet.' : 'No decks yet. Create a blank deck to start.'}
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
                    {deck.starred && (
                      <span role="img" className="text-accent" aria-label="Starred">
                        <Star size={14} filled />
                      </span>
                    )}
                    <span className="truncate font-medium">{deck.title}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-ink-muted">
                    <span>Updated {new Date(deck.updatedAt).toLocaleDateString()}</span>
                    {deck.role !== 'owner' && (
                      <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">{ROLE_LABEL[deck.role] ?? deck.role}</span>
                    )}
                  </div>
                </Link>
                <div className="absolute right-2 top-2 flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={deck.starred ? `Unstar ${deck.title}` : `Star ${deck.title}`}
                    aria-pressed={deck.starred}
                    onClick={() => void toggleStar(deck.id, deck.starred)}
                    className={`grid place-items-center rounded bg-white/90 px-1.5 py-0.5 shadow-sm hover:bg-hover ${FOCUS_RING} ${deck.starred ? 'text-amber-500' : 'text-ink-muted'}`}
                  >
                    <Star size={16} filled={deck.starred} />
                  </button>
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) triggers.current.set(deck.id, el)
                      else triggers.current.delete(deck.id)
                    }}
                    aria-label={`More actions for ${deck.title}`}
                    aria-haspopup="menu"
                    aria-expanded={cardMenu === deck.id}
                    onClick={() => setCardMenu((open) => (open === deck.id ? null : deck.id))}
                    className={`grid place-items-center rounded bg-white/90 px-1.5 py-0.5 text-ink-muted shadow-sm hover:bg-hover ${FOCUS_RING}`}
                  >
                    <MoreVertical size={16} />
                  </button>
                </div>
                {cardMenu === deck.id && (
                  <>
                    <div className="fixed inset-0 z-30" onMouseDown={() => closeCardMenu(deck.id, false)} />
                    <ul
                      ref={cardMenuRef}
                      role="menu"
                      aria-label={`Actions for ${deck.title}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          closeCardMenu(deck.id, true)
                        }
                      }}
                      className="absolute right-2 top-10 z-40 w-48 rounded border border-rule bg-white py-1 shadow-lg"
                    >
                      <li role="none">
                        <button
                          role="menuitem"
                          type="button"
                          className={MENU_ITEM}
                          onClick={() => {
                            closeCardMenu(deck.id, true)
                            window.open(`/d/${deck.id}`, '_blank', 'noopener')
                          }}
                        >
                          Open in new tab
                        </button>
                      </li>
                      <li role="none">
                        <button role="menuitem" type="button" className={MENU_ITEM} onClick={() => void makeCopy(deck.id)}>
                          Make a copy
                        </button>
                      </li>
                      {deck.role === 'owner' && (
                        <>
                          <li role="none" className="my-1 border-t border-rule" />
                          <li role="none">
                            <button role="menuitem" type="button" className={`${MENU_ITEM} text-red-700`} onClick={() => void moveToTrash(deck)}>
                              Move to trash
                            </button>
                          </li>
                        </>
                      )}
                    </ul>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
      {undo && (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded bg-[#202124] px-4 py-2 text-[13px] text-white shadow-lg">
          <span>“{undo.title}” moved to trash.</span>
          <button
            ref={undoButton}
            type="button"
            onClick={() => void undoTrash()}
            className="rounded px-2 py-1 font-medium text-white underline underline-offset-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Undo
          </button>
        </div>
      )}
      {restored && (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded bg-[#202124] px-4 py-2 text-[13px] text-white shadow-lg">
          <span>“{restored.title}” restored.</span>
          <Link
            to="/d/$deckId"
            params={{ deckId: restored.id }}
            className="rounded px-2 py-1 font-medium text-white underline underline-offset-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Open
          </Link>
        </div>
      )}
      {confirmDelete && (
        <DeleteForeverDialog
          title={confirmDelete.title}
          busy={deleting}
          trigger={confirmDelete.trigger}
          onConfirm={() => void deleteForever()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

/**
 * Confirm for deleting a trashed deck for good. Focus starts on Cancel, Tab stays inside, Escape cancels, and focus goes
 * back to the button that opened it.
 */
function DeleteForeverDialog({
  title,
  busy,
  trigger,
  onConfirm,
  onCancel,
}: {
  title: string
  busy: boolean
  trigger: HTMLElement | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus()
    return () => {
      if (trigger?.isConnected) trigger.focus()
    }
  }, [trigger])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!busy) onCancel()
      return
    }
    if (e.key !== 'Tab') return
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-forever-title"
        aria-describedby="delete-forever-body"
        onKeyDown={onKeyDown}
        className="w-[26rem] rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id="delete-forever-title" className="text-base font-medium">
          Delete “{title}” forever?
        </h2>
        <p id="delete-forever-body" className="mt-2 text-[13px] text-ink-muted">
          The deck, its comments, versions and images are deleted. This can&apos;t be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancel} type="button" onClick={onCancel} disabled={busy} className={`rounded px-3 py-1.5 text-ink-muted hover:bg-hover ${FOCUS_RING}`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded bg-red-700 px-3 py-1.5 font-medium text-white hover:brightness-95 disabled:opacity-60 ${FOCUS_RING}`}
          >
            Delete forever
          </button>
        </div>
      </div>
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

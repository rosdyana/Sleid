// Placeholder editor chrome modeled on Google Sheets. No slide editing yet (milestone 1).
import { useRef, useState } from 'react'
import { updateDeckFn } from '~/lib/decks.functions'

export type EditorDeck = { id: string; title: string; starred: boolean; role: string }
export type EditorUser = { name: string; email: string }

const MENUS = ['File', 'Edit', 'View', 'Insert', 'Format', 'Slide', 'Arrange', 'Tools', 'Extensions', 'Help']
const TOOLBAR = ['Undo', 'Redo', 'Print', 'Zoom', '|', 'Text', 'Bold', 'Italic', 'Underline', '|', 'Fill', 'Border', 'Align', '|', 'Insert image', 'Add shape']
const SECTION_TABS = ['Slides']

export function EditorShell({ deck, user }: { deck: EditorDeck; user: EditorUser }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app-bg">
      <TitleBar deck={deck} user={user} />
      <MenuBar />
      <Toolbar />
      <FormulaBar />
      <div className="flex min-h-0 flex-1">
        <Filmstrip />
        <CanvasArea />
        <SidePanel />
      </div>
      <SectionTabs />
    </div>
  )
}

function TitleBar({ deck, user }: { deck: EditorDeck; user: EditorUser }) {
  const [title, setTitle] = useState(deck.title)
  const savedTitle = useRef(deck.title)
  const [starred, setStarred] = useState(deck.starred)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function saveTitle() {
    const next = title.trim() || 'Untitled presentation'
    setTitle(next)
    if (next === savedTitle.current) return
    try {
      setSaveError(null)
      await updateDeckFn({ data: { deckId: deck.id, title: next } })
      savedTitle.current = next
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  async function toggleStar() {
    const next = !starred
    setStarred(next)
    try {
      setSaveError(null)
      await updateDeckFn({ data: { deckId: deck.id, starred: next } })
    } catch (e) {
      setStarred(!next)
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 bg-white px-3">
      <a href="/" aria-label="Back to decks" className="grid size-9 place-items-center rounded bg-accent text-base font-semibold text-white">
        S
      </a>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-1">
          <input
            aria-label="Deck title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className="w-72 rounded px-1 text-lg text-ink outline-none hover:shadow-[inset_0_0_0_1px_var(--color-rule)] focus:shadow-[inset_0_0_0_2px_var(--color-accent)]"
          />
          <button
            type="button"
            aria-label={starred ? 'Unstar deck' : 'Star deck'}
            aria-pressed={starred}
            onClick={toggleStar}
            className={`rounded px-1.5 text-base hover:bg-hover ${starred ? 'text-amber-500' : 'text-ink-muted'}`}
          >
            {starred ? '★' : '☆'}
          </button>
        </div>
        <div className="px-1 text-[11px] text-ink-muted">
          {saveError ? <span className="text-red-700">{saveError}</span> : 'All changes saved in Sleid'}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          disabled
          title="Sharing arrives in milestone 2"
          className="rounded-full bg-accent-soft px-4 py-1.5 font-medium text-[#001d35] opacity-70"
        >
          Share
        </button>
        <div
          aria-label={`Signed in as ${user.email}`}
          title={user.email}
          className="grid size-8 place-items-center rounded-full bg-[#7c4dff] text-sm font-medium text-white"
        >
          {(user.name.trim().charAt(0) || '?').toUpperCase()}
        </div>
      </div>
    </header>
  )
}

function MenuBar() {
  return (
    <nav aria-label="Menu" className="flex h-7 shrink-0 items-center gap-0.5 px-2">
      <ul role="menubar" className="flex items-center gap-0.5">
        {MENUS.map((m) => (
          <li key={m} role="none">
            <button type="button" role="menuitem" className="rounded px-2 py-0.5 hover:bg-hover">
              {m}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function Toolbar() {
  return (
    <div role="toolbar" aria-label="Formatting" className="flex h-9 shrink-0 items-center gap-1 border-y border-rule bg-white px-2">
      {TOOLBAR.map((item, i) =>
        item === '|' ? (
          <span key={`sep-${i}`} className="mx-1 h-5 w-px bg-rule" aria-hidden />
        ) : (
          <button key={item} type="button" aria-label={item} className="rounded px-2 py-1 text-ink hover:bg-hover">
            {item}
          </button>
        ),
      )}
    </div>
  )
}

function FormulaBar() {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-rule bg-white px-2 text-ink-muted">
      <span className="w-16 rounded border border-rule-soft px-2 text-center text-[12px]">Slide 1</span>
      <span className="font-medium italic text-ink-muted">fx</span>
      <span className="h-4 w-px bg-rule" aria-hidden />
      <span className="truncate text-ink-muted">Select an element to edit its content</span>
    </div>
  )
}

function Filmstrip() {
  return (
    <aside aria-label="Slides" className="flex w-44 shrink-0 flex-col gap-3 overflow-y-auto border-r border-rule bg-[#f1f3f4] p-3">
      <div className="flex gap-2">
        <span className="w-4 pt-1 text-right text-[11px] text-ink-muted">1</span>
        <div className="aspect-video w-full rounded-sm border-2 border-accent bg-white" />
      </div>
    </aside>
  )
}

function CanvasArea() {
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-canvas-gutter p-8">
      <div
        aria-label="Slide canvas"
        className="flex aspect-video w-full max-w-4xl items-center justify-center rounded-sm bg-white shadow-md"
      >
        <span className="text-ink-muted">Slide canvas (milestone 1)</span>
      </div>
    </main>
  )
}

function SidePanel() {
  return (
    <aside aria-label="Side panel" className="flex w-72 shrink-0 flex-col border-l border-rule bg-white">
      <div className="flex h-9 items-center border-b border-rule px-4 font-medium">Properties</div>
      <div className="p-4 text-ink-muted">Select an element to see its properties.</div>
    </aside>
  )
}

function SectionTabs() {
  return (
    <div className="flex h-8 shrink-0 items-end gap-1 border-t border-rule bg-[#f1f3f4] px-2">
      <button type="button" aria-label="Add slide" className="mb-1 rounded px-2 text-lg leading-none text-ink-muted hover:bg-hover">
        +
      </button>
      {SECTION_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          aria-current="page"
          className="h-7 rounded-t border border-b-0 border-rule bg-white px-4 font-medium text-accent"
        >
          {tab}
        </button>
      ))}
    </div>
  )
}

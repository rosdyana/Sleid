// The editor: one open deck. Owns the doc session, UI state, selection, the
// keyboard map and the overlays. Everything the user can do is an action in
// actions.ts, which builds deck-ops and applies them through the session.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChartElement, Element as SlideElement, RichText } from '@sleid/model'
import { createActions, currentSlide, slideIndex, type PromptRequest, type UiState } from './actions.ts'
import { DocSession, useDeck, useSaveState, useUndoState } from './doc-session.ts'
import { Filmstrip } from './Filmstrip.tsx'
import { SlideCanvas } from './Canvas.tsx'
import { SidePanel } from './SidePanel.tsx'
import { DataGrid } from './DataGrid.tsx'
import { BottomBar } from './BottomBar.tsx'
import { MenuBar, buildMenus } from './MenuBar.tsx'
import { ContextMenu, PromptDialog, ShortcutsDialog, Toast, type MenuEntry } from './Overlays.tsx'
import { FormulaBar, TitleBar, Toolbar } from './Chrome.tsx'
import { bytesToBase64, base64ToBytes } from '~/lib/base64'
import { pushDeckUpdateFn } from '~/lib/deck-doc.functions'
import { updateDeckFn } from '~/lib/decks.functions'

export type EditorDeck = { id: string; title: string; starred: boolean; role: string }
export type EditorUser = { name: string; email: string }

const DEFAULT_UI: UiState = {
  showNotes: false,
  showGuides: false,
  zoom: 'fit',
  sidePanel: 'format',
  dataElementId: null,
  section: null,
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

export function EditorShell({ deck: meta, user, state }: { deck: EditorDeck; user: EditorUser; state: string }) {
  const session = useMemo(
    () =>
      new DocSession(base64ToBytes(state), async (update) => {
        await pushDeckUpdateFn({ data: { deckId: meta.id, update: bytesToBase64(update) } })
      }),
    // A new deck id or a fresh load means a new doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta.id, state],
  )
  // Not destroyed on unmount: React StrictMode runs effect cleanups without a real
  // unmount, and the session must survive that. Pending edits are pushed instead.
  useEffect(() => () => void session.flush(), [session])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (session.isDirty()) e.preventDefault()
    }
    const onPageHide = () => void session.flush()
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [session])

  const deck = useDeck(session.doc)
  const save = useSaveState(session)
  const { canUndo, canRedo } = useUndoState(session)

  const [ui, setUiState] = useState<UiState>(DEFAULT_UI)
  const setUi = useCallback((patch: Partial<UiState>) => setUiState((prev) => ({ ...prev, ...patch })), [])
  const [slideIdState, setSlideId] = useState(() => deck.slides[0]?.id ?? '')
  const [selection, setSelection] = useState<string[]>([])
  const [editingId, setEditing] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [context, setContext] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const [starred, setStarred] = useState(meta.starred)
  const titleRef = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)

  const slide = currentSlide(deck, slideIdState)
  const slideId = slide.id
  const validSelection = selection.filter((id) => slide.elements.some((e) => e.id === id))
  const selectedEls = slide.elements.filter((e) => validSelection.includes(e.id))
  const single: SlideElement | undefined = selectedEls.length === 1 ? selectedEls[0] : undefined
  const dataChart = ui.dataElementId
    ? (slide.elements.find((e): e is ChartElement => e.id === ui.dataElementId && e.type === 'chart') ?? undefined)
    : undefined

  const toast = useCallback((message: string) => setToastMessage(message), [])
  const onToastDone = useCallback(() => setToastMessage(null), [])

  const actions = createActions({
    session,
    deck,
    deckId: meta.id,
    slideId,
    selection: validSelection,
    ui,
    setUi,
    setSelection,
    setSlideId,
    setEditing,
    toast,
    prompt: setPrompt,
    openShortcuts: () => setShortcutsOpen(true),
    focusTitle: () => {
      titleRef.current?.focus()
      titleRef.current?.select()
    },
    navigate: async (href) => {
      await session.flush()
      window.location.assign(href)
    },
  })

  const menus = buildMenus({
    actions,
    deck,
    canUndo,
    canRedo,
    hasSelection: validSelection.length > 0,
    ui,
    setUi,
    undo: () => session.undo(),
    redo: () => session.redo(),
    focusTitle: () => {
      titleRef.current?.focus()
      titleRef.current?.select()
    },
    pickImage: () => imageInput.current?.click(),
    prompt: setPrompt,
    openShortcuts: () => setShortcutsOpen(true),
    toast,
  })

  // Keyboard map. Editable fields (title, formula bar, notes, TipTap, grid cells)
  // keep their native keys. The grid also keeps its own paste handling.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (e.key === 'F5') {
        e.preventDefault()
        actions.present(true)
        return
      }
      if (context && e.key === 'Escape') {
        setContext(null)
        return
      }
      const target = e.target
      const inGrid = target instanceof HTMLElement && !!target.closest('[role=grid]')
      if (isEditable(target) && !(mod && key === 'enter')) return
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        session.undo()
        return
      }
      if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) {
        e.preventDefault()
        session.redo()
        return
      }
      if (inGrid) return
      if (mod && key === '/') {
        e.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (mod && key === 'enter') {
        e.preventDefault()
        actions.newSlide()
        return
      }
      if (mod && key === 'c') return actions.copySelection(false)
      if (mod && key === 'x') {
        e.preventDefault()
        return actions.copySelection(true)
      }
      if (mod && key === 'v') {
        e.preventDefault()
        void actions.pasteElements()
        return
      }
      if (mod && key === 'a') {
        e.preventDefault()
        actions.selectAll()
        return
      }
      if (mod && key === 'd') {
        e.preventDefault()
        if (validSelection.length > 0) actions.duplicateSelection()
        else actions.duplicateSlide()
        return
      }
      if (mod && key === '\\') {
        e.preventDefault()
        actions.clearFormatting()
        return
      }
      if (mod && (key === 'b' || key === 'i' || key === 'u')) {
        e.preventDefault()
        actions.toggleMark(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline')
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (validSelection.length > 0) {
          e.preventDefault()
          actions.deleteSelection()
        }
        return
      }
      if (e.key.startsWith('Arrow') && validSelection.length > 0) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        actions.nudge(dx, dy)
        return
      }
      if (e.key === 'Escape') {
        if (editingId) setEditing(null)
        else if (validSelection.length > 0) setSelection([])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const slideMenu = (id: string): MenuEntry[] => {
    const s = deck.slides.find((x) => x.id === id)
    return [
      { kind: 'item', label: 'New slide after', onSelect: () => actions.newSlide('title-content', true) },
      { kind: 'item', label: 'Duplicate', onSelect: () => actions.duplicateSlide(id) },
      { kind: 'item', label: s?.hidden ? 'Show slide' : 'Hide slide', onSelect: () => actions.toggleHidden(id) },
      { kind: 'sep' },
      { kind: 'item', label: 'Move up', onSelect: () => actions.moveSlideBy(-1, id) },
      { kind: 'item', label: 'Move down', onSelect: () => actions.moveSlideBy(1, id) },
      { kind: 'sep' },
      { kind: 'item', label: 'Delete', onSelect: () => actions.deleteSlide(id) },
    ]
  }

  const sectionMenu = (sectionId: string): MenuEntry[] => [
    { kind: 'item', label: 'Rename section', onSelect: () => actions.renameSection(sectionId) },
    { kind: 'item', label: 'Delete section', onSelect: () => actions.deleteSection(sectionId) },
  ]

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app-bg">
      <TitleBar
        deck={deck}
        starred={starred}
        deckId={meta.id}
        userEmail={user.email}
        userName={user.name}
        save={save}
        titleRef={titleRef}
        onRename={(title) => actions.renameDeck(title)}
        onStar={() => {
          const next = !starred
          setStarred(next)
          updateDeckFn({ data: { deckId: meta.id, starred: next } }).catch((err: unknown) => {
            setStarred(!next)
            toast(err instanceof Error ? err.message : 'Could not update star')
          })
        }}
        onPresent={() => actions.present(false)}
      />
      <MenuBar menus={menus} />
      <Toolbar
        deck={deck}
        slide={slide}
        single={single}
        ui={ui}
        setUi={setUi}
        actions={actions}
        canUndo={canUndo}
        canRedo={canRedo}
        undo={() => session.undo()}
        redo={() => session.redo()}
      />
      <FormulaBar deck={deck} slide={slide} single={single} actions={actions} setUi={setUi} />
      <div className="flex min-h-0 flex-1">
        <Filmstrip
          deck={deck}
          currentSlideId={slideId}
          onSelect={(id) => {
            setSlideId(id)
            setSelection([])
            setEditing(null)
          }}
          onMove={(id, to) => actions.moveSlideTo(id, to)}
          onNew={() => actions.newSlide()}
          onContextMenu={(x, y, id) => setContext({ x, y, items: slideMenu(id) })}
        />
        <SlideCanvas
          slide={slide}
          theme={deck.theme}
          zoom={ui.zoom}
          selection={validSelection}
          editingId={editingId}
          showGuides={ui.showGuides}
          onSelect={setSelection}
          onGeometry={(id, next) => actions.commitGeometry(id, next)}
          onStartEdit={(id) => setEditing(id)}
          onCommitText={(id, content: RichText) => {
            actions.commitText(id, content)
            setEditing(null)
          }}
        />
        <SidePanel deck={deck} slide={slide} selected={selectedEls} ui={ui} setUi={setUi} actions={actions} />
      </div>
      {dataChart && (
        <DataGrid
          key={dataChart.id}
          chart={dataChart}
          onCommit={(data) => actions.updateEl(dataChart.id, { data })}
          onClose={() => setUi({ dataElementId: null })}
          onToast={toast}
        />
      )}
      <BottomBar
        deck={deck}
        slide={slide}
        ui={ui}
        setUi={setUi}
        actions={actions}
        onSectionMenu={(x, y, id) => setContext({ x, y, items: sectionMenu(id) })}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) actions.insertImageFile(file)
        }}
      />
      {prompt && <PromptDialog request={prompt} onClose={() => setPrompt(null)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {context && <ContextMenu x={context.x} y={context.y} items={context.items} onClose={() => setContext(null)} />}
      <Toast message={toastMessage} onDone={onToastDone} />
      <span className="sr-only" aria-live="polite">
        {`Slide ${slideIndex(deck, slideId) + 1} of ${deck.slides.length}`}
      </span>
    </div>
  )
}

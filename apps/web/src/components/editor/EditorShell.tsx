// The editor: one open deck. EditorShell creates the collab session (one Y.Doc synced
// through the collab service) and waits for the first sync. EditorWorkspace owns the UI state,
// selection, the keyboard map and the overlays. Everything the user can do is an action in
// actions.ts, which builds deck-ops and applies them through the session.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChartElement, Deck, Element as SlideElement, RichText } from '@sleid/model'
import { isReadOnlyRole, type DeckRole } from '@sleid/db/permissions'
import { createActions, currentSlide, slideIndex, type PromptRequest, type UiState } from './actions.ts'
import { CollabSession, deniedMessage, useDeck, usePeers, useReady, useSyncStatus, useUndoState } from './collab-session.ts'
import { Filmstrip } from './Filmstrip.tsx'
import { SlideCanvas } from './Canvas.tsx'
import { SidePanel } from './SidePanel.tsx'
import { DataGrid } from './DataGrid.tsx'
import { BottomBar } from './BottomBar.tsx'
import { MenuBar, buildMenus } from './MenuBar.tsx'
import { ContextMenu, MenuList, PromptDialog, ShortcutsDialog, Toast, type MenuEntry } from './Overlays.tsx'
import { useAssistant, type ProposalCard } from './assistant.ts'
import { AiPanel } from './AiPanel.tsx'
import { askMenuEntries, rewriteEntries, ThemeDialog, type AskHandlers } from './AiMenus.tsx'
import { FormulaBar, TitleBar, Toolbar } from './Chrome.tsx'
import { ShareDialog } from './ShareDialog.tsx'
import { ExportDialog, type DialogFormat } from './ExportDialog.tsx'
import { ExportTray, useExportJobs } from './ExportTray.tsx'
import { getCollabTokenFn } from '~/lib/collab.functions'
import { setStarredFn } from '~/lib/decks.functions'

export type EditorDeck = { id: string; title: string; starred: boolean; role: string }
export type EditorUser = { id: string; name: string; email: string; image: string | null }

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

/** Slides the Tools actions work on: the current slide and up to seven after it. */
function scopeSlideIds(deck: Deck, slideId: string): string[] {
  const start = Math.max(0, deck.slides.findIndex((s) => s.id === slideId))
  return deck.slides.slice(start, start + 8).map((s) => s.id)
}

/** Images, charts and diagrams on the scoped slides, for alt text. */
function altTextIds(deck: Deck, slideIds: string[]): string[] {
  const wanted = new Set(slideIds)
  return deck.slides
    .filter((s) => wanted.has(s.id))
    .flatMap((s) => s.elements)
    .filter((e) => e.type === 'image' || e.type === 'chart' || e.type === 'diagram')
    .map((e) => e.id)
    .slice(0, 30)
}

export function EditorShell({ deck: meta, user }: { deck: EditorDeck; user: EditorUser }) {
  const readOnly = isReadOnlyRole(meta.role as DeckRole)
  const [session, setSession] = useState<CollabSession | null>(null)

  // One session per open deck. StrictMode runs this effect twice in development, so the
  // cleanup destroys the first session and the second one replaces it before anything renders.
  useEffect(() => {
    const next = new CollabSession({
      deckId: meta.id,
      user: { id: user.id, name: user.name, image: user.image },
      readOnly,
      fetchToken: async () => (await getCollabTokenFn({ data: { deckId: meta.id } })).token,
    })
    setSession(next)
    return () => next.destroy()
  }, [meta.id, readOnly, user.id, user.name, user.image])

  if (!session) return <Opening />
  return <SessionGate session={session} meta={meta} user={user} readOnly={readOnly} />
}

function Opening({ text = 'Opening deck…' }: { text?: string }) {
  return <div className="grid h-screen place-items-center text-ink-muted">{text}</div>
}

/** Renders the workspace only after the first sync. Before that the document is empty. */
function SessionGate({ session, meta, user, readOnly }: { session: CollabSession; meta: EditorDeck; user: EditorUser; readOnly: boolean }) {
  const ready = useReady(session)
  const status = useSyncStatus(session)
  if (!ready) {
    if (status.kind === 'denied') return <Opening text={deniedMessage(status.reason)} />
    return <Opening text="Connecting…" />
  }
  return <EditorWorkspace session={session} meta={meta} user={user} readOnly={readOnly} />
}

function EditorWorkspace({ session, meta, user, readOnly }: { session: CollabSession; meta: EditorDeck; user: EditorUser; readOnly: boolean }) {
  const deck = useDeck(session.doc)
  const status = useSyncStatus(session)
  const peers = usePeers(session)
  const { canUndo, canRedo } = useUndoState(session)

  const [ui, setUiState] = useState<UiState>(DEFAULT_UI)
  const setUi = useCallback((patch: Partial<UiState>) => setUiState((prev) => ({ ...prev, ...patch })), [])
  const [slideIdState, setSlideId] = useState(() => deck.slides[0]?.id ?? '')
  const [selection, setSelection] = useState<string[]>([])
  const [editingId, setEditing] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [exportDialog, setExportDialog] = useState<DialogFormat | null>(null)
  const exportJobs = useExportJobs(meta.id)
  const [context, setContext] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const [starred, setStarredState] = useState(meta.starred)
  const titleRef = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (session.hasUnsavedChanges()) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [session])

  const slide = currentSlide(deck, slideIdState)
  const slideId = slide.id
  const validSelection = selection.filter((id) => slide.elements.some((e) => e.id === id))
  const selectedEls = slide.elements.filter((e) => validSelection.includes(e.id))
  const single: SlideElement | undefined = selectedEls.length === 1 ? selectedEls[0] : undefined
  const dataChart = ui.dataElementId
    ? (slide.elements.find((e): e is ChartElement => e.id === ui.dataElementId && e.type === 'chart') ?? undefined)
    : undefined

  // What this user is looking at, for collaborators.
  const selectionKey = validSelection.join(',')
  useEffect(() => {
    session.setPresence({ slideId })
  }, [session, slideId])
  useEffect(() => {
    session.setPresence({ selection: selectionKey ? selectionKey.split(',') : [] })
  }, [session, selectionKey])

  const toast = useCallback((message: string) => setToastMessage(message), [])
  const onToastDone = useCallback(() => setToastMessage(null), [])

  const openPanel = useCallback(() => setUi({ sidePanel: 'ai' }), [setUi])
  const assistant = useAssistant({ deckId: meta.id, session, onOpenPanel: openPanel, toast, enabled: !readOnly })
  // While a proposal is previewed, the canvas and filmstrip show the preview's copy of the deck.
  const preview = assistant.preview
  const viewDeck = assistant.viewDeck(deck)
  const viewSlide = preview ? currentSlide(viewDeck, preview.slideId) : slide
  const previewCard = preview ? assistant.findCard(preview.cardId) : undefined
  const applyFromCard = (card: ProposalCard) => {
    assistant.applyCard(card)
    if (card.focusSlideId) setSlideId(card.focusSlideId)
  }

  const actions = createActions({
    session,
    readOnly,
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
      window.location.assign(href)
    },
    blockedReason: preview ? 'A preview is showing. Apply or discard the change first.' : undefined,
  })

  // Ask AI, context menu and Tools actions. Each one starts a proposal in the AI panel.
  const askHandlers: AskHandlers = {
    rewrite: (elementId, mode, extra) => void assistant.run('Rewrite text', 'rewriteText', { elementId, mode, ...extra }),
    askLanguage: (elementId) =>
      setPrompt({
        title: 'Translate text',
        label: 'Target language, for example Indonesian',
        initial: 'Indonesian',
        submitLabel: 'Translate',
        onSubmit: (value) => {
          const language = value.trim()
          if (language) void assistant.run('Translate text', 'rewriteText', { elementId, mode: 'translate', language })
        },
      }),
    askInstruction: (elementId) =>
      setPrompt({
        title: 'Custom instruction',
        label: 'What should happen to this text?',
        submitLabel: 'Ask',
        onSubmit: (value) => {
          const instruction = value.trim()
          if (instruction) void assistant.run('Rewrite text', 'rewriteText', { elementId, mode: 'custom', instruction })
        },
      }),
    chartChange: (elementId, chartType) =>
      void assistant.run('Change chart', 'generateChart', { elementId, chartType, prompt: `Show the same data as a ${chartType} chart.` }),
    chartInstruction: (elementId) =>
      setPrompt({
        title: 'Change chart',
        label: 'What should change? For example: add a series, change the title',
        submitLabel: 'Ask',
        onSubmit: (value) => {
          const instruction = value.trim()
          if (instruction) void assistant.run('Change chart', 'generateChart', { elementId, prompt: instruction })
        },
      }),
    explainChart: (elementId) =>
      void assistant.run('Explain chart', 'explain', { elementId, question: 'Explain what this chart shows, in three sentences at most.' }),
    diagramInstruction: (elementId) =>
      setPrompt({
        title: 'Change diagram',
        label: 'What should the diagram show?',
        submitLabel: 'Ask',
        onSubmit: (value) => {
          const prompt = value.trim()
          if (prompt) void assistant.run('Change diagram', 'generateDiagram', { elementId, prompt })
        },
      }),
    slideFromPrompt: (empty) =>
      setPrompt({
        title: empty ? 'Fill this slide' : 'New slide',
        label: 'Describe the slide',
        submitLabel: 'Generate',
        onSubmit: (value) => {
          const prompt = value.trim()
          if (!prompt) return
          if (empty) void assistant.run('Fill slide', 'generateSlide', { prompt, slideId: slide.id })
          else void assistant.run('New slide', 'generateSlide', { prompt, index: slideIndex(deck, slide.id) + 1, focusSlideId: slide.id })
        },
      }),
    openPanel,
  }
  const askEntries = askMenuEntries({ single, slideEmpty: slide.elements.length === 0, slideIndex: slideIndex(deck, slide.id) }, askHandlers)
  const scope = scopeSlideIds(deck, slide.id)
  const aiTools = readOnly
    ? undefined
    : {
        openPanel,
        speakerNotes: () => void assistant.run('Speaker notes', 'speakerNotes', { slideIds: scope, tone: 'neutral', length: 'medium' }),
        effects: () => void assistant.run('Transitions and animations', 'suggestEffects', { slideIds: scope }),
        altText: () => {
          const ids = altTextIds(deck, scope)
          if (ids.length === 0) return toast('No images, charts or diagrams on these slides')
          void assistant.run('Alt text', 'altText', { elementIds: ids })
        },
        theme: () => setThemeOpen(true),
      }


  const menus = buildMenus({
    actions,
    readOnly,
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
    startExport: (format) => {
      void exportJobs.start({ format, options: {}, label: format === 'pptx' ? 'PowerPoint' : 'HTML (zip)' }).catch((err: unknown) =>
        toast(err instanceof Error ? err.message : 'Could not start the export'),
      )
    },
    openExport: (format) => setExportDialog(format),
    prompt: setPrompt,
    openShortcuts: () => setShortcutsOpen(true),
    toast,
    ai: aiTools,
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
      if (readOnly) {
        // Viewers and commenters: only keys that do not change the deck.
        if (mod && key === '/') {
          e.preventDefault()
          setShortcutsOpen(true)
        } else if (mod && key === 'a') {
          e.preventDefault()
          actions.selectAll()
        } else if (mod && key === 'c') {
          actions.copySelection(false)
        } else if (e.key === 'Escape' && validSelection.length > 0) {
          setSelection([])
        }
        return
      }
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
    if (readOnly) return []
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
        userName={user.name}
        selfColor={session.color}
        status={status}
        peers={peers}
        readOnly={readOnly}
        titleRef={titleRef}
        onRename={(title) => actions.renameDeck(title)}
        onStar={() => {
          const next = !starred
          setStarredState(next)
          setStarredFn({ data: { deckId: meta.id, starred: next } }).catch((err: unknown) => {
            setStarredState(!next)
            toast(err instanceof Error ? err.message : 'Could not update star')
          })
        }}
        onPresent={() => actions.present(false)}
        onShare={() => setShareOpen(true)}
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
        readOnly={readOnly}
        undo={() => session.undo()}
        redo={() => session.redo()}
      />
      {preview && (
        <div role="region" aria-label="Preview" className="flex shrink-0 items-center justify-between gap-3 bg-amber-100 px-3 py-1.5 text-[13px] text-amber-900">
          <span>
            <strong className="font-semibold">Preview.</strong> Nothing is saved yet{previewCard ? `: ${previewCard.title}` : ''}.
          </span>
          {previewCard && (
            <span className="flex shrink-0 gap-2">
              <button type="button" onClick={() => applyFromCard(previewCard)} className="rounded bg-accent px-3 py-1 font-medium text-white hover:brightness-95">
                Apply
              </button>
              <button type="button" onClick={() => assistant.discardCard(previewCard)} className="rounded px-3 py-1 font-medium text-amber-900 hover:bg-amber-200">
                Discard
              </button>
            </span>
          )}
        </div>
      )}
      <FormulaBar
        deck={deck}
        slide={slide}
        single={single}
        actions={actions}
        setUi={setUi}
        readOnly={readOnly}
        onAskAi={readOnly ? undefined : () => setAskOpen((open) => !open)}
        askMenu={
          askOpen && !readOnly ? (
            <>
              <div className="fixed inset-0 z-0" aria-hidden onMouseDown={() => setAskOpen(false)} />
              <div className="relative z-10">
                <MenuList items={askEntries} onClose={() => setAskOpen(false)} />
              </div>
            </>
          ) : undefined
        }
      />
      <div className="flex min-h-0 flex-1">
        <Filmstrip
          deck={viewDeck}
          currentSlideId={viewSlide.id}
          readOnly={readOnly || !!preview}
          peers={peers}
          onSelect={(id) => {
            if (preview) return assistant.setPreviewSlide(id)
            setSlideId(id)
            setSelection([])
            setEditing(null)
          }}
          onMove={(id, to) => actions.moveSlideTo(id, to)}
          onNew={() => actions.newSlide()}
          onContextMenu={(x, y, id) => setContext({ x, y, items: slideMenu(id) })}
        />
        <SlideCanvas
          slide={viewSlide}
          theme={viewDeck.theme}
          zoom={ui.zoom}
          selection={validSelection}
          editingId={editingId}
          showGuides={ui.showGuides}
          readOnly={readOnly || !!preview}
          peers={peers}
          onElementContextMenu={(x, y, el) => {
            if (readOnly || el.type !== 'text') return
            setContext({ x, y, items: [{ kind: 'group', label: 'Rewrite', items: rewriteEntries(el.id, askHandlers) }] })
          }}
          onSelect={setSelection}
          onGeometry={(id, next) => actions.commitGeometry(id, next)}
          onStartEdit={(id) => {
            if (!readOnly) setEditing(id)
          }}
          onCommitText={(id, content: RichText) => {
            actions.commitText(id, content)
            setEditing(null)
          }}
          onCursor={(point) => session.setCursor(point)}
        />
        <SidePanel
          deck={deck}
          slide={slide}
          selected={selectedEls}
          ui={ui}
          setUi={setUi}
          actions={actions}
          readOnly={readOnly}
          aiPanel={
            readOnly ? undefined : (
              <AiPanel assistant={assistant} selectionIds={validSelection} slideId={slideId} />
            )
          }
        />
      </div>
      {dataChart && (
        <DataGrid
          key={dataChart.id}
          chart={dataChart}
          readOnly={readOnly}
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
        readOnly={readOnly}
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
      {themeOpen && <ThemeDialog onClose={() => setThemeOpen(false)} onSubmit={(input) => void assistant.run('Generate theme', 'generateTheme', input)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {shareOpen && <ShareDialog deckId={meta.id} onClose={() => setShareOpen(false)} />}
      {exportDialog && (
        <ExportDialog
          format={exportDialog}
          slides={deck.slides}
          currentSlideId={slideId}
          onClose={() => setExportDialog(null)}
          onStart={(format, options, label) => {
            setExportDialog(null)
            exportJobs.start({ format, options, label }).catch((err: unknown) => toast(err instanceof Error ? err.message : 'Could not start the export'))
          }}
        />
      )}
      <ExportTray jobs={exportJobs.jobs} onDismiss={exportJobs.dismiss} />
      {context && context.items.length > 0 && <ContextMenu x={context.x} y={context.y} items={context.items} onClose={() => setContext(null)} />}
      <Toast message={toastMessage} onDone={onToastDone} />
      <span className="sr-only" aria-live="polite">
        {`Slide ${slideIndex(deck, slideId) + 1} of ${deck.slides.length}`}
      </span>
    </div>
  )
}

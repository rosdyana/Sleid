// Editor commands. Menus, the toolbar, the fx bar, the side panel and the
// keyboard all call these. Each one builds deck-ops and runs them through the
// session, so every command is one undo step and is saved like any other edit.
import { deckToMarkdown } from '@sleid/render'
import { BUILT_IN_THEMES, CHART_TYPES, SHAPE_KINDS, SLIDE_LAYOUTS, type Deck, type Element, type RichText, type Slide, type Theme } from '@sleid/model'
import { createBlankDeckFn, setStarredFn } from '~/lib/decks.functions'
import { copyDeckFn } from '~/lib/deck-doc.functions'
import { markOnEverything, setMarkEverywhere, clearMarksEverywhere, type MarkName } from './rich.ts'
import {
  asNewElement,
  chartDraft,
  codeDraft,
  diagramDraft,
  getInternalClipboard,
  imageDraft,
  parseClipboard,
  serializeClipboard,
  setInternalClipboard,
  shapeDraft,
  tableDraft,
  textDraft,
  CANVAS_H,
  CANVAS_W,
} from './commands.ts'
import type { CollabSession } from './collab-session.ts'

export interface UiState {
  showNotes: boolean
  showGuides: boolean
  zoom: 'fit' | number
  sidePanel: 'format' | 'slide' | 'theme'
  dataElementId: string | null
  section: string | null
}

export interface PromptRequest {
  title: string
  label: string
  initial?: string
  submitLabel?: string
  onSubmit: (value: string) => void
}

export interface ActionContext {
  session: CollabSession
  /** Commenters and viewers: every change is refused here, and the session refuses too. */
  readOnly: boolean
  deck: Deck
  deckId: string
  slideId: string
  selection: readonly string[]
  ui: UiState
  setUi: (patch: Partial<UiState>) => void
  setSelection: (ids: string[]) => void
  setSlideId: (id: string) => void
  setEditing: (id: string | null) => void
  toast: (message: string) => void
  prompt: (request: PromptRequest) => void
  openShortcuts: () => void
  focusTitle: () => void
  navigate: (href: string) => Promise<void>
}

export type Actions = ReturnType<typeof createActions>

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function slideIndex(deck: Deck, slideId: string): number {
  const i = deck.slides.findIndex((s) => s.id === slideId)
  return i < 0 ? 0 : i
}

export function currentSlide(deck: Deck, slideId: string): Slide {
  return deck.slides.find((s) => s.id === slideId) ?? deck.slides[0]!
}

function downloadText(filename: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function fileSafeName(title: string): string {
  return title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'deck'
}

export function createActions(c: ActionContext) {
  const deck = c.deck
  const slide = currentSlide(deck, c.slideId)
  const selected = slide.elements.filter((e) => c.selection.includes(e.id))
  const single = selected.length === 1 ? selected[0] : undefined
  const theme: Theme = deck.theme

  function run(ops: unknown[]): boolean {
    if (c.readOnly) {
      c.toast('View only: you cannot change this deck')
      return false
    }
    try {
      c.session.apply(ops)
      return true
    } catch (err) {
      c.toast(err instanceof Error ? err.message : 'That change was rejected')
      return false
    }
  }

  function needSelection(message = 'Select an element first'): boolean {
    if (selected.length > 0) return true
    c.toast(message)
    return false
  }

  function needText(): Extract<Element, { type: 'text' }> | null {
    if (single?.type === 'text') return single
    c.toast('Select a text box first')
    return null
  }

  function updateEl(id: string, patch: Record<string, unknown>): boolean {
    return run([{ op: 'updateElement', slideId: slide.id, elementId: id, patch }])
  }

  // Adds an element and selects it. The id is generated here so the selection can name it.
  function insert(draft: Record<string, unknown>) {
    const id = crypto.randomUUID()
    if (run([{ op: 'addElement', slideId: slide.id, element: { ...draft, id } }])) c.setSelection([id])
  }

  // ---------------- Slides ----------------

  function newSlide(layout: (typeof SLIDE_LAYOUTS)[number] = 'title-content', afterCurrent = true) {
    const index = afterCurrent ? slideIndex(deck, slide.id) + 1 : deck.slides.length
    const id = crypto.randomUUID()
    if (run([{ op: 'addSlide', layout, index, slide: { id } }])) {
      c.setSlideId(id)
      c.setSelection([])
    }
  }

  function duplicateSlide(slideId = slide.id) {
    const id = crypto.randomUUID()
    if (run([{ op: 'duplicateSlide', slideId, newSlideId: id }])) c.setSlideId(id)
  }

  function deleteSlide(slideId = slide.id) {
    if (deck.slides.length <= 1) return c.toast('A deck needs at least one slide')
    const index = slideIndex(deck, slideId)
    if (!run([{ op: 'deleteSlide', slideId }])) return
    const next = deck.slides[index + 1] ?? deck.slides[index - 1]
    if (next) c.setSlideId(next.id)
    c.setSelection([])
  }

  function toggleHidden(slideId = slide.id) {
    const s = deck.slides.find((x) => x.id === slideId)
    if (s) run([{ op: 'updateSlide', slideId, patch: { hidden: !s.hidden } }])
  }

  function moveSlideBy(delta: number, slideId = slide.id) {
    const index = slideIndex(deck, slideId)
    const to = index + delta
    if (to < 0 || to >= deck.slides.length) return
    run([{ op: 'moveSlide', slideId, toIndex: to }])
  }

  function moveSlideTo(slideId: string, toIndex: number) {
    run([{ op: 'moveSlide', slideId, toIndex }])
  }

  function setSlideLayout(layout: (typeof SLIDE_LAYOUTS)[number]) {
    run([{ op: 'updateSlide', slideId: slide.id, patch: { layout } }])
  }

  function setTransition(transition: Slide['transition']) {
    run([{ op: 'updateSlide', slideId: slide.id, patch: { transition } }])
  }

  function toggleAutoAnimate() {
    run([{ op: 'updateSlide', slideId: slide.id, patch: { autoAnimate: !slide.autoAnimate } }])
  }

  function setSlideBackground(value: string | null) {
    run([{ op: 'updateSlide', slideId: slide.id, patch: { background: value ? { type: 'color', value } : null } }])
  }

  function setNotes(notes: string, slideId = slide.id) {
    run([{ op: 'setNotes', slideId, notes }])
  }

  function moveToSection(sectionId: string | null, slideId = slide.id) {
    run([{ op: 'updateSlide', slideId, patch: { sectionId: sectionId ?? null } }])
  }

  // ---------------- Elements ----------------

  function insertText() {
    insert(textDraft(theme))
  }

  function insertShape(kind: (typeof SHAPE_KINDS)[number]) {
    insert(shapeDraft(theme, kind))
  }

  function insertChart(kind: (typeof CHART_TYPES)[number]) {
    insert(chartDraft(kind))
  }

  function insertTable() {
    insert(tableDraft())
  }

  function insertCode() {
    insert(codeDraft())
  }

  function insertDiagram() {
    insert(diagramDraft())
  }

  function insertImageUrl() {
    c.prompt({
      title: 'Insert image',
      label: 'Image URL (https, or a data:image URL)',
      submitLabel: 'Insert',
      onSubmit: (value) => {
        const src = value.trim()
        if (!/^(https?:\/\/|data:image\/)/i.test(src)) return c.toast('Image URL must start with https:// or data:image/')
        insert(imageDraft(src))
      },
    })
  }

  /** Uploads the image to the deck's asset store and inserts it by URL. Existing data-URL images keep working. */
  async function insertImageFile(file: File) {
    if (c.readOnly) return c.toast('View only: you cannot change this deck')
    if (file.size > MAX_IMAGE_BYTES) return c.toast('Images are limited to 10 MB')
    if (!/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.type)) return c.toast('Choose a PNG, JPEG, GIF, WebP or SVG image')
    c.toast('Uploading image…')
    const form = new FormData()
    form.append('file', file)
    try {
      const response = await fetch(`/api/decks/${c.deckId}/assets`, { method: 'POST', body: form, credentials: 'same-origin' })
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null
      if (!response.ok || !body?.url) return c.toast(body?.error ?? 'The image could not be uploaded')
      insert(imageDraft(body.url))
    } catch {
      c.toast('The image could not be uploaded. Check your connection and try again.')
    }
  }

  function deleteSelection() {
    if (!needSelection()) return
    run(selected.map((e) => ({ op: 'deleteElement', slideId: slide.id, elementId: e.id })))
    c.setSelection([])
  }

  function copySelection(cut = false) {
    if (!needSelection()) return
    const els = selected.map((e) => structuredClone(e))
    setInternalClipboard(els)
    void navigator.clipboard?.writeText(serializeClipboard(els)).catch(() => undefined)
    if (cut) deleteSelection()
  }

  async function pasteElements() {
    let els = getInternalClipboard()
    if (els.length === 0) {
      try {
        els = parseClipboard(await navigator.clipboard.readText()) ?? []
      } catch {
        els = []
      }
    }
    if (els.length === 0) return c.toast('Nothing to paste')
    const ops = els.map((el) => ({ op: 'addElement', slideId: slide.id, element: { ...asNewElement(el, 40, 40), id: crypto.randomUUID() } }))
    const ids = ops.map((op) => (op.element as { id: string }).id)
    if (run(ops)) c.setSelection(ids)
  }

  function duplicateSelection() {
    if (!needSelection()) return
    const ids: string[] = []
    const ops = selected.map((el) => {
      const id = crypto.randomUUID()
      ids.push(id)
      return { op: 'addElement', slideId: slide.id, element: { ...asNewElement(el, 40, 40), id } }
    })
    if (run(ops)) c.setSelection(ids)
  }

  function selectAll() {
    c.setSelection(slide.elements.map((e) => e.id))
  }

  function arrange(z: 'front' | 'back' | 'forward' | 'backward') {
    if (!needSelection()) return
    run(selected.map((el) => ({ op: 'reorderElement', slideId: slide.id, elementId: el.id, z })))
  }

  function align(kind: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
    if (!needSelection()) return
    const ops = selected.map((el) => {
      const patch: Record<string, number> = {}
      if (kind === 'left') patch.x = 0
      if (kind === 'center') patch.x = Math.round((CANVAS_W - el.w) / 2)
      if (kind === 'right') patch.x = CANVAS_W - el.w
      if (kind === 'top') patch.y = 0
      if (kind === 'middle') patch.y = Math.round((CANVAS_H - el.h) / 2)
      if (kind === 'bottom') patch.y = CANVAS_H - el.h
      return { op: 'updateElement', slideId: slide.id, elementId: el.id, patch }
    })
    run(ops)
  }

  function distribute(axis: 'x' | 'y') {
    if (selected.length < 3) return c.toast('Select at least three elements to distribute')
    const sizeKey = axis === 'x' ? 'w' : 'h'
    const sorted = [...selected].sort((a, b) => a[axis] - b[axis])
    const first = sorted[0]!
    const last = sorted[sorted.length - 1]!
    const total = sorted.reduce((sum, el) => sum + el[sizeKey], 0)
    const gap = (last[axis] + last[sizeKey] - first[axis] - total) / (sorted.length - 1)
    let cursor = first[axis] + first[sizeKey] + gap
    const ops: unknown[] = []
    for (const el of sorted.slice(1, -1)) {
      ops.push({ op: 'updateElement', slideId: slide.id, elementId: el.id, patch: { [axis]: Math.round(cursor) } })
      cursor += el[sizeKey] + gap
    }
    run(ops)
  }

  function nudge(dx: number, dy: number) {
    if (selected.length === 0) return
    run(selected.map((el) => ({ op: 'updateElement', slideId: slide.id, elementId: el.id, patch: { x: el.x + dx, y: el.y + dy } })))
  }

  function commitGeometry(id: string, next: { x: number; y: number; w: number; h: number; rotation: number }) {
    updateEl(id, next)
  }

  function commitText(id: string, content: RichText) {
    updateEl(id, { content })
    c.setEditing(null)
  }

  // ---------------- Format ----------------

  function toggleMark(mark: MarkName) {
    const el = needText()
    if (!el) return
    updateEl(el.id, { content: setMarkEverywhere(el.content, mark, !markOnEverything(el.content, mark)) })
  }

  function setTextStyle(patch: Record<string, unknown>) {
    const el = needText()
    if (el) updateEl(el.id, { style: patch })
  }

  function setOpacity(value: number) {
    if (!needSelection()) return
    run(selected.map((el) => ({ op: 'updateElement', slideId: slide.id, elementId: el.id, patch: { opacity: value } })))
  }

  function clearFormatting() {
    if (!needSelection()) return
    run(
      selected.map((el) =>
        el.type === 'text'
          ? { op: 'updateElement', slideId: slide.id, elementId: el.id, patch: { content: clearMarksEverywhere(el.content), style: { fontFamily: theme.fonts.body, fontSize: theme.sizes.body, color: theme.colors.text } } }
          : { op: 'updateElement', slideId: slide.id, elementId: el.id, patch: { opacity: 1 } },
      ),
    )
  }

  // ---------------- Deck, file and view ----------------

  async function newDeck() {
    try {
      const { id } = await createBlankDeckFn()
      await c.navigate(`/d/${id}`)
    } catch (err) {
      c.toast(err instanceof Error ? err.message : 'Could not create deck')
    }
  }

  async function makeCopy() {
    try {
      const { id } = await copyDeckFn({ data: { deckId: c.deckId } })
      await c.navigate(`/d/${id}`)
    } catch (err) {
      c.toast(err instanceof Error ? err.message : 'Could not copy deck')
    }
  }

  /** Markdown and JSON are made in the browser. The other formats are worker exports (see the export tray). */
  function download(format: 'json' | 'markdown') {
    const base = fileSafeName(deck.title)
    if (format === 'json') downloadText(`${base}.json`, 'application/json', JSON.stringify(deck, null, 2))
    if (format === 'markdown') downloadText(`${base}.md`, 'text/markdown', deckToMarkdown(deck))
  }

  function present(fromStart = false) {
    const n = fromStart ? 1 : slideIndex(deck, slide.id) + 1
    window.open(`/d/${c.deckId}/present?slide=${n}`, '_blank', 'noopener')
  }

  async function renameDeck(title: string) {
    const next = title.trim().slice(0, 200)
    if (!next) return
    run([{ op: 'setTitle', title: next }])
  }

  async function setStarred(starred: boolean) {
    try {
      await setStarredFn({ data: { deckId: c.deckId, starred } })
    } catch (err) {
      c.toast(err instanceof Error ? err.message : 'Could not update star')
    }
  }

  function setTheme(next: Theme) {
    run([{ op: 'setTheme', theme: next }])
  }

  function setThemeToken(path: { colors?: Partial<Theme['colors']>; fonts?: Partial<Theme['fonts']> }) {
    run([{ op: 'setTheme', theme: path }])
  }

  function applyBuiltInTheme(name: string) {
    const t = BUILT_IN_THEMES.find((x) => x.name === name)
    if (t) setTheme(structuredClone(t))
  }

  // ---------------- Sections ----------------

  function addSection() {
    c.prompt({
      title: 'New section',
      label: 'Section name',
      initial: `Section ${deck.sections.length + 1}`,
      submitLabel: 'Add',
      onSubmit: (name) => {
        const id = crypto.randomUUID()
        run([{ op: 'addSection', id, name: name.trim() || 'Section' }])
      },
    })
  }

  function renameSection(sectionId: string) {
    const current = deck.sections.find((s) => s.id === sectionId)
    c.prompt({
      title: 'Rename section',
      label: 'Section name',
      initial: current?.name ?? '',
      submitLabel: 'Rename',
      onSubmit: (name) => run([{ op: 'renameSection', sectionId, name: name.trim() || 'Section' }]),
    })
  }

  function deleteSection(sectionId: string) {
    run([{ op: 'deleteSection', sectionId }])
    if (c.ui.section === sectionId) c.setUi({ section: null })
  }

  return {
    run,
    // slides
    newSlide,
    duplicateSlide,
    deleteSlide,
    toggleHidden,
    moveSlideBy,
    moveSlideTo,
    setSlideLayout,
    setTransition,
    toggleAutoAnimate,
    setSlideBackground,
    setNotes,
    moveToSection,
    // elements
    insertText,
    insertShape,
    insertChart,
    insertTable,
    insertCode,
    insertDiagram,
    insertImageUrl,
    insertImageFile,
    deleteSelection,
    copySelection,
    pasteElements,
    duplicateSelection,
    selectAll,
    arrange,
    align,
    distribute,
    nudge,
    commitGeometry,
    commitText,
    updateEl,
    // format
    toggleMark,
    setTextStyle,
    setOpacity,
    clearFormatting,
    // deck
    newDeck,
    makeCopy,
    download,
    present,
    renameDeck,
    setStarred,
    setTheme,
    setThemeToken,
    applyBuiltInTheme,
    // sections
    addSection,
    renameSection,
    deleteSection,
    // helpers for callers
    slide,
    selected,
    single,
    theme,
    toast: c.toast,
  }
}

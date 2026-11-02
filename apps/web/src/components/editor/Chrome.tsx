// Title bar, formatting toolbar and fx bar. The fx bar shows the selected
// element like a cell reference, and its input edits whatever the element holds.
import type { RefObject } from 'react'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Image as ImageIcon, Italic, MousePointer2, Plus, Presentation, Redo2, Sparkles, Star, Strikethrough, Table2, Type, Underline, Undo2 } from 'lucide-react'
import { BUILT_IN_THEMES, CHART_TYPES, SHAPE_KINDS, TRANSITIONS, type Deck, type Element, type Slide, type Theme } from '@sleid/model'
import type { Actions, UiState } from './actions.ts'
import { CHART_LABELS, elementLabel, SHAPE_LABELS, slideTitle } from './commands.ts'
import { deniedMessage, type PresencePeer, type SyncStatus } from './collab-session.ts'
import { markOnEverything, plainToRich, richToPlain } from './rich.ts'
import { safeImageSrc } from './ElementView.tsx'

const FONT_FAMILIES = ['Inter', 'Georgia, serif', 'Arial, sans-serif', 'Courier New, monospace']
const FONT_SIZES = [12, 14, 18, 24, 32, 40, 56, 72]
const ANIMATIONS = ['none', 'fade-in', 'fade-up', 'fade-down', 'fade-left', 'fade-right', 'grow', 'shrink', 'highlight-red', 'zoom-in']

// ---------------------------------------------------------------------------
// Title bar
// ---------------------------------------------------------------------------

export function TitleBar({
  deck,
  starred,
  deckId,
  userName,
  selfColor,
  status,
  peers,
  readOnly,
  titleRef,
  onRename,
  onStar,
  onPresent,
  onShare,
}: {
  deck: Deck
  starred: boolean
  deckId: string
  userName: string
  selfColor: string
  status: SyncStatus
  peers: PresencePeer[]
  readOnly: boolean
  titleRef: RefObject<HTMLInputElement | null>
  onRename: (title: string) => void
  onStar: () => void
  onPresent: () => void
  onShare: () => void
}) {
  const statusText =
    status.kind === 'connecting'
      ? 'Connecting…'
      : status.kind === 'saving'
        ? 'Saving…'
        : status.kind === 'offline'
          ? 'Offline — changes will sync'
          : status.kind === 'denied'
            ? deniedMessage(status.reason)
            : 'All changes saved'
  const others = uniqueByUser(peers)
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 bg-white px-3">
      <a href="/" aria-label="Back to decks" className="grid size-9 place-items-center rounded bg-accent text-base font-semibold text-white">
        S
      </a>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-1">
          <input
            ref={titleRef}
            aria-label="Deck title"
            key={`${deckId}:${deck.title}`}
            defaultValue={deck.title}
            readOnly={readOnly}
            onBlur={(e) => {
              const next = e.currentTarget.value.trim() || 'Untitled presentation'
              e.currentTarget.value = next
              if (!readOnly && next !== deck.title) onRename(next)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className="w-72 rounded px-1 text-lg text-ink outline-none hover:shadow-[inset_0_0_0_1px_var(--color-rule)] focus:shadow-[inset_0_0_0_2px_var(--color-accent)] read-only:hover:shadow-none"
          />
          <button
            type="button"
            aria-label={starred ? 'Unstar deck' : 'Star deck'}
            aria-pressed={starred}
            onClick={onStar}
            className={`grid place-items-center rounded px-1.5 py-1 hover:bg-hover ${starred ? 'text-amber-500' : 'text-ink-muted'}`}
          >
            <Star size={16} className={starred ? 'fill-current' : ''} aria-hidden />
          </button>
          {readOnly && (
            <span className="ml-1 rounded-full border border-rule px-2 py-0.5 text-[11px] font-medium text-ink-muted" title="You can look at this deck but not change it">
              View only
            </span>
          )}
        </div>
        <div className={`px-1 text-[11px] ${status.kind === 'denied' ? 'text-red-700' : 'text-ink-muted'}`} role="status">
          {statusText}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center -space-x-1.5" aria-label="People viewing this deck">
          {others.slice(0, 5).map((peer) => (
            <span
              key={peer.userId}
              title={peer.name}
              aria-label={`${peer.name} is here`}
              className="grid size-7 place-items-center rounded-full border-2 border-white text-[12px] font-medium text-white"
              style={{ background: peer.color }}
            >
              {(peer.name.trim().charAt(0) || '?').toUpperCase()}
            </span>
          ))}
          {others.length > 5 && <span className="pl-2 text-[12px] text-ink-muted">+{others.length - 5}</span>}
        </div>
        <button type="button" onClick={onPresent} className="flex items-center gap-1.5 rounded px-3 py-1.5 font-medium text-ink hover:bg-hover">
          <Presentation size={16} aria-hidden /> Present
        </button>
        <button type="button" onClick={onShare} className="rounded-full bg-accent-soft px-4 py-1.5 font-medium text-[#001d35] hover:brightness-95">
          Share
        </button>
        <div
          aria-label={`Signed in as ${userName}`}
          title={userName}
          className="grid size-8 place-items-center rounded-full text-sm font-medium text-white"
          style={{ background: selfColor }}
        >
          {(userName.trim().charAt(0) || '?').toUpperCase()}
        </div>
      </div>
    </header>
  )
}

/** Collaborators, one entry per person even when they have two tabs open. */
export function uniqueByUser(peers: PresencePeer[]): PresencePeer[] {
  const seen = new Map<string, PresencePeer>()
  for (const peer of peers) if (!seen.has(peer.userId)) seen.set(peer.userId, peer)
  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const btn = 'grid h-8 min-w-8 place-items-center rounded px-1.5 text-ink hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent'
const sel = 'h-8 rounded border border-transparent bg-transparent px-1 text-[13px] text-ink hover:border-rule disabled:opacity-40'

function Sep() {
  return <span className="mx-1 h-5 w-px bg-rule" aria-hidden />
}

export function Toolbar({
  deck,
  slide,
  single,
  ui,
  setUi,
  actions,
  canUndo,
  canRedo,
  readOnly,
  undo,
  redo,
}: {
  deck: Deck
  slide: Slide
  single: Element | undefined
  ui: UiState
  setUi: (patch: Partial<UiState>) => void
  actions: Actions
  canUndo: boolean
  canRedo: boolean
  readOnly: boolean
  undo: () => void
  redo: () => void
}) {
  const text = single?.type === 'text' ? single : undefined
  const anySelected = !!single
  const theme: Theme = deck.theme
  const fontOptions = [...new Set([theme.fonts.body, theme.fonts.heading, ...FONT_FAMILIES])]

  return (
    <div role="toolbar" aria-label="Formatting" className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-y border-rule bg-white px-2">
      <button type="button" className={btn} aria-label="Undo" title="Undo (Ctrl+Z)" disabled={readOnly || !canUndo} onClick={undo}>
        <Undo2 size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={readOnly || !canRedo} onClick={redo}>
        <Redo2 size={16} aria-hidden />
      </button>
      <select aria-label="Zoom" className={sel} value={String(ui.zoom)} onChange={(e) => setUi({ zoom: e.target.value === 'fit' ? 'fit' : Number(e.target.value) })}>
        <option value="fit">Fit</option>
        <option value="50">50%</option>
        <option value="75">75%</option>
        <option value="100">100%</option>
        <option value="150">150%</option>
      </select>
      {/* Everything below changes the deck. A disabled fieldset turns all of it off for viewers and commenters. */}
      <fieldset disabled={readOnly} className="contents">
      <Sep />
      <button type="button" className={btn} aria-label="New slide" title="New slide (Ctrl+Enter)" onClick={() => actions.newSlide()}>
        <Plus size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Select" title="Select" aria-pressed="true">
        <MousePointer2 size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Text box" title="Text box" onClick={actions.insertText}>
        <Type size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Image" title="Image from URL" onClick={actions.insertImageUrl}>
        <ImageIcon size={16} aria-hidden />
      </button>
      <select aria-label="Insert shape" className={sel} value="" onChange={(e) => e.target.value && actions.insertShape(e.target.value as (typeof SHAPE_KINDS)[number])}>
        <option value="">Shape</option>
        {SHAPE_KINDS.map((k) => (
          <option key={k} value={k}>
            {SHAPE_LABELS[k] ?? k}
          </option>
        ))}
      </select>
      <select aria-label="Insert chart" className={sel} value="" onChange={(e) => e.target.value && actions.insertChart(e.target.value as (typeof CHART_TYPES)[number])}>
        <option value="">Chart</option>
        {CHART_TYPES.map((k) => (
          <option key={k} value={k}>
            {CHART_LABELS[k] ?? k}
          </option>
        ))}
      </select>
      <button type="button" className={btn} aria-label="Table" title="Table" onClick={actions.insertTable}>
        <Table2 size={16} aria-hidden />
      </button>
      <Sep />
      <select aria-label="Font family" className={sel} disabled={!text} value={text?.style.fontFamily ?? ''} onChange={(e) => actions.setTextStyle({ fontFamily: e.target.value })}>
        {!text?.style.fontFamily && <option value="">Font</option>}
        {fontOptions.map((f) => (
          <option key={f} value={f}>
            {f.split(',')[0]}
          </option>
        ))}
      </select>
      <select aria-label="Font size" className={`${sel} w-16`} disabled={!text} value={text?.style.fontSize ?? ''} onChange={(e) => actions.setTextStyle({ fontSize: Number(e.target.value) })}>
        {!text?.style.fontSize && <option value="">Size</option>}
        {FONT_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <Sep />
      <button type="button" className={btn} aria-label="Bold" aria-pressed={!!text && markOnEverything(text.content, 'bold')} disabled={!text} onClick={() => actions.toggleMark('bold')}>
        <Bold size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Italic" aria-pressed={!!text && markOnEverything(text.content, 'italic')} disabled={!text} onClick={() => actions.toggleMark('italic')}>
        <Italic size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Underline" aria-pressed={!!text && markOnEverything(text.content, 'underline')} disabled={!text} onClick={() => actions.toggleMark('underline')}>
        <Underline size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Strikethrough" aria-pressed={!!text && markOnEverything(text.content, 'strike')} disabled={!text} onClick={() => actions.toggleMark('strike')}>
        <Strikethrough size={16} aria-hidden />
      </button>
      <input
        type="color"
        aria-label="Text colour"
        title="Text colour"
        disabled={!text}
        value={/^#[0-9a-f]{6}$/i.test(text?.style.color ?? '') ? text!.style.color! : '#202124'}
        onChange={(e) => actions.setTextStyle({ color: e.target.value })}
        className="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0.5 disabled:opacity-40"
      />
      <Sep />
      <button type="button" className={btn} aria-label="Align left" disabled={!text} onClick={() => actions.setTextStyle({ align: 'left' })}>
        <AlignLeft size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Align center" disabled={!text} onClick={() => actions.setTextStyle({ align: 'center' })}>
        <AlignCenter size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Align right" disabled={!text} onClick={() => actions.setTextStyle({ align: 'right' })}>
        <AlignRight size={16} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Justify" disabled={!text} onClick={() => actions.setTextStyle({ align: 'justify' })}>
        <AlignJustify size={16} aria-hidden />
      </button>
      <Sep />
      <select aria-label="Theme" className={sel} value={theme.name} onChange={(e) => actions.applyBuiltInTheme(e.target.value)}>
        {!BUILT_IN_THEMES.some((t) => t.name === theme.name) && <option value={theme.name}>{theme.name}</option>}
        {BUILT_IN_THEMES.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
      </select>
      <select aria-label="Transition" className={sel} value={slide.transition} onChange={(e) => actions.setTransition(e.target.value as Slide['transition'])}>
        {TRANSITIONS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select
        aria-label="Animation"
        className={sel}
        disabled={!anySelected}
        value={single?.animation?.effect ?? 'none'}
        onChange={(e) => {
          if (!single) return
          const v = e.target.value
          actions.updateEl(single.id, { animation: v === 'none' ? null : { effect: v, order: single.animation?.order ?? 0 } })
        }}
      >
        {ANIMATIONS.map((a) => (
          <option key={a} value={a}>
            {a === 'none' ? 'No animation' : a}
          </option>
        ))}
      </select>
      </fieldset>
    </div>
  )
}

// ---------------------------------------------------------------------------
// fx bar
// ---------------------------------------------------------------------------

export function FormulaBar({
  deck,
  slide,
  single,
  actions,
  setUi,
  readOnly,
}: {
  deck: Deck
  slide: Slide
  single: Element | undefined
  actions: Actions
  setUi: (patch: Partial<UiState>) => void
  readOnly: boolean
}) {
  const n = deck.slides.findIndex((s) => s.id === slide.id) + 1
  const ref = single ? `Slide ${n} · ${elementLabel(single)}` : `Slide ${n}`

  let value: string
  let kind: 'text' | 'chart' | 'diagram' | 'image' | 'code' | 'slide' | 'none'
  let placeholder = ''
  if (!single) {
    kind = 'slide'
    value = slideTitle(slide)
    placeholder = 'Slide title (first text box). Select an element to edit it.'
  } else if (single.type === 'text') {
    kind = 'text'
    value = richToPlain(single.content)
  } else if (single.type === 'chart') {
    kind = 'chart'
    value = '=DATA()'
  } else if (single.type === 'diagram') {
    kind = 'diagram'
    value = single.source
  } else if (single.type === 'image') {
    kind = 'image'
    value = single.src
  } else if (single.type === 'code') {
    kind = 'code'
    value = single.code
  } else {
    kind = 'none'
    value = ''
    placeholder = 'Select a text box, chart, diagram, image or code block to edit it here.'
  }

  function commit(next: string) {
    if (!single) {
      const title = slide.elements.find((e) => e.type === 'text' && e.role === 'title')
      if (title) actions.updateEl(title.id, { content: plainToRich(next) })
      else actions.toast('This slide has no title box. Insert a text box first.')
      return
    }
    switch (kind) {
      case 'text':
        actions.updateEl(single.id, { content: plainToRich(next) })
        break
      case 'diagram':
        actions.updateEl(single.id, { source: next })
        break
      case 'image':
        if (!safeImageSrc(next.trim())) return actions.toast('Image URL must be https://, data:image/, or a path starting with /')
        actions.updateEl(single.id, { src: next.trim() })
        break
      case 'code':
        actions.updateEl(single.id, { code: next })
        break
    }
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule bg-white px-2 text-ink-muted">
      <span className="w-56 truncate rounded border border-rule-soft px-2 py-0.5 text-center text-[12px] text-ink" title={ref}>
        {ref}
      </span>
      <span className="font-medium italic text-ink-muted">fx</span>
      <span className="h-4 w-px bg-rule" aria-hidden />
      <input
        key={`${slide.id}:${single?.id ?? 'slide'}:${value}`}
        aria-label="Formula bar"
        defaultValue={value}
        readOnly={readOnly || kind === 'chart' || kind === 'none'}
        placeholder={placeholder}
        onBlur={(e) => !readOnly && kind !== 'chart' && kind !== 'none' && e.currentTarget.value !== value && commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.currentTarget.value = value
            e.currentTarget.blur()
          }
        }}
        className="min-w-0 flex-1 rounded px-2 py-1 text-ink outline-none focus:ring-2 focus:ring-accent read-only:text-ink-muted"
      />
      {kind === 'chart' && (
        <button type="button" onClick={() => single?.type === 'chart' && setUi({ dataElementId: single.id })} className="rounded px-2 py-1 text-accent hover:bg-hover">
          Open data
        </button>
      )}
      <button
        type="button"
        disabled
        title="AI assistant arrives in milestone 4"
        className="flex items-center gap-1 rounded-full border border-rule px-3 py-0.5 text-[12px] text-ink-muted opacity-60"
      >
        <Sparkles size={13} aria-hidden /> Ask AI
      </button>
    </div>
  )
}

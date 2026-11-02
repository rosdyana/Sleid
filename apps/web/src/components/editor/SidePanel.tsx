// Right side panel: Format (selected element), Slide, Theme. The AI, Comments
// and History tabs are visibly disabled until their milestones.
import { useEffect, useState, type ReactNode } from 'react'
import { ANIMATION_EFFECTS, BUILT_IN_THEMES, CHART_TYPES, SHAPE_KINDS, SLIDE_LAYOUTS, TRANSITIONS, type Deck, type Element, type Slide, type Theme } from '@sleid/model'
import type { Actions, UiState } from './actions.ts'
import { CHART_LABELS, elementLabel, SHAPE_LABELS } from './commands.ts'

const PLACEHOLDER_TABS = [
  { label: 'AI', note: 'AI assistant arrives in milestone 4' },
  { label: 'Comments', note: 'Comments arrive in milestone 7' },
  { label: 'History', note: 'Version history arrives in milestone 7' },
] as const

export function SidePanel({
  deck,
  slide,
  selected,
  ui,
  setUi,
  actions,
}: {
  deck: Deck
  slide: Slide
  selected: Element[]
  ui: UiState
  setUi: (patch: Partial<UiState>) => void
  actions: Actions
}) {
  const single = selected.length === 1 ? selected[0] : undefined
  const tabs: Array<{ id: UiState['sidePanel']; label: string }> = [
    { id: 'format', label: 'Format' },
    { id: 'slide', label: 'Slide' },
    { id: 'theme', label: 'Theme' },
  ]
  return (
    <aside aria-label="Side panel" className="flex w-72 shrink-0 flex-col border-l border-rule bg-white">
      <div role="tablist" className="flex h-9 shrink-0 items-stretch border-b border-rule text-[12px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={ui.sidePanel === t.id}
            onClick={() => setUi({ sidePanel: t.id })}
            className={`flex-1 border-b-2 px-2 font-medium ${ui.sidePanel === t.id ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:bg-hover'}`}
          >
            {t.label}
          </button>
        ))}
        {PLACEHOLDER_TABS.map((t) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={false}
            disabled
            title={t.note}
            className="flex-1 cursor-not-allowed border-b-2 border-transparent px-1 text-ink-muted/60"
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[13px]">
        {ui.sidePanel === 'format' && <FormatTab single={single} selected={selected} actions={actions} setUi={setUi} />}
        {ui.sidePanel === 'slide' && <SlideTab deck={deck} slide={slide} actions={actions} />}
        {ui.sidePanel === 'theme' && <ThemeTab theme={deck.theme} actions={actions} />}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Form controls. Numbers and text commit on Enter or blur, not per keystroke.
// ---------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-2 flex items-center gap-2">
      <span className="w-24 shrink-0 text-ink-muted">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )
}

const inputClass = 'h-7 w-full rounded border border-rule bg-white px-1.5 text-[13px] outline-none focus:border-accent'

function NumberInput({ value, onCommit, step = 1 }: { value: number; onCommit: (n: number) => void; step?: number }) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100))
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value])
  const commit = () => {
    const n = Number(draft)
    if (Number.isFinite(n) && n !== value) onCommit(n)
    else setDraft(String(Math.round(value * 100) / 100))
  }
  return (
    <input
      type="number"
      step={step}
      className={inputClass}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

function TextInput({ value, onCommit, placeholder }: { value: string; onCommit: (s: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className={inputClass}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

function Select({ value, options, onChange, disabled }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select className={inputClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  )
}

function hex(value: string | undefined, fallback = '#000000'): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function ColorInput({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  return <input type="color" className="h-7 w-12 cursor-pointer rounded border border-rule" value={hex(value)} onChange={(e) => onChange(e.target.value)} aria-label="Colour" />
}

// ---------------------------------------------------------------------------
// Format tab
// ---------------------------------------------------------------------------

function FormatTab({
  single,
  selected,
  actions,
  setUi,
}: {
  single: Element | undefined
  selected: Element[]
  actions: Actions
  setUi: (patch: Partial<UiState>) => void
}) {
  if (selected.length === 0) {
    return <p className="text-ink-muted">Select an element to see its properties. Click the canvas, or Edit › Select all.</p>
  }
  if (!single) {
    return (
      <div className="space-y-2">
        <p className="font-medium">{selected.length} elements selected</p>
        <p className="text-ink-muted">Use Arrange and Format in the menus to change them together. Single-element fields show when one element is selected.</p>
      </div>
    )
  }
  const el = single
  const update = (patch: Record<string, unknown>) => actions.updateEl(el.id, patch)

  return (
    <div>
      <p className="mb-3 font-medium">{elementLabel(el)}</p>
      <Row label="X">
        <NumberInput value={el.x} onCommit={(n) => update({ x: n })} />
      </Row>
      <Row label="Y">
        <NumberInput value={el.y} onCommit={(n) => update({ y: n })} />
      </Row>
      <Row label="Width">
        <NumberInput value={el.w} onCommit={(n) => update({ w: Math.max(0, n) })} />
      </Row>
      <Row label="Height">
        <NumberInput value={el.h} onCommit={(n) => update({ h: Math.max(0, n) })} />
      </Row>
      <Row label="Rotation">
        <NumberInput value={el.rotation} onCommit={(n) => update({ rotation: n })} />
      </Row>
      <Row label="Opacity">
        <NumberInput value={el.opacity} step={0.05} onCommit={(n) => update({ opacity: Math.min(1, Math.max(0, n)) })} />
      </Row>
      <Row label="Alt text">
        <TextInput value={el.alt ?? ''} placeholder="Describe the image or chart" onCommit={(s) => update({ alt: s || null })} />
      </Row>
      <Row label="Animation">
        <Select
          value={el.animation?.effect ?? 'none'}
          options={[['none', 'None'], ...ANIMATION_EFFECTS.map((e): [string, string] => [e, e])]}
          onChange={(v) => update({ animation: v === 'none' ? null : { effect: v, order: el.animation?.order ?? 0 } })}
        />
      </Row>

      {el.type === 'text' && (
        <div className="mt-4 border-t border-rule-soft pt-3">
          <p className="mb-2 font-medium">Text</p>
          <Row label="Font size">
            <NumberInput value={el.style.fontSize ?? 40} onCommit={(n) => actions.setTextStyle({ fontSize: Math.max(4, n) })} />
          </Row>
          <Row label="Colour">
            <ColorInput value={el.style.color} onChange={(v) => actions.setTextStyle({ color: v })} />
          </Row>
          <Row label="Align">
            <Select
              value={el.style.align}
              options={[['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']]}
              onChange={(v) => actions.setTextStyle({ align: v })}
            />
          </Row>
          <Row label="Vertical">
            <Select
              value={el.style.valign}
              options={[['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]}
              onChange={(v) => actions.setTextStyle({ valign: v })}
            />
          </Row>
        </div>
      )}

      {el.type === 'shape' && (
        <div className="mt-4 border-t border-rule-soft pt-3">
          <p className="mb-2 font-medium">{SHAPE_LABELS[el.shape] ?? 'Shape'}</p>
          <Row label="Shape">
            <Select value={el.shape} options={SHAPE_KINDS.map((k): [string, string] => [k, SHAPE_LABELS[k] ?? k])} onChange={(v) => update({ shape: v })} />
          </Row>
          <Row label="Fill">
            <ColorInput value={el.fill} onChange={(v) => update({ fill: v })} />
          </Row>
          <Row label="Stroke">
            <ColorInput value={el.stroke} onChange={(v) => update({ stroke: v })} />
          </Row>
          <Row label="Stroke width">
            <NumberInput value={el.strokeWidth} onCommit={(n) => update({ strokeWidth: Math.max(0, n) })} />
          </Row>
        </div>
      )}

      {el.type === 'image' && (
        <div className="mt-4 border-t border-rule-soft pt-3">
          <p className="mb-2 font-medium">Image</p>
          <Row label="Source">
            <TextInput value={el.src} onCommit={(s) => update({ src: s })} />
          </Row>
          <Row label="Fit">
            <Select value={el.fit} options={[['contain', 'Contain'], ['cover', 'Cover']]} onChange={(v) => update({ fit: v })} />
          </Row>
        </div>
      )}

      {el.type === 'chart' && (
        <div className="mt-4 border-t border-rule-soft pt-3">
          <p className="mb-2 font-medium">Chart</p>
          <Row label="Type">
            <Select value={el.chartType} options={CHART_TYPES.map((t): [string, string] => [t, CHART_LABELS[t] ?? t])} onChange={(v) => update({ chartType: v })} />
          </Row>
          <Row label="Title">
            <TextInput value={el.options.title ?? ''} onCommit={(s) => update({ options: { ...el.options, title: s || undefined } })} />
          </Row>
          <Row label="Legend">
            <input type="checkbox" checked={el.options.legend} onChange={(e) => update({ options: { ...el.options, legend: e.target.checked } })} />
          </Row>
          <button
            type="button"
            onClick={() => setUi({ dataElementId: el.id })}
            className="mt-1 w-full rounded border border-rule px-2 py-1.5 font-medium text-accent hover:bg-hover"
          >
            Edit data (=DATA())
          </button>
        </div>
      )}

      {el.type === 'diagram' && (
        <div className="mt-4 border-t border-rule-soft pt-3">
          <p className="mb-2 font-medium">Mermaid source</p>
          <textarea
            className="h-32 w-full rounded border border-rule p-1.5 font-mono text-[12px] outline-none focus:border-accent"
            defaultValue={el.source}
            onBlur={(e) => e.target.value !== el.source && update({ source: e.target.value })}
          />
        </div>
      )}

      {(el.type === 'code' || el.type === 'table' || el.type === 'embed') && (
        <p className="mt-4 border-t border-rule-soft pt-3 text-ink-muted">
          {el.type === 'code' && 'Edit the code in the formula bar.'}
          {el.type === 'table' && 'Table cells are edited in place in a later release.'}
          {el.type === 'embed' && 'Embed URL: https only.'}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Slide tab
// ---------------------------------------------------------------------------

function SlideTab({ deck, slide, actions }: { deck: Deck; slide: Slide; actions: Actions }) {
  return (
    <div>
      <p className="mb-3 font-medium">Slide</p>
      <Row label="Layout">
        <Select value={slide.layout} options={SLIDE_LAYOUTS.map((l): [string, string] => [l, l])} onChange={(v) => actions.setSlideLayout(v as Slide['layout'])} />
      </Row>
      <Row label="Background">
        <div className="flex items-center gap-2">
          <ColorInput
            value={slide.background?.type === 'color' ? slide.background.value : deck.theme.colors.background}
            onChange={(v) => actions.setSlideBackground(v)}
          />
          {slide.background && (
            <button type="button" className="text-accent hover:underline" onClick={() => actions.setSlideBackground(null)}>
              Use theme
            </button>
          )}
        </div>
      </Row>
      <Row label="Transition">
        <Select value={slide.transition} options={TRANSITIONS.map((t): [string, string] => [t, t])} onChange={(v) => actions.setTransition(v as Slide['transition'])} />
      </Row>
      <Row label="Auto-animate">
        <input type="checkbox" checked={slide.autoAnimate} onChange={() => actions.toggleAutoAnimate()} />
      </Row>
      <Row label="Hidden">
        <input type="checkbox" checked={slide.hidden} onChange={() => actions.toggleHidden(slide.id)} />
      </Row>
      <Row label="Section">
        <Select
          value={slide.sectionId ?? ''}
          options={[['', 'None'], ...deck.sections.map((s): [string, string] => [s.id, s.name])]}
          onChange={(v) => actions.moveToSection(v || null)}
        />
      </Row>
      <div className="mt-3">
        <p className="mb-1 text-ink-muted">Speaker notes</p>
        <textarea
          key={slide.id}
          className="h-40 w-full rounded border border-rule p-1.5 outline-none focus:border-accent"
          defaultValue={slide.notes}
          onBlur={(e) => e.target.value !== slide.notes && actions.setNotes(e.target.value)}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Theme tab. Colour and font edits are live: each change is one op.
// ---------------------------------------------------------------------------

const COLOR_KEYS: Array<keyof Theme['colors']> = ['background', 'surface', 'text', 'muted', 'accent', 'accent2', 'accent3', 'accent4']

function ThemeTab({ theme, actions }: { theme: Theme; actions: Actions }) {
  return (
    <div>
      <p className="mb-2 font-medium">Built-in themes</p>
      <div className="mb-4 grid grid-cols-2 gap-2">
        {BUILT_IN_THEMES.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => actions.applyBuiltInTheme(t.name)}
            className={`rounded border px-2 py-1.5 text-left hover:border-accent ${theme.name === t.name ? 'border-accent' : 'border-rule'}`}
            style={{ background: t.colors.background, color: t.colors.text }}
          >
            {t.name}
          </button>
        ))}
      </div>
      <p className="mb-2 font-medium">Palette</p>
      <div className="mb-4 grid grid-cols-2 gap-2">
        {COLOR_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="color"
              value={hex(theme.colors[key])}
              onChange={(e) => actions.setThemeToken({ colors: { [key]: e.target.value } })}
              className="h-7 w-9 cursor-pointer rounded border border-rule"
              aria-label={`${key} colour`}
            />
            <span className="text-ink-muted">{key}</span>
          </label>
        ))}
      </div>
      <p className="mb-2 font-medium">Fonts</p>
      <Row label="Heading">
        <TextInput value={theme.fonts.heading} onCommit={(s) => actions.setThemeToken({ fonts: { heading: s } })} />
      </Row>
      <Row label="Body">
        <TextInput value={theme.fonts.body} onCommit={(s) => actions.setThemeToken({ fonts: { body: s } })} />
      </Row>
      <p className="mt-3 text-[11px] text-ink-muted">Fonts are referenced by name. Inter is not loaded from a font host yet.</p>
    </div>
  )
}

// Right side panel: Format (selected element), Slide, Theme, AI, Comments and History. Comments and History
// render outside the read-only fieldset, because commenters and viewers use them.
import { useEffect, useState, type ReactNode } from 'react'
import { ANIMATE_KEY_RE, ANIMATION_EFFECTS, BUILT_IN_THEMES, CHART_TYPES, SHAPE_KINDS, SLIDE_LAYOUTS, TRANSITIONS, type Deck, type Element, type Shadow, type Slide, type Theme } from '@sleid/model'
import type { Actions, UiState } from './actions.ts'
import { ANIMATION_LABELS, CHART_LABELS, elementLabel, SHAPE_LABELS } from './commands.ts'
import { BrandKitSection } from '~/components/brand/BrandKitSection'
import { MAX_FONT_IMPORTS, parseFontImports } from '~/lib/theme-fonts'

export function SidePanel({
  deck,
  deckId,
  slide,
  selected,
  ui,
  setUi,
  actions,
  readOnly,
  aiPanel,
  commentsPanel,
  historyPanel,
  commentsAlert,
}: {
  deck: Deck
  /** The deck's id in the database (the Brand kit section applies kits through the server). */
  deckId: string
  slide: Slide
  selected: Element[]
  ui: UiState
  setUi: (patch: Partial<UiState>) => void
  actions: Actions
  readOnly: boolean
  /** The assistant panel. Only passed for editors and owners. */
  aiPanel?: ReactNode
  /** The Comments tab. Rendered for everyone: commenters and viewers read and (for commenters) write comments. */
  commentsPanel: ReactNode
  historyPanel: ReactNode
  /** Shown as a dot on the Comments tab when there are unread mentions. */
  commentsAlert?: boolean
}) {
  const single = selected.length === 1 ? selected[0] : undefined
  const tabs: Array<{ id: UiState['sidePanel']; label: string; alert?: boolean }> = [
    { id: 'format', label: 'Format' },
    { id: 'slide', label: 'Slide' },
    { id: 'theme', label: 'Theme' },
    ...(aiPanel ? [{ id: 'ai' as const, label: 'AI' }] : []),
    { id: 'comments', label: 'Comments', alert: commentsAlert },
    { id: 'history', label: 'History' },
  ]
  return (
    <aside aria-label="Side panel" className="flex w-72 shrink-0 flex-col border-l border-rule bg-white">
      <div role="tablist" className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-rule text-[11.5px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={ui.sidePanel === t.id}
            data-testid={`side-tab-${t.id}`}
            onClick={() => setUi({ sidePanel: t.id })}
            className={`relative shrink-0 border-b-2 px-1 font-medium ${ui.sidePanel === t.id ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:bg-hover'}`}
          >
            {t.label}
            {t.alert && <span data-testid="comments-alert" aria-label="Unread mentions" className="absolute right-1 top-1.5 size-1.5 rounded-full bg-red-500" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[13px]">
        {/* Viewers and commenters see the values but cannot change them. */}
        {ui.sidePanel !== 'comments' && ui.sidePanel !== 'history' && (
          <fieldset disabled={readOnly} className="flex min-h-0 min-w-0 flex-col border-0 p-0">
            {ui.sidePanel === 'format' && <FormatTab single={single} selected={selected} actions={actions} setUi={setUi} />}
            {ui.sidePanel === 'slide' && <SlideTab deck={deck} slide={slide} actions={actions} />}
            {ui.sidePanel === 'theme' && <ThemeTab theme={deck.theme} brand={deck.brand} deckId={deckId} readOnly={readOnly} actions={actions} />}
            {ui.sidePanel === 'ai' && aiPanel}
          </fieldset>
        )}
        {ui.sidePanel === 'comments' && commentsPanel}
        {ui.sidePanel === 'history' && historyPanel}
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

// M10. Text weights for the Weight select.
const FONT_WEIGHTS: Array<[number, string]> = [
  [100, 'Thin'],
  [200, 'Extra Light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semi Bold'],
  [700, 'Bold'],
  [800, 'Extra Bold'],
  [900, 'Black'],
]

// M10. Shadow presets. A shadow that matches none of them shows as Custom.
const SHADOW_PRESETS: Record<'soft' | 'medium' | 'strong', Shadow> = {
  soft: { x: 0, y: 8, blur: 24, color: 'rgba(0,0,0,0.12)' },
  medium: { x: 0, y: 12, blur: 32, color: 'rgba(0,0,0,0.2)' },
  strong: { x: 0, y: 24, blur: 60, color: 'rgba(0,0,0,0.3)' },
}

function shadowKey(shadow: Shadow | undefined): 'none' | 'custom' | keyof typeof SHADOW_PRESETS {
  if (!shadow) return 'none'
  const match = (Object.keys(SHADOW_PRESETS) as Array<keyof typeof SHADOW_PRESETS>).find((k) => {
    const p = SHADOW_PRESETS[k]
    return shadow.x === p.x && shadow.y === p.y && shadow.blur === p.blur && shadow.color === p.color && !shadow.spread
  })
  return match ?? 'custom'
}

function ShadowRow({ value, onChange }: { value: Shadow | undefined; onChange: (shadow: Shadow | null) => void }) {
  return (
    <Row label="Shadow">
      <Select
        value={shadowKey(value)}
        options={[['none', 'None'], ['soft', 'Soft'], ['medium', 'Medium'], ['strong', 'Strong'], ['custom', 'Custom']]}
        onChange={(v) => {
          // Custom is what the value shows when it matches no preset. Choosing it changes nothing.
          if (v === 'none') onChange(null)
          else if (v === 'soft' || v === 'medium' || v === 'strong') onChange({ ...SHADOW_PRESETS[v] })
        }}
      />
    </Row>
  )
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
  const anim = el.animation
  const g = el.type === 'shape' ? el.gradient : undefined

  // M10. Reveal auto-animate key. Empty clears it. A value outside ANIMATE_KEY_RE is refused, with a message.
  const setAnimateKey = (raw: string) => {
    const key = raw.trim()
    if (key === '') update({ animateKey: null })
    else if (ANIMATE_KEY_RE.test(key)) update({ animateKey: key })
    else actions.toast('Match key: letters, digits, _ and - only, up to 64 characters')
  }

  // M10. Switching the fill type. Linear and radial keep the stops they already have, or start from the fill and the accent.
  const setFillType = (v: string) => {
    if (v === 'solid') {
      update({ gradient: null })
      return
    }
    const type = v === 'radial' ? 'radial' : 'linear'
    const stops = g?.stops ?? [{ color: el.type === 'shape' ? el.fill : '#000000', at: 0 }, { color: actions.theme.colors.accent, at: 1 }]
    update({ gradient: { type, stops, angle: type === 'linear' ? (g?.angle ?? 180) : null } })
  }

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
          options={[['none', 'None'], ...ANIMATION_EFFECTS.map((e): [string, string] => [e, ANIMATION_LABELS[e]])]}
          onChange={(v) => update({ animation: v === 'none' ? null : { effect: v, order: el.animation?.order ?? 0 } })}
        />
      </Row>
      {anim && (
        <Row label="Order">
          <NumberInput value={anim.order} onCommit={(n) => update({ animation: { effect: anim.effect, order: Math.max(0, Math.round(n)) } })} />
        </Row>
      )}
      <Row label="Match key">
        <TextInput value={el.animateKey ?? ''} placeholder="auto-animate key" onCommit={(s) => setAnimateKey(s)} />
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
          <Row label="Weight">
            <Select
              value={el.style.fontWeight === undefined ? 'default' : String(el.style.fontWeight)}
              options={[['default', 'Default'], ...FONT_WEIGHTS.map(([w, label]): [string, string] => [String(w), label])]}
              onChange={(v) => actions.setTextStyle({ fontWeight: v === 'default' ? null : Number(v) })}
            />
          </Row>
          <Row label="Letter spacing">
            <NumberInput
              value={el.style.letterSpacing ?? 0}
              step={0.01}
              onCommit={(n) => actions.setTextStyle({ letterSpacing: n === 0 ? null : Math.min(2, Math.max(-0.5, n)) })}
            />
          </Row>
          <Row label="Case">
            <Select
              value={el.style.textTransform ?? 'default'}
              options={[['default', 'Default'], ['none', 'None'], ['uppercase', 'Uppercase'], ['lowercase', 'Lowercase'], ['capitalize', 'Capitalize']]}
              onChange={(v) => actions.setTextStyle({ textTransform: v === 'default' ? null : v })}
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
            {/* With a gradient, the first stop is the colour shown here. */}
            <ColorInput
              value={g ? g.stops[0]?.color : el.fill}
              onChange={(v) => (g ? update({ gradient: { stops: g.stops.map((s, i) => (i === 0 ? { ...s, color: v } : s)) } }) : update({ fill: v }))}
            />
          </Row>
          <Row label="Fill type">
            <Select value={g?.type ?? 'solid'} options={[['solid', 'Solid'], ['linear', 'Linear'], ['radial', 'Radial']]} onChange={setFillType} />
          </Row>
          {g && (
            <>
              <Row label="Colour 2">
                <ColorInput value={g.stops[1]?.color} onChange={(v) => update({ gradient: { stops: g.stops.map((s, i) => (i === 1 ? { ...s, color: v } : s)) } })} />
              </Row>
              {g.type === 'linear' && (
                <Row label="Angle">
                  <NumberInput value={g.angle ?? 180} onCommit={(n) => update({ gradient: { angle: n } })} />
                </Row>
              )}
            </>
          )}
          <Row label="Stroke">
            <ColorInput value={el.stroke} onChange={(v) => update({ stroke: v })} />
          </Row>
          <Row label="Stroke width">
            <NumberInput value={el.strokeWidth} onCommit={(n) => update({ strokeWidth: Math.max(0, n) })} />
          </Row>
          <Row label="Stroke style">
            <Select value={el.strokeDash ?? 'solid'} options={[['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]} onChange={(v) => update({ strokeDash: v })} />
          </Row>
          {(el.shape === 'rect' || el.shape === 'roundRect') && (
            <Row label="Corner radius">
              <NumberInput value={el.radius ?? 0} onCommit={(n) => update({ radius: Math.max(0, n) })} />
            </Row>
          )}
          {el.shape === 'roundRect' && el.radius === undefined && (
            <p className="-mt-1 mb-2 text-[11px] text-ink-muted">Not set: the corners are 12%. Enter a radius to change them.</p>
          )}
          <ShadowRow value={el.shadow} onChange={(shadow) => update({ shadow })} />
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
          <Row label="Corner radius">
            <NumberInput value={el.radius ?? 0} onCommit={(n) => update({ radius: Math.max(0, n) })} />
          </Row>
          <ShadowRow value={el.shadow} onChange={(shadow) => update({ shadow })} />
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

// M10. Comma-separated Google Fonts families. Entries that fail the check are not saved, and are named in a note.
function WebFontsRow({ theme, actions }: { theme: Theme; actions: Actions }) {
  const [dropped, setDropped] = useState<string[]>([])
  return (
    <>
      <Row label="Web fonts">
        <TextInput
          value={(theme.fontImports ?? []).join(', ')}
          placeholder="Inter:wght@400;600;700, Noto Sans TC"
          onCommit={(text) => {
            const parsed = parseFontImports(text)
            setDropped(parsed.dropped)
            actions.setThemeToken({ fontImports: parsed.kept })
          }}
        />
      </Row>
      {dropped.length > 0 && (
        <p className="-mt-1 mb-2 text-[11px] text-red-700">
          Not saved: {dropped.join(', ')}. Use Google Fonts family names, with an optional axis list such as Inter:wght@400;600. Up to {MAX_FONT_IMPORTS} families.
        </p>
      )}
    </>
  )
}

function ThemeTab({ theme, brand, deckId, readOnly, actions }: { theme: Theme; brand: Deck['brand']; deckId: string; readOnly: boolean; actions: Actions }) {
  return (
    <div>
      <BrandKitSection deckId={deckId} brand={brand} readOnly={readOnly} />
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
      <WebFontsRow theme={theme} actions={actions} />
      <p className="mt-3 text-[11px] text-ink-muted">Font names are used as written. Web fonts load from Google Fonts, so they need a connection. Without one, the font stack is used.</p>
    </div>
  )
}

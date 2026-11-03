// Menu entries and the theme dialog for the assistant. The fx bar's Ask AI, the text context menu,
// and Tools ▸ AI all build their items here, so the choices stay the same everywhere.
import { useState } from 'react'
import { CHART_TYPES, type Element } from '@sleid/model'
import type { MenuEntry } from './Overlays.tsx'
import { CHART_LABELS } from './commands.ts'

export interface AskHandlers {
  rewrite: (elementId: string, mode: string, extra?: { language?: string; instruction?: string }) => void
  askLanguage: (elementId: string) => void
  askInstruction: (elementId: string) => void
  chartChange: (elementId: string, chartType: string) => void
  chartInstruction: (elementId: string) => void
  explainChart: (elementId: string) => void
  diagramInstruction: (elementId: string) => void
  slideFromPrompt: (empty: boolean) => void
  openPanel: () => void
}

const REWRITES: Array<[string, string]> = [
  ['improve', 'Improve writing'],
  ['shorten', 'Shorten'],
  ['expand', 'Expand'],
  ['formal', 'Make formal'],
  ['casual', 'Make casual'],
  ['fix-grammar', 'Fix grammar'],
  ['bulletize', 'Turn into bullets'],
]

/** Rewrite choices for one text box. */
export function rewriteEntries(elementId: string, h: AskHandlers): MenuEntry[] {
  return [
    ...REWRITES.map(([mode, label]) => ({ kind: 'item' as const, label, onSelect: () => h.rewrite(elementId, mode) })),
    { kind: 'item', label: 'Translate…', onSelect: () => h.askLanguage(elementId) },
    { kind: 'item', label: 'Custom instruction…', onSelect: () => h.askInstruction(elementId) },
  ]
}

/** The fx bar's Ask AI menu. It depends on what is selected. */
export function askMenuEntries(args: { single: Element | undefined; slideEmpty: boolean; slideIndex: number }, h: AskHandlers): MenuEntry[] {
  const { single } = args
  const entries: MenuEntry[] = []
  if (single?.type === 'text') {
    entries.push({ kind: 'group', label: 'Rewrite', items: rewriteEntries(single.id, h) })
  } else if (single?.type === 'chart') {
    entries.push({
      kind: 'group',
      label: 'Chart',
      items: [
        { kind: 'item', label: 'Change to…', onSelect: () => h.chartInstruction(single.id) },
        { kind: 'group', label: 'Change type', items: CHART_TYPES.map((t) => ({ kind: 'item' as const, label: CHART_LABELS[t] ?? t, onSelect: () => h.chartChange(single.id, t) })) },
        { kind: 'item', label: 'Explain this chart', onSelect: () => h.explainChart(single.id) },
      ],
    })
  } else if (single?.type === 'diagram') {
    entries.push({ kind: 'item', label: 'Change diagram…', onSelect: () => h.diagramInstruction(single.id) })
  }
  if (args.slideEmpty) entries.push({ kind: 'item', label: 'Fill this slide from a prompt…', onSelect: () => h.slideFromPrompt(true) })
  entries.push({ kind: 'item', label: 'Generate a new slide from a prompt…', onSelect: () => h.slideFromPrompt(false) })
  entries.push({ kind: 'sep' })
  entries.push({ kind: 'item', label: 'Open the assistant', onSelect: h.openPanel })
  return entries
}

/** Generate theme: a prompt, brand colours, or both. */
export function ThemeDialog({ onSubmit, onClose }: { onSubmit: (input: { prompt?: string; brandColors?: string[] }) => void; onClose: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [colours, setColours] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    const brand = colours
      .split(/[\s,]+/)
      .map((c) => c.trim())
      .filter(Boolean)
    if (brand.some((c) => !/^#[0-9a-f]{6}$/i.test(c))) return setError('Brand colours are hex values like #1a73e8, separated by commas')
    if (!prompt.trim() && brand.length === 0) return setError('Describe the look, or give brand colours')
    onClose()
    onSubmit({ ...(prompt.trim() ? { prompt: prompt.trim() } : {}), ...(brand.length ? { brandColors: brand.slice(0, 8) } : {}) })
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Generate theme"
        className="w-[28rem] rounded-lg bg-white p-4 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <h2 className="mb-3 text-base font-medium">Generate theme</h2>
        <label className="block text-ink-muted" htmlFor="theme-prompt">
          Describe the look
        </label>
        <textarea
          id="theme-prompt"
          autoFocus
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="For example: calm, dark, for a climate report"
          className="mt-1 w-full rounded border border-rule p-2 outline-none focus:border-accent"
        />
        <label className="mt-3 block text-ink-muted" htmlFor="theme-brand">
          Brand colours (optional, hex, comma separated)
        </label>
        <input
          id="theme-brand"
          value={colours}
          onChange={(e) => setColours(e.target.value)}
          placeholder="#0b57d0, #e37400"
          className="mt-1 h-9 w-full rounded border border-rule px-2 outline-none focus:border-accent"
        />
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-red-700">
            {error}
          </p>
        )}
        <p className="mt-3 text-[11px] text-ink-muted">Text and accent colours are adjusted to meet WCAG AA contrast. Any adjustment is listed on the proposal.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
            Cancel
          </button>
          <button type="submit" className="rounded bg-accent px-3 py-1.5 font-medium text-white">
            Generate
          </button>
        </div>
      </form>
    </div>
  )
}

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { createWizardRunFn } from '~/lib/wizard.functions'
import { listTemplatesFn } from '~/lib/templates.functions'
import { listBrandKitsFn } from '~/lib/brand-kits.functions'
import { THEME_CHOICES, WIZARD_GOALS, AI_THEME } from '@sleid/llm/wizard-schema'
import { galleryTabOf, type TemplateItem } from '~/components/templates/TemplateCard'
import type { GalleryTab } from '~/components/templates/TemplateGallery'

export const Route = createFileRoute('/_authed/wizard/new')({
  loader: async () => ({ templates: await listTemplatesFn(), kits: await listBrandKitsFn() }),
  component: NewFromPrompt,
})

/** The browser's language when the wizard supports it (Indonesian or English), otherwise English. */
/** The template options, grouped: built-in first, then the caller's own, then the ones shared on this server. */
function TemplateOptions({ templates }: { templates: TemplateItem[] }) {
  const groups: Array<[string, GalleryTab]> = [
    ['Built-in', 'builtin'],
    ['Mine', 'mine'],
    ['Shared on this server', 'shared'],
  ]
  return (
    <>
      {groups.map(([label, tab]) => {
        const items = templates.filter((t) => galleryTabOf(t) === tab)
        if (items.length === 0) return null
        return (
          <optgroup key={tab} label={label}>
            {items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </optgroup>
        )
      })}
    </>
  )
}

export function browserLanguage(): string {
  if (typeof navigator === 'undefined') return 'en'
  const primary = (navigator.language || 'en').split('-')[0]!.toLowerCase()
  return primary === 'id' ? 'id' : 'en'
}

function NewFromPrompt() {
  const navigate = useNavigate()
  const loaded = Route.useLoaderData()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [audience, setAudience] = useState('')
  const [goal, setGoal] = useState<(typeof WIZARD_GOALS)[number]>('inform')
  const [slideCount, setSlideCount] = useState(10)
  const [tone, setTone] = useState('')
  const [language, setLanguage] = useState(browserLanguage())
  const [theme, setTheme] = useState<string>('Sheets Light')
  const [brandColors, setBrandColors] = useState('')
  const [notes, setNotes] = useState(true)
  const [charts, setCharts] = useState(true)
  const [sources, setSources] = useState(true)
  const [templateId, setTemplateId] = useState('')
  const [brandKitId, setBrandKitId] = useState('')

  /** A brand kit's palette is the rule for colours, so the AI theme (which invents them) is not offered with one. */
  function chooseKit(id: string) {
    setBrandKitId(id)
    if (id && theme === AI_THEME) setTheme('Sheets Light')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!prompt.trim()) return setError('Describe the deck first.')
    if (slideCount < 3 || slideCount > 30) return setError('A deck has 3 to 30 slides.')
    const colors = brandColors.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean)
    setBusy(true)
    try {
      const run = await createWizardRunFn({
        data: {
          brief: {
            prompt: prompt.trim(),
            audience: audience.trim(),
            goal,
            slideCount,
            tone: tone.trim(),
            language: language.trim() || 'en',
            theme,
            ...(theme === 'AI from brand colours' && colors.length ? { brandColors: colors } : {}),
            includeNotes: notes,
            includeCharts: charts,
            includeSources: sources,
            ...(templateId ? { templateId } : {}),
            ...(brandKitId ? { brandKitId } : {}),
          },
        },
      })
      await navigate({ to: '/wizard/$runId', params: { runId: run.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The brief could not be saved.')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center gap-2 border-b border-rule bg-white px-4">
        <span className="grid size-8 place-items-center rounded bg-accent text-white font-semibold">S</span>
        <span className="text-lg font-medium">New deck from a prompt</span>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-8">
        <p className="text-sm text-ink-muted">Step 1 of 5: the brief. Next you can add references, research and review the outline.</p>
        <form onSubmit={submit} className="mt-6 space-y-5" aria-label="Brief">
          <label className="block">
            <span className="text-sm font-medium">What is the deck about? *</span>
            <textarea
              required
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Pitch deck: rooftop solar for small bakeries in Jakarta"
              className="mt-1 w-full rounded border border-rule bg-white p-2"
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium">Audience</span>
              <input value={audience} onChange={(e) => setAudience(e.target.value)} className="mt-1 w-full rounded border border-rule p-2" />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Goal</span>
              <select value={goal} onChange={(e) => setGoal(e.target.value as (typeof WIZARD_GOALS)[number])} className="mt-1 w-full rounded border border-rule p-2">
                {WIZARD_GOALS.map((g) => (
                  <option key={g} value={g}>
                    {g[0]!.toUpperCase() + g.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Slides (3 to 30)</span>
              <input type="number" min={3} max={30} value={slideCount} onChange={(e) => setSlideCount(Number(e.target.value))} className="mt-1 w-full rounded border border-rule p-2" />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Tone</span>
              <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Warm, plain" className="mt-1 w-full rounded border border-rule p-2" />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Language</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="mt-1 w-full rounded border border-rule p-2">
                <option value="en">English</option>
                <option value="id">Bahasa Indonesia</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Theme</span>
              <select value={theme} onChange={(e) => setTheme(e.target.value)} className="mt-1 w-full rounded border border-rule p-2">
                {THEME_CHOICES.map((t) => (
                  <option key={t} value={t} disabled={t === AI_THEME && brandKitId !== ''}>
                    {t}
                  </option>
                ))}
              </select>
              {brandKitId !== '' && (
                <span data-testid="wizard-ai-theme-hint" className="mt-1 block text-[12px] text-ink-muted">
                  AI from brand colours is off while a brand kit is chosen. The kit's palette is the rule for colours.
                </span>
              )}
            </label>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium">Template (optional)</span>
              <select data-testid="wizard-template-picker" value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="mt-1 w-full rounded border border-rule p-2">
                <option value="">No template</option>
                <TemplateOptions templates={loaded.templates} />
              </select>
              <span className="mt-1 block text-[12px] text-ink-muted">A template gives the deck its theme and layouts. The theme choice above is then ignored.</span>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Brand kit (optional)</span>
              <select data-testid="wizard-brand-kit-picker" value={brandKitId} onChange={(e) => chooseKit(e.target.value)} className="mt-1 w-full rounded border border-rule p-2">
                <option value="">No brand kit</option>
                {loaded.kits.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                    {k.owned ? '' : ' (shared)'}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[12px] text-ink-muted">The kit's colours, fonts and logo are used for every slide.</span>
            </label>
          </div>
          {theme === 'AI from brand colours' && (
            <label className="block">
              <span className="text-sm font-medium">Brand colours (hex, up to 4)</span>
              <input value={brandColors} onChange={(e) => setBrandColors(e.target.value)} placeholder="#0f766e, #f59e0b" className="mt-1 w-full rounded border border-rule p-2" />
            </label>
          )}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Include</legend>
            <label className="flex items-center gap-2"><input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> Speaker notes (with citations)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={charts} onChange={(e) => setCharts(e.target.checked)} /> Charts where the references hold data</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={sources} onChange={(e) => setSources(e.target.checked)} /> A Sources slide at the end</label>
          </fieldset>
          {error && <p role="alert" className="text-red-700">{error}</p>}
          <button type="submit" disabled={busy} className="rounded bg-accent px-4 py-2 font-medium text-white disabled:opacity-60">
            {busy ? 'Saving…' : 'Next: references'}
          </button>
        </form>
      </main>
    </div>
  )
}

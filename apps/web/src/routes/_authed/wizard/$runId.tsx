import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
// The limits module only: the package root pulls in the server-side extractors (happy-dom, unpdf) which the browser cannot load.
import { LIMITS } from '@sleid/ingest/limits'
import { WIZARD_LAYOUTS, VISUALS, type Outline, type OutlineSlide } from '@sleid/llm/wizard-schema'
import {
  addWizardUrlFn,
  cancelWizardRunFn,
  draftWizardOutlineFn,
  getWizardRunFn,
  removeWizardSourceFn,
  saveWizardOutlineFn,
  startWizardGenerationFn,
  startWizardResearchFn,
} from '~/lib/wizard.functions'
import type { RunView } from '~/lib/wizard.server'
import { AppHeader } from '~/components/AppHeader'
import { ChevronDown, ChevronUp, X } from '~/components/icons'

export const Route = createFileRoute('/_authed/wizard/$runId')({
  loader: ({ params }) => getWizardRunFn({ data: { runId: params.runId } }),
  component: WizardRun,
})

const ACTIVE = ['ingesting', 'outlining', 'generating']
const isPending = (run: RunView) => run.sources.some((s) => s.status === 'queued' || s.status === 'running')

function WizardRun() {
  const initial = Route.useLoaderData()
  const [run, setRun] = useState<RunView>(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const navigate = useNavigate()
  const [outline, setOutline] = useState<Outline | null>(initial.outline)
  const saveTimer = useRef<number | undefined>(undefined)

  // Poll while something is being read, drafted or generated.
  useEffect(() => {
    if (!(ACTIVE.includes(run.status) || isPending(run))) return
    const timer = window.setInterval(() => {
      getWizardRunFn({ data: { runId: run.id } })
        .then((next) => {
          setRun(next)
          if (next.status === 'generating' && next.deckId) void navigate({ to: '/d/$deckId', params: { deckId: next.deckId } })
        })
        .catch(() => undefined)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [run.id, run.status, run.sources, navigate])

  async function act(label: string, fn: () => Promise<RunView | unknown>) {
    setBusy(label)
    setError(null)
    try {
      const next = (await fn()) as RunView | undefined
      if (next && typeof next === 'object' && 'sources' in next) {
        setRun(next)
        setOutline(next.outline)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(null)
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files) return
    for (const file of Array.from(files)) {
      setBusy(`Adding ${file.name}`)
      try {
        const response = await fetch(`/api/wizard/${run.id}/files`, {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' },
          body: file,
        })
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok) setError(body.error ?? `${file.name} could not be added.`)
      } catch {
        setError(`${file.name} could not be uploaded.`)
      }
    }
    setBusy(null)
    setRun(await getWizardRunFn({ data: { runId: run.id } }))
  }

  const [url, setUrl] = useState('')
  const [research, setResearch] = useState(run.brief.research)
  const draft = run.status === 'draft' || run.status === 'ready'
  const files = run.sources.filter((s) => s.kind === 'file')
  const links = run.sources.filter((s) => s.kind !== 'file')

  function editOutline(next: Outline) {
    setOutline(next)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void act('Saving outline', () => saveWizardOutlineFn({ data: { runId: run.id, outline: next } }))
    }, 600)
  }

  return (
    <div className="min-h-screen">
      <AppHeader title={run.brief.prompt} />
      <main className="mx-auto max-w-3xl space-y-8 px-6 py-8">
        <section aria-label="Status" className="rounded border border-rule bg-white p-4">
          <p className="text-sm">
            Status: <strong>{run.status}</strong>
            {run.status === 'generating' && <span> · Slide {run.progress} of {run.total}</span>}
          </p>
          {busy && <p className="mt-1 text-sm text-ink-muted" role="status">{busy}…</p>}
          {run.error && <p className="mt-1 text-sm text-amber-800">{run.error}</p>}
          {error && <p role="alert" className="mt-1 text-sm text-red-700">{error}</p>}
        </section>

        <section aria-label="References" className="space-y-3">
          <h2 className="text-lg font-medium">2. References (optional)</h2>
          <p className="text-sm text-ink-muted">Up to {LIMITS.maxFiles} files (PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, PNG, JPG; {LIMITS.maxFileBytes / (1024 * 1024)} MB each, {LIMITS.maxTotalBytes / (1024 * 1024)} MB in all) and {LIMITS.maxUrls} web addresses.</p>
          <input type="file" multiple disabled={!draft} accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg" onChange={(e) => void addFiles(e.target.files)} aria-label="Add files" />
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const value = url
              setUrl('')
              void act('Adding address', () => addWizardUrlFn({ data: { runId: run.id, url: value } }).then(() => getWizardRunFn({ data: { runId: run.id } })))
            }}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" disabled={!draft} className="flex-1 rounded border border-rule p-2" aria-label="Web address" />
            <button type="submit" disabled={!draft || !url.trim()} className="rounded border border-rule px-3 disabled:opacity-60">Add address</button>
          </form>
          <ul className="flex flex-wrap gap-2" aria-label="Reference list">
            {run.sources.map((s) => (
              <li key={s.id} className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${s.status === 'failed' ? 'border-red-300 text-red-800' : 'border-rule'}`}>
                <span className="max-w-[16rem] truncate" title={s.error ?? s.url ?? s.fileName ?? s.title}>{s.title}</span>
                <span className="text-ink-muted">
                  {s.status === 'ready' ? `${s.wordCount} words${s.tables ? ` · ${s.tables} table${s.tables > 1 ? 's' : ''}` : ''}${s.images ? ` · ${s.images} image` : ''}` : s.status === 'failed' ? `failed: ${s.error ?? ''}` : s.status}
                </span>
                {draft && (
                  <button type="button" aria-label={`Remove ${s.title}`} onClick={() => void act('Removing', () => removeWizardSourceFn({ data: { runId: run.id, sourceId: s.id } }).then(() => getWizardRunFn({ data: { runId: run.id } })))} className="text-ink-muted hover:text-red-700"><X size={14} /></button>
                )}
              </li>
            ))}
          </ul>
          {run.sources.length === 0 && <p className="text-sm text-ink-muted">No references yet. The outline can be written from the prompt alone.</p>}
          {files.length + links.length > 0 && <p className="text-xs text-ink-muted">{files.length} file(s), {links.length} address(es).</p>}
        </section>

        <section aria-label="Research" className="space-y-3">
          <h2 className="text-lg font-medium">3. Research</h2>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={research} disabled={!run.researchAvailable || !draft} onChange={(e) => setResearch(e.target.checked)} />
            Let AI research this topic
          </label>
          {!run.researchAvailable && <p className="text-sm text-ink-muted">Research is off: {run.researchLabel}. Set a search provider to use it (see the README).</p>}
          {run.researchAvailable && <p className="text-sm text-ink-muted">{run.researchLabel}. The AI searches, then reads up to 8 pages as references.</p>}
          <button
            type="button"
            disabled={!research || !draft || !run.researchAvailable || busy !== null}
            onClick={() => void act('Researching', () => startWizardResearchFn({ data: { runId: run.id } }))}
            className="rounded border border-rule px-3 py-1.5 disabled:opacity-60"
          >
            Research now
          </button>
        </section>

        <section aria-label="Outline" className="space-y-3">
          <h2 className="text-lg font-medium">4. Outline</h2>
          <button
            type="button"
            disabled={!draft || busy !== null || run.status === 'ingesting' || isPending(run)}
            onClick={() => void act('Drafting the outline', () => draftWizardOutlineFn({ data: { runId: run.id } }))}
            className="rounded bg-accent px-4 py-2 font-medium text-white disabled:opacity-60"
          >
            {outline ? 'Regenerate outline' : 'Draft outline'}
          </button>
          {outline && (
            <div className="space-y-3">
              <label className="block">
                <span className="text-sm font-medium">Deck title</span>
                <input value={outline.title} onChange={(e) => editOutline({ ...outline, title: e.target.value })} className="mt-1 w-full rounded border border-rule p-2" />
              </label>
              <OutlineList outline={outline} onChange={editOutline} disabled={run.status !== 'ready'} />
            </div>
          )}
        </section>

        <section aria-label="Generate" className="space-y-3">
          <h2 className="text-lg font-medium">5. Generate</h2>
          <p className="text-sm text-ink-muted">The deck opens at once. Slides appear one by one as they are written.</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={run.status !== 'ready' || busy !== null}
              onClick={() =>
                void act('Starting', async () => {
                  const { deckId } = await startWizardGenerationFn({ data: { runId: run.id } })
                  await navigate({ to: '/d/$deckId', params: { deckId } })
                })
              }
              className="rounded bg-accent px-4 py-2 font-medium text-white disabled:opacity-60"
            >
              Generate deck
            </button>
            {ACTIVE.includes(run.status) && run.status !== 'generating' && (
              <button type="button" onClick={() => void act('Cancelling', () => cancelWizardRunFn({ data: { runId: run.id } }))} className="rounded border border-rule px-3 py-2">
                Cancel
              </button>
            )}
            {run.status === 'generating' && run.deckId && (
              <Link to="/d/$deckId" params={{ deckId: run.deckId }} className="rounded border border-rule px-3 py-2">Open deck</Link>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

function OutlineList({ outline, onChange, disabled }: { outline: Outline; onChange: (o: Outline) => void; disabled: boolean }) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const update = (index: number, patch: Partial<OutlineSlide>) => onChange({ ...outline, slides: outline.slides.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  const move = (from: number, to: number) => {
    if (from === to) return
    const slides = [...outline.slides]
    const [item] = slides.splice(from, 1)
    if (item) slides.splice(to, 0, item)
    onChange({ ...outline, slides })
  }
  return (
    <ol className="space-y-2" aria-label="Slides">
      {outline.slides.map((slide, i) => (
        <li
          key={i}
          draggable={!disabled}
          onDragStart={() => setDragFrom(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragFrom !== null) move(dragFrom, i)
            setDragFrom(null)
          }}
          className="rounded border border-rule bg-white p-3"
          data-testid="outline-slide"
        >
          <div className="flex items-center gap-2">
            <span className="w-6 text-sm text-ink-muted">{i + 1}</span>
            <input aria-label={`Slide ${i + 1} title`} value={slide.title} disabled={disabled} onChange={(e) => update(i, { title: e.target.value })} className="flex-1 rounded border border-rule p-1.5 font-medium" />
            <select aria-label={`Slide ${i + 1} layout`} value={slide.layout} disabled={disabled} onChange={(e) => update(i, { layout: e.target.value as OutlineSlide['layout'] })} className="rounded border border-rule p-1">
              {WIZARD_LAYOUTS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <select aria-label={`Slide ${i + 1} visual`} value={slide.visual} disabled={disabled} onChange={(e) => update(i, { visual: e.target.value as OutlineSlide['visual'] })} className="rounded border border-rule p-1">
              {VISUALS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <button type="button" aria-label={`Move slide ${i + 1} up`} disabled={disabled || i === 0} onClick={() => move(i, i - 1)} className="px-1"><ChevronUp size={14} /></button>
            <button type="button" aria-label={`Move slide ${i + 1} down`} disabled={disabled || i === outline.slides.length - 1} onClick={() => move(i, i + 1)} className="px-1"><ChevronDown size={14} /></button>
            <button type="button" aria-label={`Delete slide ${i + 1}`} disabled={disabled || outline.slides.length <= 1} onClick={() => onChange({ ...outline, slides: outline.slides.filter((_, j) => j !== i) })} className="px-1 text-red-700"><X size={14} /></button>
          </div>
          <textarea
            aria-label={`Slide ${i + 1} key points`}
            rows={2}
            value={slide.keyPoints.join('\n')}
            disabled={disabled}
            onChange={(e) => update(i, { keyPoints: e.target.value.split('\n').filter((l) => l.trim()).slice(0, 6) })}
            className="mt-2 w-full rounded border border-rule p-1.5 text-sm"
            placeholder="One key point per line"
          />
        </li>
      ))}
      <li>
        <button
          type="button"
          disabled={disabled || outline.slides.length >= 30}
          onClick={() => onChange({ ...outline, slides: [...outline.slides, { title: 'New slide', layout: 'title-content', keyPoints: [], visual: 'none', sourceIds: [] }] })}
          className="rounded border border-dashed border-rule px-3 py-1.5 text-sm"
        >
          Add slide
        </button>
      </li>
    </ol>
  )
}

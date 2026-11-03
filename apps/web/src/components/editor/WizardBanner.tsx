// Top banner for a deck made by the prompt-to-deck wizard: live progress with cancel while it generates,
// then "review sources" with the reference list. Polls the run; renders nothing for decks made by hand.
import { useEffect, useState } from 'react'
import { cancelWizardRunFn, getWizardForDeckFn } from '~/lib/wizard.functions'
import type { RunView } from '~/lib/wizard.server'

const LIVE = ['ingesting', 'outlining', 'generating']

export function WizardBanner({ deckId }: { deckId: string }) {
  const [run, setRun] = useState<RunView | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const next = await getWizardForDeckFn({ data: { deckId } })
        if (!alive) return
        setRun(next)
        if (next && LIVE.includes(next.status)) timer = window.setTimeout(tick, 1000)
      } catch {
        if (alive) timer = window.setTimeout(tick, 3000)
      }
    }
    void tick()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [deckId])

  if (!run || dismissed) return null
  const live = LIVE.includes(run.status)
  if (!live && run.status !== 'done' && run.status !== 'cancelled' && run.status !== 'failed') return null

  return (
    <div role="status" aria-label="Wizard progress" className="fixed inset-x-0 top-0 z-50 border-b border-rule bg-white/95 px-4 py-2 text-sm shadow-sm">
      <div className="flex items-center gap-3">
        {run.status === 'generating' && (
          <>
            <span>Slide {run.progress} of {run.total}</span>
            <progress className="h-2 w-48" value={run.progress} max={Math.max(run.total, 1)} aria-label="Generation progress" />
            <button
              type="button"
              className="rounded border border-rule px-2 py-0.5"
              onClick={() => void cancelWizardRunFn({ data: { runId: run.id } }).then(setRun).catch(() => setNote('Could not cancel.'))}
            >
              Cancel
            </button>
          </>
        )}
        {run.status === 'done' && <span>Generated from prompt. Review the sources before you present.</span>}
        {run.status === 'cancelled' && <span>Generation was cancelled. The slides written so far are kept.</span>}
        {run.status === 'failed' && <span className="text-red-700">Generation failed: {run.error}</span>}
        {live && run.status !== 'generating' && <span>Wizard: {run.status}…</span>}
        {run.sources.length > 0 && (
          <button type="button" className="ml-auto rounded px-2 py-0.5 text-accent hover:bg-hover" onClick={() => setShowSources((v) => !v)}>
            Sources ({run.sources.length})
          </button>
        )}
        {!live && (
          <button type="button" aria-label="Dismiss" className="rounded px-2 py-0.5 text-ink-muted hover:bg-hover" onClick={() => setDismissed(true)}>
            ✕
          </button>
        )}
      </div>
      {note && <p className="text-red-700">{note}</p>}
      {showSources && (
        <aside aria-label="Sources" className="mt-2 max-h-72 overflow-auto rounded border border-rule bg-white p-3">
          <ul className="space-y-1">
            {run.sources.map((s) => (
              <li key={s.id}>
                <span className="font-medium">{s.title}</span>{' '}
                {s.url && (
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                    {s.url}
                  </a>
                )}
                {s.fileName && <span className="text-ink-muted"> {s.fileName}</span>}
                <span className="text-ink-muted"> · {s.status === 'ready' ? `${s.wordCount} words` : s.status}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  )
}

// Banner for a deck made by the prompt-to-deck wizard: live progress with cancel while it generates, then the slides
// the model could not write (with a retry), then "review sources" with the reference list. It sits in the editor's
// layout flow, between the toolbar and the formula bar. Polls the run; renders nothing for decks made by hand.
import { useEffect, useState } from 'react'
import { cancelWizardRunFn, getWizardForDeckFn, retryWizardFailedFn } from '~/lib/wizard.functions'
import type { RunView } from '~/lib/wizard.server'
import { X } from '~/components/icons'

const LIVE = ['ingesting', 'outlining', 'generating']

function slideList(numbers: number[]): string {
  return numbers.length === 1 ? `Slide ${numbers[0]}` : `Slides ${numbers.join(', ')}`
}

export function WizardBanner({ deckId }: { deckId: string }) {
  const [run, setRun] = useState<RunView | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Bumped after a retry starts, so polling resumes even though the run was done.
  const [poll, setPoll] = useState(0)

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
  }, [deckId, poll])

  if (!run || dismissed) return null
  const live = LIVE.includes(run.status)
  if (!live && run.status !== 'done' && run.status !== 'cancelled' && run.status !== 'failed') return null
  const failed = run.failedSlides

  return (
    <div role="status" aria-label="Wizard progress" className="shrink-0 border-b border-rule bg-white px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
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
        {run.status === 'done' && failed.length === 0 && <span>Generated from prompt. Review the sources before you present.</span>}
        {run.status === 'done' && failed.length > 0 && (
          <>
            <span>Generated from prompt. <span className="text-amber-800">{slideList(failed)} could not be written and show the outline points.</span></span>
            <button
              type="button"
              className="rounded border border-rule px-2 py-0.5 font-medium hover:bg-hover"
              onClick={() =>
                void retryWizardFailedFn({ data: { runId: run.id } })
                  .then((next) => {
                    setNote(null)
                    setRun(next)
                    setPoll((n) => n + 1)
                  })
                  .catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Could not retry.'))
              }
            >
              Retry failed slides
            </button>
          </>
        )}
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
            <X size={14} />
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

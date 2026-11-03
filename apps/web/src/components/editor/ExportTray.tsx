// Export jobs started from this editor. Each one polls its status until it is done or failed.
import { useCallback, useEffect, useState } from 'react'
import { getExportFn, startExportFn } from '~/lib/export.functions'
import { X } from '~/components/icons'

export interface ExportJob {
  id: string
  label: string
  status: 'queued' | 'running' | 'done' | 'failed'
  fileName: string | null
  downloadUrl: string | null
  error: string | null
}

export function useExportJobs(deckId: string) {
  const [jobs, setJobs] = useState<ExportJob[]>([])

  const start = useCallback(
    async (input: { format: string; options: Record<string, unknown>; label: string }) => {
      const { id } = await startExportFn({ data: { deckId, format: input.format, options: input.options } })
      setJobs((prev) => [{ id, label: input.label, status: 'queued' as const, fileName: null, downloadUrl: null, error: null }, ...prev].slice(0, 6))
    },
    [deckId],
  )

  const dismiss = useCallback((id: string) => setJobs((prev) => prev.filter((j) => j.id !== id)), [])

  const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const pendingKey = pending.map((j) => j.id).join(',')
  useEffect(() => {
    if (!pendingKey) return
    const timer = setTimeout(() => {
      void Promise.all(
        pendingKey.split(',').map(async (id) => {
          try {
            const s = await getExportFn({ data: { exportId: id } })
            setJobs((prev) =>
              prev.map((j) =>
                j.id === id ? { ...j, status: s.status, fileName: s.fileName, downloadUrl: s.downloadUrl, error: s.error } : j,
              ),
            )
          } catch (err) {
            setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: 'failed', error: err instanceof Error ? err.message : 'Lost track of this export' } : j)))
          }
        }),
      )
    }, 1000)
    return () => clearTimeout(timer)
  }, [pendingKey, jobs])

  return { jobs, start, dismiss }
}

export function ExportTray({ jobs, onDismiss }: { jobs: ExportJob[]; onDismiss: (id: string) => void }) {
  if (jobs.length === 0) return null
  return (
    <div aria-live="polite" className="fixed bottom-14 right-4 z-40 flex w-80 flex-col gap-2">
      {jobs.map((job) => (
        <div key={job.id} role="status" className="rounded-md border border-rule bg-white p-3 text-[13px] shadow-lg">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{job.label}</div>
              {(job.status === 'queued' || job.status === 'running') && <div className="text-ink-muted">Exporting…</div>}
              {job.status === 'done' && job.downloadUrl && (
                <a href={job.downloadUrl} download={job.fileName ?? undefined} className="text-accent underline">
                  Download {job.fileName}
                </a>
              )}
              {job.status === 'failed' && <div role="alert" className="text-red-700">Export failed: {job.error}</div>}
            </div>
            <button type="button" aria-label={`Dismiss ${job.label}`} onClick={() => onDismiss(job.id)} className="rounded px-1.5 text-ink-muted hover:bg-hover">
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

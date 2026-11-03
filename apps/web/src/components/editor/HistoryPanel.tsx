// The History tab: a timeline of named versions and automatic checkpoints. Named versions come first; automatic
// ones are grouped by day, with the people who edited around that time. Clicking one previews it (the editor
// shows it read-only, with Restore and Back to current).
import { useCallback, useEffect, useState } from 'react'
import type { VersionEntry } from '@sleid/db'
import { listVersionsFn } from '~/lib/versions.functions'
import { groupByDay } from './history-model'

type Version = VersionEntry

export function HistoryPanel({
  deckId,
  activeVersionId,
  refreshKey,
  onPreview,
  onNameCurrent,
}: {
  deckId: string
  activeVersionId: string | null
  refreshKey: number
  onPreview(version: Version): void
  onNameCurrent(): void
}) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    listVersionsFn({ data: { deckId } })
      .then((result) => {
        setVersions(result.versions)
        setCanEdit(result.canEdit)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the history'))
  }, [deckId])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const named = (versions ?? []).filter((v) => v.kind === 'named')
  const autos = (versions ?? []).filter((v) => v.kind === 'auto')
  const groups = groupByDay(autos)

  return (
    <div className="flex min-h-0 flex-col gap-3 text-[13px]" data-testid="history-panel">
      <div className="flex items-center gap-2">
        {canEdit && (
          <button type="button" onClick={onNameCurrent} className="rounded bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110">
            Name current version…
          </button>
        )}
        <button type="button" onClick={load} className="rounded px-2 py-1 text-[12px] text-ink-muted hover:bg-hover">
          Refresh
        </button>
      </div>
      {error && <p role="alert" className="text-[12px] text-red-700">{error}</p>}
      {versions === null && !error && <p className="text-[12px] text-ink-muted">Loading history…</p>}

      {versions && (
        <>
          <section aria-label="Named versions" className="flex flex-col gap-1">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Named versions</h3>
            {named.length === 0 && <p className="text-[12px] text-ink-muted">None yet. Name the current version to keep it.</p>}
            {named.map((v) => (
              <VersionRow key={v.id} version={v} active={activeVersionId === v.id} onPreview={onPreview} />
            ))}
          </section>

          <section aria-label="Automatic versions" className="flex flex-col gap-3">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Automatic</h3>
            {groups.length === 0 && <p className="text-[12px] text-ink-muted">Checkpoints appear two minutes after editing stops, or every ten minutes while you keep editing.</p>}
            {groups.map((group) => (
              <div key={group.label} className="flex flex-col gap-1">
                <div className="text-[12px] font-medium text-ink-muted">{group.label}</div>
                {group.items.map((v) => (
                  <VersionRow key={v.id} version={v} active={activeVersionId === v.id} onPreview={onPreview} />
                ))}
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}

function VersionRow({ version, active, onPreview }: { version: Version; active: boolean; onPreview(v: Version): void }) {
  const label = version.name ?? 'Automatic checkpoint'
  return (
    <button
      type="button"
      onClick={() => onPreview(version)}
      aria-current={active ? 'true' : undefined}
      data-testid="version-row"
      data-kind={version.kind}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${active ? 'bg-accent/10 ring-1 ring-accent' : 'hover:bg-hover'}`}
    >
      <span className="w-16 shrink-0 whitespace-nowrap text-[12px] tabular-nums text-ink-muted">{formatTime(version.createdAt)}</span>
      <span className={`min-w-0 flex-1 truncate ${version.kind === 'named' ? 'font-medium text-ink' : 'text-ink-muted'}`}>{label}</span>
      <span className="flex shrink-0 -space-x-1.5" aria-label={version.editors.map((e) => e.name).join(', ')}>
        {version.editors.slice(0, 3).map((e) => (
          <span key={e.id} title={e.name} className="grid size-5 place-items-center rounded-full border border-white bg-accent/20 text-[10px] font-semibold text-accent">
            {initials(e.name)}
          </span>
        ))}
      </span>
    </button>
  )
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase()
}

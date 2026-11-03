// The template gallery: Built-in, Mine and Shared on this server. Clicking a template makes a deck from it and opens it.
import { useEffect, useState } from 'react'
import { listTemplatesFn } from '~/lib/templates.functions'
import { TemplateCard, galleryTabOf, type TemplateItem } from './TemplateCard'
import { useStartFromTemplate } from './start-from-template'

export type GalleryTab = 'builtin' | 'mine' | 'shared'

const TABS: Array<[GalleryTab, string]> = [
  ['builtin', 'Built-in'],
  ['mine', 'Mine'],
  ['shared', 'Shared on this server'],
]

const EMPTY: Record<GalleryTab, string> = {
  builtin: 'No built-in templates.',
  mine: 'You have no templates yet. Open a deck and choose File ▸ Save as template…',
  shared: 'Nobody on this server has shared a template yet.',
}

export function TemplateGallery({ initialTab, onClose }: { initialTab: GalleryTab; onClose: () => void }) {
  const [tab, setTab] = useState<GalleryTab>(initialTab)
  const [items, setItems] = useState<TemplateItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { busyId, error: startError, start } = useStartFromTemplate()

  useEffect(() => {
    let live = true
    listTemplatesFn()
      .then((list) => live && setItems(list))
      .catch((err: unknown) => live && setLoadError(err instanceof Error ? err.message : 'The templates could not be loaded.'))
    return () => {
      live = false
    }
  }, [])

  const shown = (items ?? []).filter((t) => galleryTabOf(t) === tab)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Template gallery"
        data-testid="template-gallery"
        className="flex max-h-[85vh] w-[52rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg bg-white p-5 shadow-xl"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Template gallery</h2>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-ink-muted hover:bg-hover">
            Close
          </button>
        </div>
        <div role="tablist" aria-label="Template source" className="mt-3 flex gap-1 border-b border-rule">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`gallery-tab-${id}`}
              data-testid={`gallery-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="gallery-panel"
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${tab === id ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {startError && (
          <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-[13px] text-red-800">
            {startError}
          </p>
        )}
        <div role="tabpanel" id="gallery-panel" aria-labelledby={`gallery-tab-${tab}`} className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {loadError && <p role="alert" className="text-[13px] text-red-700">{loadError}</p>}
          {!loadError && items === null && <p className="text-[13px] text-ink-muted">Loading templates…</p>}
          {items !== null && shown.length === 0 && <p className="text-[13px] text-ink-muted">{EMPTY[tab]}</p>}
          {shown.length > 0 && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {shown.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  testId={`gallery-item-${t.id}`}
                  className="w-full"
                  disabled={busyId !== null}
                  onPick={(picked) => void start(picked.id)}
                />
              ))}
            </div>
          )}
          {busyId !== null && <p role="status" className="mt-3 text-[13px] text-ink-muted">Creating the deck…</p>}
        </div>
      </div>
    </div>
  )
}

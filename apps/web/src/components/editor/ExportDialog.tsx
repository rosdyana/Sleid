import { useState } from 'react'
import type { ExportFormat } from '@sleid/db/export-spec'
import type { Slide } from '@sleid/model'

export type DialogFormat = Extract<ExportFormat, 'pdf' | 'png' | 'jpg'>

const TITLE: Record<DialogFormat, string> = { pdf: 'Export PDF', png: 'Export PNG', jpg: 'Export JPG' }

/** Options for PDF (notes, hidden slides) and PNG/JPG (current slide or all, scale, hidden slides). */
export function ExportDialog({
  format,
  slides,
  currentSlideId,
  onStart,
  onClose,
}: {
  format: DialogFormat
  slides: Slide[]
  currentSlideId: string
  onStart: (format: DialogFormat, options: Record<string, unknown>, label: string) => void
  onClose: () => void
}) {
  const [includeNotes, setIncludeNotes] = useState(false)
  const [includeHidden, setIncludeHidden] = useState(false)
  const [scope, setScope] = useState<'all' | 'current'>('all')
  const [scale, setScale] = useState<0.5 | 1 | 2>(1)
  const hiddenCount = slides.filter((s) => s.hidden).length
  const visibleCount = slides.length - (includeHidden ? 0 : hiddenCount)

  function submit() {
    if (format === 'pdf') {
      onStart(format, { includeNotes, includeHidden }, `PDF (${visibleCount} slides)`)
      return
    }
    const slideId = scope === 'current' ? currentSlideId : undefined
    const count = slideId ? 1 : visibleCount
    onStart(format, { scale, includeHidden, ...(slideId ? { slideId } : {}) }, `${format.toUpperCase()} (${count} ${count === 1 ? 'image' : 'images'})`)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={TITLE[format]}
        className="w-[28rem] rounded-lg bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2 className="text-base font-medium">{TITLE[format]}</h2>
        <div className="mt-4 space-y-3 text-[13px]">
          {format === 'pdf' && (
            <>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
                Include speaker notes (one extra page after each slide that has notes)
              </label>
            </>
          )}
          {format !== 'pdf' && (
            <>
              <fieldset className="space-y-1">
                <legend className="mb-1 text-ink-muted">Slides</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
                  All slides (one file per slide, in a zip)
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="scope" checked={scope === 'current'} onChange={() => setScope('current')} />
                  Current slide only
                </label>
              </fieldset>
              <label className="flex items-center gap-2">
                Scale
                <select aria-label="Scale" value={scale} onChange={(e) => setScale(Number(e.target.value) as 0.5 | 1 | 2)} className="h-8 rounded border border-rule px-1">
                  <option value={0.5}>0.5× (960 × 540)</option>
                  <option value={1}>1× (1920 × 1080)</option>
                  <option value={2}>2× (3840 × 2160)</option>
                </select>
              </label>
            </>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={includeHidden} onChange={(e) => setIncludeHidden(e.target.checked)} />
            Include hidden slides ({hiddenCount} hidden)
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
            Cancel
          </button>
          <button type="submit" disabled={visibleCount === 0 && scope === 'all'} className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">
            Export
          </button>
        </div>
      </form>
    </div>
  )
}

// Left slide list. Numbered thumbnails drawn by the same SlideSurface as the
// canvas (scaled down, not iframes). Drag a thumbnail onto another to reorder
// it (one moveSlide op). Right-click opens the slide menu.
import { useState, type DragEvent } from 'react'
import { Plus } from 'lucide-react'
import type { Deck } from '@sleid/model'
import { CANVAS_W } from './commands.ts'
import type { PresencePeer } from './collab-session.ts'
import { SlideSurface } from './ElementView.tsx'

const THUMB_WIDTH = 168

export function thumbId(slideId: string) {
  return `thumb-${slideId}`
}

export function Filmstrip({
  deck,
  currentSlideId,
  readOnly,
  peers,
  commentCounts,
  onSelect,
  onMove,
  onNew,
  onContextMenu,
}: {
  deck: Deck
  currentSlideId: string
  readOnly: boolean
  peers: PresencePeer[]
  /** Open comment threads per slide id. A slide with none shows no badge. */
  commentCounts?: Record<string, number>
  onSelect: (slideId: string) => void
  onMove: (slideId: string, toIndex: number) => void
  onNew: () => void
  onContextMenu: (x: number, y: number, slideId: string) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<number | null>(null)
  const scale = THUMB_WIDTH / CANVAS_W

  function onDragStart(e: DragEvent, slideId: string) {
    setDragId(slideId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', slideId)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    if (readOnly) return
    const id = dragId ?? e.dataTransfer.getData('text/plain')
    const from = deck.slides.findIndex((s) => s.id === id)
    setDragId(null)
    setDropBefore(null)
    if (from < 0 || dropBefore === null) return
    // dropBefore is the index the slide should sit in front of. Removing the
    // dragged slide first shifts later positions down by one.
    const to = from < dropBefore ? dropBefore - 1 : dropBefore
    if (to !== from) onMove(id, to)
  }

  return (
    <aside
      aria-label="Slides"
      className="flex w-48 shrink-0 flex-col gap-3 overflow-y-auto border-r border-rule bg-[#f1f3f4] p-3"
      onDragOver={(e) => {
        if (dragId && !readOnly) e.preventDefault()
      }}
      onDrop={onDrop}
    >
      {deck.slides.map((slide, index) => {
        const current = slide.id === currentSlideId
        return (
          <div key={slide.id} className="flex gap-2">
            <span className="w-5 shrink-0 pt-1 text-right text-[11px] text-ink-muted">{index + 1}</span>
            <div
              id={thumbId(slide.id)}
              role="button"
              tabIndex={0}
              aria-label={`Slide ${index + 1}${slide.hidden ? ' (hidden)' : ''}`}
              aria-current={current ? 'true' : undefined}
              draggable={!readOnly}
              onDragStart={(e) => (readOnly ? e.preventDefault() : onDragStart(e, slide.id))}
              onDragEnd={() => {
                setDragId(null)
                setDropBefore(null)
              }}
              onDragOver={(e) => {
                if (!dragId || readOnly) return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                setDropBefore(e.clientY < rect.top + rect.height / 2 ? index : index + 1)
              }}
              onClick={() => onSelect(slide.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(slide.id)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                onSelect(slide.id)
                if (!readOnly) onContextMenu(e.clientX, e.clientY, slide.id)
              }}
              className={`relative cursor-pointer rounded-sm outline-none ${current ? 'ring-2 ring-accent' : 'hover:ring-1 hover:ring-rule'} ${
                slide.hidden ? 'opacity-50' : ''
              } ${dragId === slide.id ? 'opacity-40' : ''}`}
              style={{ width: THUMB_WIDTH }}
            >
              {dropBefore === index && dragId && <div className="absolute -top-1.5 left-0 right-0 h-0.5 bg-accent" />}
              {dropBefore === index + 1 && index === deck.slides.length - 1 && dragId && (
                <div className="absolute -bottom-1.5 left-0 right-0 h-0.5 bg-accent" />
              )}
              <div className="overflow-hidden rounded-sm border border-rule-soft bg-white shadow-sm">
                <div className="pointer-events-none">
                  <SlideSurface slide={slide} theme={deck.theme} scale={scale} />
                </div>
              </div>
              {commentCounts?.[slide.id] ? (
                <span
                  data-testid="slide-comment-count"
                  aria-label={`${commentCounts[slide.id]} open comments`}
                  className="pointer-events-none absolute left-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white"
                >
                  {commentCounts[slide.id]}
                </span>
              ) : null}
              {/* Collaborators currently on this slide */}
              <div className="pointer-events-none absolute right-1 top-1 flex -space-x-1">
                {peers
                  .filter((p) => p.slideId === slide.id)
                  .slice(0, 3)
                  .map((p) => (
                    <span
                      key={p.clientId}
                      title={`${p.name} is on this slide`}
                      data-testid="slide-presence-dot"
                      className="size-2.5 rounded-full ring-2 ring-white"
                      style={{ background: p.color }}
                    />
                  ))}
              </div>
            </div>
          </div>
        )
      })}
      {!readOnly && (
        <button
          type="button"
          onClick={onNew}
          className="ml-7 flex items-center gap-1 rounded px-2 py-1 text-[12px] text-ink-muted hover:bg-hover"
        >
          <Plus size={14} aria-hidden /> New slide
        </button>
      )}
    </aside>
  )
}

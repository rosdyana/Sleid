// Numbered pins on the canvas, one per thread on the current slide, at the thread's anchor. A pin takes its own
// pointer events, so pressing it does not start a selection drag.

export type { Pin } from './comment-view'
import type { Pin } from './comment-view'

export function CommentPins({ pins, scale, onPick }: { pins: Pin[]; scale: number; onPick(threadId: string): void }) {
  return (
    <>
      {pins.map((pin) => (
        <button
          key={pin.threadId}
          type="button"
          data-testid="comment-pin"
          data-thread-id={pin.threadId}
          aria-label={`Comment ${pin.number}${pin.resolved ? ' (resolved)' : ''}`}
          title={`Comment ${pin.number}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onPick(pin.threadId)
          }}
          className={`absolute z-[5000] grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white text-[12px] font-semibold text-white shadow ${
            pin.resolved ? 'bg-ink-muted' : 'bg-accent'
          } ${pin.active ? 'ring-2 ring-accent ring-offset-1' : ''}`}
          style={{ left: pin.x * scale, top: pin.y * scale }}
        >
          {pin.number}
        </button>
      ))}
    </>
  )
}

export { pinsFor } from './comment-view'

// Main slide canvas: stage scaling, selection, marquee, react-moveable gestures
// (drag, resize, rotate with snapping) and in-place text editing.
//
// Every gesture reports one geometry change when it ends (onGeometry), so a drag
// is one deck-op and one undo step, not one op per frame.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import Moveable, { type OnDrag, type OnDragEnd, type OnDragStart, type OnResize, type OnResizeEnd, type OnRotate, type OnRotateEnd } from 'react-moveable'
import type { Deck, Element, RichText, Slide, Theme } from '@sleid/model'
import { fontStack } from '@sleid/render'
import { CANVAS_H, CANVAS_W } from './commands.ts'
import type { PresencePeer } from './collab-session.ts'
import { SlideSurface } from './ElementView.tsx'
import { textBoxStyle } from './element-style.ts'
import { TextEditor } from './TextEditor.tsx'
import { CommentPins, type Pin } from './comments/CommentPins.tsx'

export type Geometry = { x: number; y: number; w: number; h: number; rotation: number }

export interface CanvasProps {
  slide: Slide
  theme: Theme
  /** The deck's brand reference (M9): the logo overlay is drawn on the slide. */
  brand?: Deck['brand']
  zoom: 'fit' | number
  selection: readonly string[]
  editingId: string | null
  showGuides: boolean
  /** Viewers and commenters: no move, resize, rotate or text editing. Selection still works. */
  readOnly: boolean
  /** Collaborators on this slide: their selections and cursors are drawn over the slide. */
  peers: PresencePeer[]
  onSelect: (ids: string[]) => void
  onGeometry: (id: string, next: Geometry) => void
  onStartEdit: (id: string) => void
  onCommitText: (id: string, content: RichText) => void
  /** Pointer position in slide coordinates, or null when it leaves the canvas. */
  onCursor: (point: { x: number; y: number } | null) => void
  /** Right-click on an element. The element is selected first. */
  onElementContextMenu?: (x: number, y: number, el: Element) => void
  /** Comment pins for this slide. */
  pins?: Pin[]
  onPinPick?: (threadId: string) => void
}

// 100% zoom shows the stage 1280 px wide.
const PERCENT_SCALE = 1280 / CANVAS_W / 100

export function SlideCanvas(props: CanvasProps) {
  const { slide, theme, brand, zoom, selection, editingId, showGuides, readOnly, peers, onSelect, onGeometry, onStartEdit, onCommitText, onCursor, onElementContextMenu, pins, onPinPick } = props
  const outerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState({ w: 900, h: 600 })
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const gestureStart = useRef<Element | null>(null)

  useEffect(() => {
    const outer = outerRef.current
    if (!outer) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(outer)
    return () => observer.disconnect()
  }, [])

  const scale =
    zoom === 'fit'
      ? Math.max(0.05, Math.min((available.w - 64) / CANVAS_W, (available.h - 64) / CANVAS_H))
      : zoom * PERCENT_SCALE

  const selected = selection.filter((id) => slide.elements.some((e) => e.id === id))
  const single = selected.length === 1 ? slide.elements.find((e) => e.id === selected[0]) : undefined
  const singleId = single?.id

  const [target, setTarget] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!singleId || editingId) {
      setTarget(null)
      return
    }
    setTarget(stageRef.current?.querySelector<HTMLElement>(`[data-el="${CSS.escape(singleId)}"]`) ?? null)
  }, [singleId, editingId, scale, slide])

  const otherNodes = (): HTMLElement[] =>
    stageRef.current
      ? Array.from(stageRef.current.querySelectorAll<HTMLElement>('[data-el]')).filter((n) => n !== target)
      : []

  function onStagePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('[data-el]') || editingId) return
    const rect = stageRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (!e.shiftKey) onSelect([])
    setMarquee({ x0: x, y0: y, x1: x, y1: y })
    stageRef.current?.setPointerCapture(e.pointerId)
  }

  function onStagePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = stageRef.current!.getBoundingClientRect()
    onCursor({ x: Math.round((e.clientX - rect.left) / scale), y: Math.round((e.clientY - rect.top) / scale) })
    if (!marquee) return
    setMarquee({ ...marquee, x1: e.clientX - rect.left, y1: e.clientY - rect.top })
  }

  function onStagePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!marquee) return
    stageRef.current?.releasePointerCapture(e.pointerId)
    const left = Math.min(marquee.x0, marquee.x1) / scale
    const right = Math.max(marquee.x0, marquee.x1) / scale
    const top = Math.min(marquee.y0, marquee.y1) / scale
    const bottom = Math.max(marquee.y0, marquee.y1) / scale
    setMarquee(null)
    if (right - left < 2 && bottom - top < 2) return
    const hits = slide.elements
      .filter((el) => el.x < right && el.x + el.w > left && el.y < bottom && el.y + el.h > top)
      .map((el) => el.id)
    onSelect(e.shiftKey ? [...new Set([...selection, ...hits])] : hits)
  }

  function onStageContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    if (!onElementContextMenu || editingId) return
    const node = (e.target as HTMLElement).closest<HTMLElement>('[data-el]')
    const el = node ? slide.elements.find((x) => x.id === node.dataset.el) : undefined
    if (!el) return
    e.preventDefault()
    if (!selection.includes(el.id)) onSelect([el.id])
    onElementContextMenu(e.clientX, e.clientY, el)
  }

  function onElementPointerDown(el: Element, e: ReactPointerEvent<HTMLDivElement>) {
    if (editingId === el.id) return
    e.stopPropagation()
    if (e.shiftKey) {
      onSelect(selection.includes(el.id) ? selection.filter((id) => id !== el.id) : [...selection, el.id])
    } else if (!selection.includes(el.id)) {
      onSelect([el.id])
    }
  }

  const onDragStart = (_e: OnDragStart) => {
    gestureStart.current = single ?? null
  }
  const onDrag = ({ target: node, transform }: OnDrag) => {
    node.style.transform = transform
  }
  const onDragEnd = ({ target: node, lastEvent }: OnDragEnd) => {
    const el = gestureStart.current
    gestureStart.current = null
    if (!el) return
    const [dx = 0, dy = 0] = lastEvent?.beforeTranslate ?? []
    node.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : ''
    const x = Math.round(el.x + dx / scale)
    const y = Math.round(el.y + dy / scale)
    if (x === el.x && y === el.y) return // a click, not a move: no op
    onGeometry(el.id, { x, y, w: el.w, h: el.h, rotation: el.rotation })
  }
  const onResize = ({ target: node, width, height, drag }: OnResize) => {
    node.style.width = `${width}px`
    node.style.height = `${height}px`
    node.style.transform = drag.transform
  }
  const onResizeEnd = ({ target: node, lastEvent }: OnResizeEnd) => {
    const el = gestureStart.current
    gestureStart.current = null
    if (!el || !lastEvent) return
    const [dx = 0, dy = 0] = lastEvent.drag.beforeTranslate
    node.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : ''
    const next = {
      x: Math.round(el.x + dx / scale),
      y: Math.round(el.y + dy / scale),
      w: Math.round(lastEvent.width / scale),
      h: Math.round(lastEvent.height / scale),
      rotation: el.rotation,
    }
    if (next.x === el.x && next.y === el.y && next.w === el.w && next.h === el.h) return
    onGeometry(el.id, next)
  }
  const onRotate = ({ target: node, transform }: OnRotate) => {
    node.style.transform = transform
  }
  const onRotateEnd = ({ target: node, lastEvent }: OnRotateEnd) => {
    const el = gestureStart.current
    gestureStart.current = null
    if (!el || !lastEvent) return
    const deg = Math.round(lastEvent.beforeRotate)
    node.style.transform = deg ? `rotate(${deg}deg)` : ''
    if (deg === el.rotation) return
    onGeometry(el.id, { x: el.x, y: el.y, w: el.w, h: el.h, rotation: deg })
  }

  const guideSnap = { top: true, left: true, bottom: true, right: true, center: true, middle: true }

  return (
    <div ref={outerRef} className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-canvas-gutter p-8">
      <div
        ref={stageRef}
        className="relative shrink-0 bg-white shadow-md"
        style={{ width: CANVAS_W * scale, height: CANVAS_H * scale }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerLeave={() => onCursor(null)}
        onContextMenu={onStageContextMenu}
        data-testid="slide-canvas"
      >
        <SlideSurface
          slide={slide}
          theme={theme}
          brand={brand}
          scale={scale}
          selectedIds={selected}
          editingId={editingId}
          showGuides={showGuides}
          onElementPointerDown={onElementPointerDown}
          onElementDoubleClick={(el) => {
            if (el.type === 'text' && !readOnly) onStartEdit(el.id)
          }}
          renderEditing={(el) =>
            el.type === 'text' ? (
              <TextEditor
                key={el.id}
                content={el.content}
                // The same text style as the drawn box (M10), so editing does not visibly jump.
                style={{ ...textBoxStyle(el, theme, scale), height: '100%' }}
                headingFont={fontStack(theme.fonts.heading, 'sans-serif')}
                onCommit={(content) => onCommitText(el.id, content)}
              />
            ) : null
          }
        />
        {marquee && (
          <div
            className="pointer-events-none absolute border border-accent bg-accent/10"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}
        <PresenceLayer slide={slide} scale={scale} peers={peers} />
        {pins && pins.length > 0 && onPinPick && <CommentPins pins={pins} scale={scale} onPick={onPinPick} />}
        {target && stageRef.current && !readOnly && (
          <Moveable
            target={target}
            container={stageRef.current}
            draggable
            resizable
            rotatable
            snappable
            origin={false}
            keepRatio={false}
            rotationPosition="top"
            throttleDrag={0}
            throttleResize={0}
            throttleRotate={0}
            snapThreshold={6}
            snapDirections={guideSnap}
            elementSnapDirections={guideSnap}
            verticalGuidelines={[0, (CANVAS_W / 2) * scale, CANVAS_W * scale]}
            horizontalGuidelines={[0, (CANVAS_H / 2) * scale, CANVAS_H * scale]}
            elementGuidelines={otherNodes()}
            onDragStart={onDragStart}
            onDrag={onDrag}
            onDragEnd={onDragEnd}
            onResizeStart={() => {
              gestureStart.current = single ?? null
            }}
            onResize={onResize}
            onResizeEnd={onResizeEnd}
            onRotateStart={() => {
              gestureStart.current = single ?? null
            }}
            onRotate={onRotate}
            onRotateEnd={onRotateEnd}
          />
        )}
      </div>
    </div>
  )
}

/** Remote selections (outlined in the collaborator's colour) and remote cursors on this slide. */
function PresenceLayer({ slide, scale, peers }: { slide: Slide; scale: number; peers: PresencePeer[] }) {
  const here = peers.filter((p) => p.slideId === slide.id)
  if (here.length === 0) return null
  return (
    <>
      {here.flatMap((peer) =>
        peer.selection
          .map((id) => slide.elements.find((el) => el.id === id))
          .filter((el): el is Element => el !== undefined)
          .map((el) => (
            <div
              key={`${peer.clientId}:${el.id}`}
              data-testid="remote-selection"
              className="pointer-events-none absolute"
              style={{
                left: el.x * scale - 3,
                top: el.y * scale - 3,
                width: el.w * scale + 6,
                height: el.h * scale + 6,
                border: `2px solid ${peer.color}`,
                borderRadius: 3,
                zIndex: 10000,
              }}
            >
              <span className="absolute -top-5 left-0 whitespace-nowrap rounded px-1 text-[11px] font-medium text-white" style={{ background: peer.color }}>
                {peer.name}
              </span>
            </div>
          )),
      )}
      {here
        .filter((p) => p.cursor)
        .map((peer) => (
          <div
            key={`cursor-${peer.clientId}`}
            data-testid="remote-cursor"
            className="pointer-events-none absolute"
            style={{ left: peer.cursor!.x * scale, top: peer.cursor!.y * scale, zIndex: 10001 }}
          >
            <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden className="block drop-shadow">
              <path d="M1 1 L1 16 L5 12 L8 19 L10.5 18 L7.5 11 L13 11 Z" fill={peer.color} stroke="white" strokeWidth="1" />
            </svg>
            <span className="ml-3 -mt-1 inline-block whitespace-nowrap rounded px-1 text-[11px] font-medium text-white" style={{ background: peer.color }}>
              {peer.name}
            </span>
          </div>
        ))}
    </>
  )
}

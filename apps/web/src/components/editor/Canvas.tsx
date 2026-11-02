// Main slide canvas: stage scaling, selection, marquee, react-moveable gestures
// (drag, resize, rotate with snapping) and in-place text editing.
//
// Every gesture reports one geometry change when it ends (onGeometry), so a drag
// is one deck-op and one undo step, not one op per frame.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import Moveable, { type OnDrag, type OnDragEnd, type OnDragStart, type OnResize, type OnResizeEnd, type OnRotate, type OnRotateEnd } from 'react-moveable'
import type { Element, RichText, Slide, Theme } from '@sleid/model'
import { CANVAS_H, CANVAS_W } from './commands.ts'
import { SlideSurface } from './ElementView.tsx'
import { TextEditor } from './TextEditor.tsx'

export type Geometry = { x: number; y: number; w: number; h: number; rotation: number }

export interface CanvasProps {
  slide: Slide
  theme: Theme
  zoom: 'fit' | number
  selection: readonly string[]
  editingId: string | null
  showGuides: boolean
  onSelect: (ids: string[]) => void
  onGeometry: (id: string, next: Geometry) => void
  onStartEdit: (id: string) => void
  onCommitText: (id: string, content: RichText) => void
}

// 100% zoom shows the stage 1280 px wide.
const PERCENT_SCALE = 1280 / CANVAS_W / 100

export function SlideCanvas(props: CanvasProps) {
  const { slide, theme, zoom, selection, editingId, showGuides, onSelect, onGeometry, onStartEdit, onCommitText } = props
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
    if (!marquee) return
    const rect = stageRef.current!.getBoundingClientRect()
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
        data-testid="slide-canvas"
      >
        <SlideSurface
          slide={slide}
          theme={theme}
          scale={scale}
          selectedIds={selected}
          editingId={editingId}
          showGuides={showGuides}
          onElementPointerDown={onElementPointerDown}
          onElementDoubleClick={(el) => {
            if (el.type === 'text') onStartEdit(el.id)
          }}
          renderEditing={(el) =>
            el.type === 'text' ? (
              <TextEditor
                key={el.id}
                content={el.content}
                style={{
                  fontFamily: el.style.fontFamily,
                  fontSize: (el.style.fontSize ?? theme.sizes.body) * scale,
                  color: el.style.color,
                  textAlign: el.style.align,
                  height: '100%',
                }}
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
        {target && stageRef.current && (
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

// Free space for a new element on a slide. Only non-empty elements are obstacles. An empty text box
// (a placeholder with no text) is not an obstacle: when the new element would cover one, the caller
// deletes that placeholder in the same batch (`placeholderIds`). Nothing else is ever deleted.
//
// Strategy (see docs/DESIGN.md, M4 live verification):
//   1. Below the lowest non-empty element, when the largest box of the aspect ratio that fits there
//      (centred, inside the 96 px safe area) is at least MIN_WIDTH x MIN_HEIGHT.
//   2. Otherwise the largest free box anywhere in the safe area, found from the candidate corners
//      (the safe area's corner and the edges of the obstacles plus a gap).
//   3. Otherwise null: the caller puts the element on a new slide.
import type { Element } from '@sleid/model'
import { plainText } from './context.ts'
import { CANVAS, SAFE_MARGIN, STACK_GAP } from './layout-guard.ts'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** The smallest box the assistant places on a slide. Anything smaller goes to a new slide. */
export const MIN_WIDTH = 640
export const MIN_HEIGHT = 360

/** Width over height of the elements the assistant creates: diagrams 1400 x 700, charts 1600 x 720. */
export const DIAGRAM_ASPECT = 1400 / 700
export const CHART_ASPECT = 1600 / 720

/** A text box with no text in it (an empty placeholder). Other elements are never empty in this sense. */
export function isEmptyTextBox(el: Element): boolean {
  return el.type === 'text' && plainText(el.content).trim() === ''
}

export function boxOf(el: { x: number; y: number; w: number; h: number }): Box {
  return { x: el.x, y: el.y, w: el.w, h: el.h }
}

/** Strict overlap: boxes that only touch do not overlap. */
export function overlapsBox(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export interface Placement {
  box: Box
  /** Empty text boxes under the box. The caller deletes them in the same batch. Never a non-empty element. */
  placeholderIds: string[]
}

/**
 * The free box for a new element with the given aspect ratio (width / height), or null when nothing of at least
 * MIN_WIDTH x MIN_HEIGHT fits. `elements` are the slide's current elements.
 */
export function findPlacement(elements: readonly Element[], aspect: number): Placement | null {
  const area: Box = { x: SAFE_MARGIN, y: SAFE_MARGIN, w: CANVAS.width - 2 * SAFE_MARGIN, h: CANVAS.height - 2 * SAFE_MARGIN }
  const right = area.x + area.w
  const bottom = area.y + area.h
  // Obstacles keep a gap on every side, so the new element never touches existing content.
  const solid = elements.filter((e) => !isEmptyTextBox(e)).map(boxOf)
  const obstacles = solid.map((o) => ({ x: o.x - STACK_GAP, y: o.y - STACK_GAP, w: o.w + 2 * STACK_GAP, h: o.h + 2 * STACK_GAP }))
  const minW = Math.max(MIN_WIDTH, MIN_HEIGHT * aspect)

  // The box for a width: the height follows the aspect ratio and is rounded up, so the box never shrinks below it.
  const boxFor = (x: number, y: number, w: number): Box => ({ x, y, w, h: Math.ceil(w / aspect) })
  const fits = (b: Box): boolean =>
    b.x >= area.x && b.y >= area.y && b.x + b.w <= right && b.y + b.h <= bottom && !obstacles.some((o) => overlapsBox(b, o))

  // The largest box with its top-left corner at (x, y). A smaller box at the same corner fits whenever a larger one
  // does, so a binary search finds the largest width.
  const largestAt = (x: number, y: number): Box | null => {
    const maxW = Math.floor(Math.min(right - x, (bottom - y) * aspect))
    if (maxW < minW || !fits(boxFor(x, y, minW))) return null
    if (fits(boxFor(x, y, maxW))) return boxFor(x, y, maxW)
    let lo = minW
    let hi = maxW
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (fits(boxFor(x, y, mid))) lo = mid
      else hi = mid
    }
    return boxFor(x, y, lo)
  }

  let chosen: Box | null = null

  // 1. Below the content, centred.
  const lowest = solid.length > 0 ? Math.max(...solid.map((o) => o.y + o.h)) : null
  const belowY = lowest === null ? area.y : lowest + STACK_GAP
  if (belowY + MIN_HEIGHT <= bottom) {
    const below = largestAt(area.x, belowY)
    if (below && below.w >= minW) {
      const centred = { ...below, x: area.x + Math.floor((area.w - below.w) / 2) }
      chosen = fits(centred) ? centred : below
    }
  }

  // 2. Anywhere else: the largest box from the candidate corners. Ties go to the higher, then the more left, box.
  if (!chosen) {
    const xs = [...new Set([area.x, ...solid.map((o) => o.x + o.w + STACK_GAP)])].filter((x) => x >= area.x && x <= right - minW)
    const ys = [...new Set([area.y, ...solid.map((o) => o.y + o.h + STACK_GAP)])].filter((y) => y >= area.y && y <= bottom - MIN_HEIGHT)
    for (const x of xs) {
      for (const y of ys) {
        const candidate = largestAt(x, y)
        if (!candidate) continue
        const area2 = candidate.w * candidate.h
        const best2 = chosen ? chosen.w * chosen.h : -1
        if (area2 > best2 || (area2 === best2 && chosen && (candidate.y < chosen.y || (candidate.y === chosen.y && candidate.x < chosen.x)))) {
          chosen = candidate
        }
      }
    }
  }

  if (!chosen) return null
  const target = chosen
  const placeholderIds = elements.filter((e) => isEmptyTextBox(e) && overlapsBox(target, boxOf(e))).map((e) => e.id)
  return { box: target, placeholderIds }
}

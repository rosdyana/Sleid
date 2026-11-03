// Post-processing for generated elements. Clamps every element into the stage's safe area
// (96 px margins on the 1920×1080 canvas) and resolves overlaps by stacking: an element that
// overlaps an earlier one moves below it. If the stack runs off the bottom, the element is shortened.
export const CANVAS = { width: 1920, height: 1080 } as const
export const SAFE_MARGIN = 96
export const STACK_GAP = 24
const MIN_HEIGHT = 40

export interface GuardBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface GuardOptions {
  width?: number
  height?: number
  margin?: number
  gap?: number
}

export interface GuardResult<T> {
  elements: T[]
  warnings: string[]
}

function overlaps(a: GuardBox, b: GuardBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Returns new boxes (inputs are not mutated). The order of `elements` is the stacking order:
 * earlier elements keep their place and later ones move.
 */
export function layoutGuard<T extends GuardBox>(elements: readonly T[], options: GuardOptions = {}): GuardResult<T> {
  const W = options.width ?? CANVAS.width
  const H = options.height ?? CANVAS.height
  const m = options.margin ?? SAFE_MARGIN
  const gap = options.gap ?? STACK_GAP
  const warnings: string[] = []
  const placed: T[] = []

  for (const [index, original] of elements.entries()) {
    const el = { ...original }
    const label = `element ${index + 1}`
    const maxW = W - 2 * m
    const maxH = H - 2 * m
    if (el.w > maxW) {
      warnings.push(`${label}: width reduced to fit the margins`)
      el.w = maxW
    }
    if (el.h > maxH) {
      warnings.push(`${label}: height reduced to fit the margins`)
      el.h = maxH
    }
    el.w = Math.max(1, el.w)
    el.h = Math.max(1, el.h)
    const clampedX = Math.min(Math.max(el.x, m), W - m - el.w)
    const clampedY = Math.min(Math.max(el.y, m), H - m - el.h)
    if (clampedX !== el.x || clampedY !== el.y) warnings.push(`${label}: moved inside the safe margins`)
    el.x = clampedX
    el.y = clampedY

    // Stack below any overlapping element. Each move can create a new overlap, so repeat.
    for (let guard = 0; guard < 50; guard++) {
      const hit = placed.filter((p) => overlaps(el, p))
      if (hit.length === 0) break
      const bottom = Math.max(...hit.map((p) => p.y + p.h)) + gap
      el.y = bottom
      if (el.y + el.h > H - m) {
        const room = H - m - el.y
        if (room >= MIN_HEIGHT) {
          el.h = room
          warnings.push(`${label}: shortened to fit below the elements above`)
        } else {
          el.y = H - m - el.h
          if (placed.some((p) => overlaps(el, p))) {
            el.h = Math.max(MIN_HEIGHT, el.h)
            warnings.push(`${label}: could not avoid an overlap on this slide`)
            break
          }
        }
      }
    }
    placed.push(el)
  }
  return { elements: placed, warnings }
}

/** True when no two boxes overlap and every box is inside the safe area. */
export function isLaidOut(elements: readonly GuardBox[], options: GuardOptions = {}): boolean {
  const W = options.width ?? CANVAS.width
  const H = options.height ?? CANVAS.height
  const m = options.margin ?? SAFE_MARGIN
  for (const el of elements) {
    if (el.x < m || el.y < m || el.x + el.w > W - m || el.y + el.h > H - m) return false
  }
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      if (overlaps(elements[i]!, elements[j]!)) return false
    }
  }
  return true
}

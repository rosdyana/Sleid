import { describe, expect, it } from 'vitest'
import { isLaidOut, layoutGuard, SAFE_MARGIN, type GuardBox } from './layout-guard.ts'

const box = (id: string, x: number, y: number, w: number, h: number): GuardBox => ({ id, x, y, w, h })

describe('layoutGuard', () => {
  it('clamps elements into the 96 px safe area', () => {
    const { elements, warnings } = layoutGuard([box('a', -50, 0, 400, 200), box('b', 1800, 1000, 300, 200)])
    for (const el of elements) {
      expect(el.x).toBeGreaterThanOrEqual(SAFE_MARGIN)
      expect(el.y).toBeGreaterThanOrEqual(SAFE_MARGIN)
      expect(el.x + el.w).toBeLessThanOrEqual(1920 - SAFE_MARGIN)
      expect(el.y + el.h).toBeLessThanOrEqual(1080 - SAFE_MARGIN)
    }
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('stacks overlapping elements so that nothing overlaps', () => {
    const input = [box('title', 120, 120, 1680, 160), box('body', 120, 120, 1680, 600), box('extra', 200, 300, 800, 300)]
    const { elements } = layoutGuard(input)
    expect(isLaidOut(elements)).toBe(true)
    expect(elements.map((e) => e.id)).toEqual(['title', 'body', 'extra'])
  })

  it('shortens the last element when the stack runs off the bottom', () => {
    const tall = [box('a', 96, 96, 1728, 500), box('b', 96, 96, 1728, 500), box('c', 96, 96, 1728, 500)]
    const { elements, warnings } = layoutGuard(tall)
    expect(elements.every((e) => e.y + e.h <= 1080 - SAFE_MARGIN)).toBe(true)
    expect(warnings.some((w) => w.includes('shortened'))).toBe(true)
  })

  it('does not mutate its input and is stable on a second pass', () => {
    const input = [box('a', 0, 0, 500, 300), box('b', 100, 100, 500, 300)]
    const snapshot = JSON.stringify(input)
    const once = layoutGuard(input).elements
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(layoutGuard(once).elements).toEqual(once)
  })
})

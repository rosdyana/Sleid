import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, resolveTokens } from '@sleid/model'
import { bodyTopAfter, regionBox } from './regions.ts'

const tokens = resolveTokens(BUILT_IN_THEMES.find((t) => t.name === 'Paper Navy')!)

describe('regionBox', () => {
  it('full sits inside the margins', () => {
    // Paper Navy sets no margin, so the token default (106, 82) applies.
    expect(regionBox('full', tokens)).toEqual({ x: 106, y: 82, w: 1920 - 212, h: 1080 - 164 })
  })

  it('body starts at 303 by default, or at bodyTop', () => {
    expect(regionBox('body', tokens).y).toBe(303)
    expect(regionBox('body', tokens, { bodyTop: 400 }).y).toBe(400)
  })

  it('left and right split the body with the gap between them', () => {
    const left = regionBox('left', tokens)
    const right = regionBox('right', tokens)
    expect(left.x + left.w + tokens.gap).toBeCloseTo(right.x, 6)
    expect(left.w).toBeCloseTo(right.w, 6)
  })

  it('top-half and bottom-half stack with the gap between them', () => {
    const top = regionBox('top-half', tokens)
    const bottom = regionBox('bottom-half', tokens)
    expect(top.y + top.h + tokens.gap).toBeCloseTo(bottom.y, 6)
    expect(bottom.y + bottom.h).toBeCloseTo(1080 - tokens.margin.y, 6)
  })

  it('center is the vertical middle 60% of the full region', () => {
    const c = regionBox('center', tokens)
    const full = regionBox('full', tokens)
    expect(c.h).toBeCloseTo(full.h * 0.6, 6)
    expect(c.y + c.h / 2).toBeCloseTo(full.y + full.h / 2, 6)
  })

  it('passes an explicit box through', () => {
    expect(regionBox({ x: 1, y: 2, w: 3, h: 4 }, tokens)).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })

  it('bodyTopAfter is 56px under the header, and never above 303', () => {
    expect(bodyTopAfter(240)).toBe(303)
    expect(bodyTopAfter(400)).toBe(456)
  })
})

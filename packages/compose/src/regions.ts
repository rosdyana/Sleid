// Named regions of a 1920 x 1080 slide, inside the theme margins. Components are placed in a region. A caller picks the
// region, the component lays itself out inside it and returns how far down it reached.
import type { ResolvedTokens } from '@sleid/model'

export const CANVAS_W = 1920
export const CANVAS_H = 1080
/** Top of the body under a header that sits at the top of the slide (the Kompast cards start here). */
export const BODY_TOP = 303
/** Space between the bottom of a header and the body under it. */
export const HEADER_GAP = 56

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type RegionName = 'full' | 'body' | 'left' | 'right' | 'top-half' | 'bottom-half' | 'center'

export interface RegionOptions {
  /** Top of the body. Default 303. */
  bodyTop?: number
}

/**
 * The box of a named region, or the box itself when an explicit box is given.
 * - full: inside the margins.
 * - body: from bodyTop (default 303) to the bottom margin, across the margins.
 * - left / right: the body split in two, with the gap between them.
 * - top-half / bottom-half: the full region split in two, with the gap between them.
 * - center: the full width, in the vertical middle 60% of the full region (for covers and dark asks).
 */
export function regionBox(region: RegionName | Box, tokens: Pick<ResolvedTokens, 'margin' | 'gap'>, opts: RegionOptions = {}): Box {
  if (typeof region !== 'string') return { ...region }
  const mx = tokens.margin.x
  const my = tokens.margin.y
  const gap = tokens.gap
  const full: Box = { x: mx, y: my, w: CANVAS_W - 2 * mx, h: CANVAS_H - 2 * my }
  const top = opts.bodyTop ?? BODY_TOP
  const body: Box = { x: mx, y: top, w: CANVAS_W - 2 * mx, h: CANVAS_H - my - top }
  switch (region) {
    case 'full':
      return full
    case 'body':
      return body
    case 'left':
      return { x: body.x, y: body.y, w: body.w / 2 - gap / 2, h: body.h }
    case 'right':
      return { x: body.x + body.w / 2 + gap / 2, y: body.y, w: body.w / 2 - gap / 2, h: body.h }
    case 'top-half': {
      const h = (full.h - gap) / 2
      return { x: full.x, y: full.y, w: full.w, h }
    }
    case 'bottom-half': {
      const h = (full.h - gap) / 2
      return { x: full.x, y: full.y + h + gap, w: full.w, h }
    }
    case 'center':
      return { x: full.x, y: full.y + full.h * 0.2, w: full.w, h: full.h * 0.6 }
  }
}

/** Where the body goes under a header that ends at `bottom`: 56px below it, and never above 303. */
export function bodyTopAfter(bottom: number, minTop = BODY_TOP): number {
  return Math.max(minTop, bottom + HEADER_GAP)
}

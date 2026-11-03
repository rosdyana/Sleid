// M10. A vector icon as an SVG picture for PowerPoint. The SVG is built from the same structured paths the
// renderer draws, so the two match. Nothing here is raw markup from the deck: every `d` passes the model's
// path grammar, and every paint goes through pptxColor, so the output has no attribute the deck can inject.
import { VECTOR_PATH_D_RE, type VectorElement } from '@sleid/model'
import { pptxColor } from './units.ts'

const LINE_CAPS = new Set(['butt', 'round', 'square'])
const LINE_JOINS = new Set(['miter', 'round', 'bevel'])

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

// A paint PowerPoint can read as a hex colour. Anything else (hsl, currentColor, transparent) becomes 'none'.
function paint(value: string): string {
  const hex = pptxColor(value)
  return hex ? `#${hex}` : 'none'
}

/** The SVG markup for a vector element, or undefined when no path survives the checks. */
export function vectorSvg(el: VectorElement): string | undefined {
  const paths = el.paths
    .filter((p) => VECTOR_PATH_D_RE.test(p.d))
    .map((p) => {
      const attrs = [
        `d="${p.d}"`,
        `fill="${paint(p.fill)}"`,
        `stroke="${paint(p.stroke)}"`,
        `stroke-width="${finite(p.strokeWidth, 0)}"`,
      ]
      if (p.lineCap && LINE_CAPS.has(p.lineCap)) attrs.push(`stroke-linecap="${p.lineCap}"`)
      if (p.lineJoin && LINE_JOINS.has(p.lineJoin)) attrs.push(`stroke-linejoin="${p.lineJoin}"`)
      if (p.opacity !== undefined) attrs.push(`opacity="${finite(p.opacity, 1)}"`)
      return `<path ${attrs.join(' ')}/>`
    })
  if (paths.length === 0) return undefined
  const vb = el.viewBox
  const viewBox = `${finite(vb.x, 0)} ${finite(vb.y, 0)} ${finite(vb.w, 1)} ${finite(vb.h, 1)}`
  const aspect = el.preserveAspectRatio ? 'xMidYMid meet' : 'none'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="${aspect}">${paths.join('')}</svg>`
}

/**
 * The SVG as the base64 image data pptxgenjs takes (no `data:` prefix, the same form as the other pictures).
 * Caveat: pptxgenjs writes a PNG fallback for an SVG picture. In Node it cannot draw that fallback, so it stores a
 * broken-image placeholder. PowerPoint 2016 and later and Microsoft 365 use the SVG itself and draw it correctly.
 */
export function vectorDataUri(el: VectorElement): string | undefined {
  const svg = vectorSvg(el)
  if (!svg) return undefined
  return `image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

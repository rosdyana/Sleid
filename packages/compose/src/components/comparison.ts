import { z } from 'zod'
import { type ComponentContext, type ComponentResult, Emitter, inkOn, measureText, oneLine, paletteFor, resolvedTokens, SCALE, size1, textStyleOf } from './common.ts'
import { doc, para } from '../rich.ts'

export const ComparisonPropsSchema = z.object({
  beforeLabel: z.string().max(80).optional(),
  afterLabel: z.string().max(80).optional(),
  rows: z.array(z.object({ before: z.string().min(1).max(300), after: z.string().min(1).max(300) })).min(1).max(8),
})
export type ComparisonProps = z.infer<typeof ComparisonPropsSchema>

const MARK = 26
const MARK_GAP = 16
const ROW_PAD = 22
/** Most extra height one row gets when the rows are spread over a tall region. */
const ROW_MAX_EXTRA = 60

/**
 * Two columns: before (a cross, muted text) and after (a tick, text), at body size (Kompast). Rows are separated by hairlines
 * and spread over the region height (up to ROW_MAX_EXTRA more per row). Row i animates with order animationStart + i.
 */
export function buildComparison(p: ComparisonProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'comparison', pal)
  const { x: rx, y: ry, w: rw, h: rh } = ctx.region
  const gap = tokens.gap
  const colW = (rw - gap) / 2
  const leftX = rx
  const rightX = rx + colW + gap
  const textSize = tokens.body.size
  const textW = colW - MARK - MARK_GAP
  const crossColor = inkOn(pal, pal.accent3, false, 3)
  const tickColor = inkOn(pal, pal.accent2, false, 3)
  const lineH = textSize * 1.4

  const build = (target: Emitter, extra: number): number => {
    let y = ry
    if (p.beforeLabel || p.afterLabel) {
      const labelSize = size1(tokens.small.size * 0.833)
      const labelStyle = (color: string) =>
        textStyleOf(ctx, { font: 'body', size: labelSize, weight: 650, color, lineHeight: 1.2, letterSpacing: 0.12, textTransform: 'uppercase', autoFit: 'grow-box' })
      let headerH = 0
      if (p.beforeLabel) headerH = Math.max(headerH, target.text('header.before', { x: leftX + MARK + MARK_GAP, y, w: textW, content: doc(para(oneLine(p.beforeLabel))), style: labelStyle(inkOn(pal, pal.muted)) }))
      if (p.afterLabel) headerH = Math.max(headerH, target.text('header.after', { x: rightX + MARK + MARK_GAP, y, w: textW, content: doc(para(oneLine(p.afterLabel))), style: labelStyle(inkOn(pal, pal.text)) }))
      y += headerH + 18
    }
    p.rows.forEach((row, i) => {
      const anim = target.orderFor(i)
      const beforeStyle = textStyleOf(ctx, { font: 'body', size: textSize, weight: 500, color: inkOn(pal, pal.muted), lineHeight: 1.4, autoFit: 'grow-box' })
      const afterStyle = textStyleOf(ctx, { font: 'body', size: textSize, weight: 500, color: inkOn(pal, pal.text), lineHeight: 1.4, autoFit: 'grow-box' })
      const beforeContent = doc(para(oneLine(row.before)))
      const afterContent = doc(para(oneLine(row.after)))
      const beforeH = measureText(target, { x: 0, y: 0, w: textW, content: beforeContent, style: beforeStyle })
      const afterH = measureText(target, { x: 0, y: 0, w: textW, content: afterContent, style: afterStyle })
      const rowH = Math.max(beforeH, afterH, lineH)
      const textY = y + ROW_PAD + extra / 2
      const markY = textY + 3
      target.icon(`row.${i}.cross`, 'x', { x: leftX, y: markY, size: MARK }, crossColor, anim)
      target.text(`row.${i}.before`, { x: leftX + MARK + MARK_GAP, y: textY, w: textW, content: beforeContent, style: beforeStyle, anim })
      target.icon(`row.${i}.tick`, 'check', { x: rightX, y: markY, size: MARK }, tickColor, anim)
      target.text(`row.${i}.after`, { x: rightX + MARK + MARK_GAP, y: textY, w: textW, content: afterContent, style: afterStyle, anim })
      const sepY = y + rowH + ROW_PAD * 2 + extra
      target.shape(`row.${i}.rule`, { x: rx, y: sepY, w: rw, h: 1.2, shape: 'rect', fill: pal.stroke }, anim)
      y = sepY + 1.2
    })
    return y
  }

  const natural = build(new Emitter(ctx, 'comparison', pal, true), 0) - ry
  const extra = p.rows.length > 0 ? Math.min(ROW_MAX_EXTRA, Math.max(0, (rh - natural) / p.rows.length)) : 0
  const bottom = build(em, extra)
  return {
    elements: em.out,
    box: { x: rx, y: ry, w: rw, h: bottom - ry },
    bottom,
  }
}

import { z } from 'zod'
import { type ComponentContext, type ComponentResult, Emitter, inkOn, oneLine, paletteFor, resolvedTokens, SCALE, size1, textStyleOf } from './common.ts'
import { doc, para } from '../rich.ts'

export const StatSchema = z.object({
  value: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  sub: z.string().max(300).optional(),
})
export const StatRowPropsSchema = z.object({
  stats: z.array(StatSchema).min(1).max(5),
})
export type StatRowProps = z.infer<typeof StatRowPropsSchema>

const PAD = 36
/**
 * A row of statistics in equal cards, one per column (the status-grid look of Kompast's status slide). Each card has the big
 * value (heading x 1.1), the label (body x 0.9) and the sub line (small). A card is as tall as its content, so no frame is
 * left empty. Stat i animates with order animationStart + i.
 */
export function buildStatRow(p: StatRowProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'stat_row', pal)
  const { x: rx, y: ry, w: rw, h: rh } = ctx.region
  const n = p.stats.length
  const gap = tokens.gap
  const colW = (rw - gap * (n - 1)) / n
  const contentW = colW - 2 * PAD

  const contentOf = (target: Emitter, stat: StatRowProps['stats'][number], i: number, x: number, y: number, h: number): number => {
    const anim = target.orderFor(i)
    target.shape(
      `stat.${i}.bg`,
      { x, y, w: colW, h, shape: 'roundRect', fill: pal.surface, stroke: pal.stroke, strokeWidth: tokens.card.strokeWidth, radius: tokens.card.radius, shadow: pal.shadow },
      anim,
    )
    let cy = y + PAD
    cy += target.text(`stat.${i}.value`, {
      x: x + PAD,
      y: cy,
      w: contentW,
      content: doc(para(oneLine(stat.value))),
      anim,
      style: textStyleOf(ctx, {
        font: 'heading',
        size: size1(tokens.heading.size * SCALE.statValue),
        weight: 700,
        color: inkOn(pal, pal.accent, true),
        lineHeight: 1,
        letterSpacing: tokens.heading.letterSpacing,
        autoFit: 'grow-box',
      }),
    })
    cy += 14
    cy += target.text(`stat.${i}.label`, {
      x: x + PAD,
      y: cy,
      w: contentW,
      content: doc(para(oneLine(stat.label))),
      role: 'body',
      anim,
      style: textStyleOf(ctx, { font: 'body', size: size1(tokens.body.size * 0.9), weight: 600, color: inkOn(pal, pal.text, true), lineHeight: 1.25, autoFit: 'grow-box' }),
    })
    if (stat.sub) {
      cy += 6
      cy += target.text(`stat.${i}.sub`, {
        x: x + PAD,
        y: cy,
        w: contentW,
        content: doc(para(oneLine(stat.sub))),
        anim,
        style: textStyleOf(ctx, { font: 'body', size: tokens.small.size, color: inkOn(pal, pal.muted, true), lineHeight: 1.4, autoFit: 'grow-box' }),
      })
    }
    return cy + PAD - y
  }

  const probe = new Emitter(ctx, 'stat_row', pal, true)
  const h = Math.max(...p.stats.map((stat, i) => contentOf(probe, stat, i, 0, 0, 0)))
  p.stats.forEach((stat, i) => contentOf(em, stat, i, rx + i * (colW + gap), ry, h))
  return {
    elements: em.out,
    box: { x: rx, y: ry, w: rw, h },
    bottom: ry + h,
  }
}

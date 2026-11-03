import { z } from 'zod'
import { type ComponentContext, type ComponentResult, Emitter, inkOn, oneLine, paletteFor, resolvedTokens, SCALE, size1, textStyleOf } from './common.ts'
import { doc, para } from '../rich.ts'

export const BulletItemSchema = z.object({
  text: z.string().min(1).max(400),
  sub: z.string().max(400).optional(),
  secondary: z.string().max(400).optional(),
})
export const BulletsPropsSchema = z.object({
  items: z.array(BulletItemSchema).min(1).max(10),
})
export type BulletsProps = z.infer<typeof BulletsPropsSchema>

const DOT = 14
const TEXT_INDENT = 36
/** Most extra space between two items when the list is spread over a tall region (Kompast: about 95 px per item). */
const GAP_MAX_EXTRA = 40

/**
 * A vertical list at Kompast's ratios: an accent dot, the main line (body x 1.05, line height 1.45), an optional secondary
 * line and an optional sub line (small, muted). Items are spread over the region height, up to GAP_MAX_EXTRA between two
 * items (at most GAP_MAX_EXTRA). Item i animates with order animationStart + i.
 */
export function buildBullets(p: BulletsProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'bullets_with_sublines', pal)
  const { x: rx, y: ry, w: rw, h: rh } = ctx.region
  const textX = rx + TEXT_INDENT
  const textW = rw - TEXT_INDENT
  const baseGap = tokens.gap * 0.75
  const mainSize = size1(tokens.body.size * SCALE.bulletMain)
  const mainLH = 1.45

  const build = (target: Emitter, extra: number): number => {
    let y = ry
    p.items.forEach((item, i) => {
      const anim = target.orderFor(i)
      target.shape(`item.${i}.dot`, { x: rx, y: y + (mainSize * mainLH) / 2 - DOT / 2, w: DOT, h: DOT, shape: 'ellipse', fill: pal.colors.accent }, anim)
      let cy = y
      cy += target.text(`item.${i}.text`, {
        x: textX,
        y: cy,
        w: textW,
        content: doc(para(oneLine(item.text))),
        role: 'body',
        anim,
        style: textStyleOf(ctx, { font: 'body', size: mainSize, weight: 500, color: inkOn(pal, pal.text), lineHeight: mainLH, autoFit: 'grow-box' }),
      })
      if (ctx.secondaryLanguage && item.secondary) {
        cy += 4
        cy += target.text(`item.${i}.secondary`, {
          x: textX,
          y: cy,
          w: textW,
          content: doc(para(oneLine(item.secondary))),
          anim,
          style: textStyleOf(ctx, {
            font: 'body',
            size: size1(tokens.small.size * SCALE.cardSecondary),
            weight: 500,
            color: inkOn(pal, pal.muted),
            lineHeight: 1.3,
            autoFit: 'grow-box',
          }),
        })
      }
      if (item.sub) {
        cy += 4
        cy += target.text(`item.${i}.sub`, {
          x: textX,
          y: cy,
          w: textW,
          content: doc(para(oneLine(item.sub))),
          anim,
          style: textStyleOf(ctx, { font: 'body', size: tokens.small.size, color: inkOn(pal, pal.muted), lineHeight: 1.4, autoFit: 'grow-box' }),
        })
      }
      y = Math.max(cy, y + mainSize * mainLH) + (i < p.items.length - 1 ? baseGap + extra : 0)
    })
    return y
  }

  const natural = build(new Emitter(ctx, 'bullets_with_sublines', pal, true), 0) - ry
  const slots = Math.max(1, p.items.length - 1)
  const extra = Math.min(GAP_MAX_EXTRA, Math.max(0, (rh - natural) / slots))
  const bottom = build(em, extra)
  return {
    elements: em.out,
    box: { x: rx, y: ry, w: rw, h: bottom - ry },
    bottom,
  }
}

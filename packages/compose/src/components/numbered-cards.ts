import { z } from 'zod'
import { type ComponentContext, type ComponentResult, Emitter, inkOn, measureText, oneLine, paletteFor, resolvedTokens, SCALE, size1, textStyleOf } from './common.ts'
import { doc, para } from '../rich.ts'

export const NumberedItemSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(600).optional(),
  secondary: z.string().max(400).optional(),
})
export const NumberedCardsPropsSchema = z.object({
  items: z.array(NumberedItemSchema).min(1).max(4),
})
export type NumberedCardsProps = z.infer<typeof NumberedCardsPropsSchema>

const PAD = 36
/** Kompast's numbered cards are 274 px tall. A taller region gives them up to this. */
export const NUMBERED_MAX_H = 300

/**
 * Cards with a large number (01, 02, ...) at the heading size in the accent colour, then the title, the body and the
 * secondary line, at Kompast's ratios. One column per item, filling the width; the row is as tall as the tallest card and
 * at least NUMBERED_MAX_H (or the region, when shorter). Card i animates with order animationStart + i.
 */
export function buildNumberedCards(p: NumberedCardsProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'numbered_cards', pal)
  const { x: rx, y: ry, w: rw, h: rh } = ctx.region
  const n = p.items.length
  const cols = n
  const gap = tokens.gap
  const cardW = (rw - gap * (cols - 1)) / cols
  const probe = new Emitter(ctx, 'numbered_cards', pal, true)

  const emitItem = (target: Emitter, item: NumberedCardsProps['items'][number], index: number, x: number, y: number, h: number): number => {
    const anim = target.orderFor(index)
    const contentW = cardW - 2 * PAD
    target.shape(
      `card.${index}.bg`,
      { x, y, w: cardW, h, shape: 'roundRect', fill: pal.surface, stroke: pal.stroke, strokeWidth: tokens.card.strokeWidth, radius: tokens.card.radius, shadow: pal.shadow },
      anim,
    )
    let cy = y + PAD
    cy += target.text(`card.${index}.number`, {
      x: x + PAD,
      y: cy,
      w: contentW,
      content: doc(para(String(index + 1).padStart(2, '0'))),
      anim,
      style: textStyleOf(ctx, { font: 'heading', size: tokens.heading.size, weight: 750, color: inkOn(pal, pal.accent, true), lineHeight: 1, autoFit: 'none' }),
    })
    cy += 22
    cy += target.text(`card.${index}.title`, {
      x: x + PAD,
      y: cy,
      w: contentW,
      content: doc(para(oneLine(item.title))),
      role: 'title',
      anim,
      style: textStyleOf(ctx, {
        font: 'body',
        size: size1(tokens.body.size * SCALE.cardTitle),
        weight: 650,
        color: inkOn(pal, pal.text, true),
        lineHeight: 1.25,
        letterSpacing: -0.01,
        autoFit: 'grow-box',
      }),
    })
    if (item.body) {
      cy += 10
      cy += target.text(`card.${index}.body`, {
        x: x + PAD,
        y: cy,
        w: contentW,
        content: doc(para(oneLine(item.body))),
        anim,
        style: textStyleOf(ctx, { font: 'body', size: size1(tokens.body.size * SCALE.numberedBody), color: inkOn(pal, pal.muted, true), lineHeight: 1.5, autoFit: 'grow-box' }),
      })
    }
    let natural = cy + PAD
    if (ctx.secondaryLanguage && item.secondary) {
      const sec = {
        x: x + PAD,
        w: contentW,
        content: doc(para(oneLine(item.secondary))),
        anim,
        style: textStyleOf(ctx, {
          font: 'body',
          size: size1(tokens.small.size * SCALE.cardSecondary),
          weight: 500,
          color: inkOn(pal, pal.muted, true),
          lineHeight: 1.3,
          autoFit: 'grow-box',
        }),
      }
      const secH = measureText(target, { ...sec, y: 0 })
      if (h > 0) {
        target.text(`card.${index}.secondary`, { ...sec, y: y + h - PAD - secH })
        return h
      }
      natural = cy + 6 + secH + PAD
    }
    return h > 0 ? h : natural
  }

  const rowH = Math.max(...p.items.map((item) => emitItem(probe, item, 0, 0, 0, 0)), Math.min(NUMBERED_MAX_H, rh))
  p.items.forEach((item, c) => {
    emitItem(em, item, c, rx + c * (cardW + gap), ry, rowH)
  })
  const bottom = ry + rowH
  return {
    elements: em.out,
    box: { x: rx, y: ry, w: rw, h: rowH },
    bottom,
  }
}

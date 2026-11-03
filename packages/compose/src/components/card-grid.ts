import { z } from 'zod'
import { type ComponentContext, type ComponentResult, Emitter, type Palette, inkOn, measureText, oneLine, paletteFor, resolvedTokens, SCALE, size1, tintColor, textStyleOf } from './common.ts'
import { tint } from '../color.ts'
import { doc, para } from '../rich.ts'

const TINTS = ['accent', 'accent2', 'accent3', 'accent4'] as const

export const CardSchema = z.object({
  icon: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(200),
  body: z.string().max(600).optional(),
  secondary: z.string().max(400).optional(),
  tint: z.enum(TINTS).optional(),
})
export type CardProps = z.infer<typeof CardSchema>

export const CardGridPropsSchema = z.object({
  cards: z.array(CardSchema).min(1).max(6),
  columns: z.number().int().min(1).max(6).optional(),
})
export type CardGridProps = z.infer<typeof CardGridPropsSchema>

const PAD = 36
const TILE = 62
const ICON = 34
/** A card is never taller than this. Kompast's single row is 391 px; a taller region gets cards up to this height. */
export const CARD_MAX_H = 460

/** Columns for n cards in a region this wide: n up to 3, 4 gives 4 when the region is 1400px or more (else 2), 5 and 6 give 3. */
export function autoColumns(n: number, regionW: number): number {
  if (n <= 3) return n
  if (n === 4) return regionW >= 1400 ? 4 : 2
  return 3
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * One card: the background, the icon tile, the title, the body under it, and the secondary line pinned to the bottom
 * (Kompast). In dry mode (h = 0) nothing is emitted and the natural height is returned, so the row can be sized.
 */
export function emitCard(em: Emitter, card: CardProps, index: number, x: number, y: number, w: number, h: number): number {
  const p: Palette = em.pal
  const tokens = resolvedTokens(em.ctx)
  const anim = em.orderFor(index)
  const ctx = em.ctx
  em.shape(
    `card.${index}.bg`,
    { x, y, w, h, shape: 'roundRect', fill: p.surface, stroke: p.stroke, strokeWidth: tokens.card.strokeWidth, radius: tokens.card.radius, shadow: p.shadow },
    anim,
  )
  let cy = y + PAD
  const contentW = w - 2 * PAD
  if (card.icon) {
    const color = tintColor(p, card.tint)
    const fill = tint(color, p.surface, tokens.tileTint)
    em.shape(`card.${index}.tile`, { x: x + PAD, y: cy, w: TILE, h: TILE, shape: 'roundRect', fill, radius: 17 }, anim)
    em.icon(`card.${index}.icon`, card.icon, { x: x + PAD + (TILE - ICON) / 2, y: cy + (TILE - ICON) / 2, size: ICON }, inkOn(p, color, true, 3), anim)
    cy += TILE + 22
  }
  cy += em.text(`card.${index}.title`, {
    x: x + PAD,
    y: cy,
    w: contentW,
    content: doc(para(oneLine(card.title))),
    role: 'title',
    anim,
    style: textStyleOf(ctx, {
      font: 'body',
      size: size1(tokens.body.size * SCALE.cardTitle),
      weight: 650,
      color: inkOn(p, p.text, true),
      lineHeight: 1.25,
      letterSpacing: -0.01,
      autoFit: 'grow-box',
    }),
  })
  if (card.body) {
    cy += 10
    cy += em.text(`card.${index}.body`, {
      x: x + PAD,
      y: cy,
      w: contentW,
      content: doc(para(oneLine(card.body))),
      anim,
      style: textStyleOf(ctx, { font: 'body', size: tokens.body.size, color: inkOn(p, p.muted, true), lineHeight: 1.5, autoFit: 'grow-box' }),
    })
  }
  let natural = cy + PAD
  if (ctx.secondaryLanguage && card.secondary) {
    const sec = {
      x: x + PAD,
      w: contentW,
      content: doc(para(oneLine(card.secondary))),
      anim,
      style: textStyleOf(ctx, {
        font: 'body',
        size: size1(tokens.small.size * SCALE.cardSecondary),
        weight: 500,
        color: inkOn(p, p.muted, true),
        lineHeight: 1.3,
        autoFit: 'grow-box',
      }),
    }
    const secH = measureText(em, { ...sec, y: 0 })
    if (h > 0) {
      em.text(`card.${index}.secondary`, { ...sec, y: y + h - PAD - secH })
      return h
    }
    natural = cy + 6 + secH + PAD
  }
  return h > 0 ? h : natural
}

/**
 * A grid of cards, row by row. Each row is as tall as its tallest card, and at least as tall as the region shares out to it
 * (up to CARD_MAX_H), so the cards fill the body. Rows are separated by tokens.gap. Card i animates with order animationStart + i.
 */
export function buildCardGrid(p: CardGridProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'card_grid', pal)
  const { x: rx, y: ry, w: rw, h: rh } = ctx.region
  const n = p.cards.length
  const cols = Math.min(p.columns ?? autoColumns(n, rw), n)
  const gap = tokens.gap
  const cardW = (rw - gap * (cols - 1)) / cols
  const probe = new Emitter(ctx, 'card_grid', pal, true)
  const rows = chunk(p.cards, cols)
  const share = (rh - gap * (rows.length - 1)) / rows.length

  let y = ry
  let index = 0
  for (const row of rows) {
    const natural = Math.max(...row.map((card) => emitCard(probe, card, 0, 0, 0, cardW, 0)))
    const rowH = Math.max(natural, Math.min(CARD_MAX_H, share))
    row.forEach((card, c) => {
      emitCard(em, card, index + c, rx + c * (cardW + gap), y, cardW, rowH)
    })
    index += row.length
    y += rowH + gap
  }
  const bottom = y - gap
  return {
    elements: em.out,
    box: { x: rx, y: ry, w: rw, h: bottom - ry },
    bottom,
  }
}

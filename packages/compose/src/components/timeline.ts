import { z } from 'zod'
import { readableTextOn } from '@sleid/model'
import { type ComponentContext, type ComponentResult, Emitter, inkOn, oneLine, paletteFor, resolvedTokens, SCALE, size1, textStyleOf } from './common.ts'
import { bullets, doc, para } from '../rich.ts'

export const TimelineStepSchema = z.object({
  title: z.string().min(1).max(200),
  /** The second-language line of the title, shown under it when the deck has a secondary language. */
  secondary: z.string().max(300).optional(),
  subtitle: z.string().max(300).optional(),
  bullets: z.array(z.string().min(1).max(300)).max(8).optional(),
  outcome: z.string().max(300).optional(),
})
export const TimelinePropsSchema = z.object({
  steps: z.array(TimelineStepSchema).min(2).max(6),
})
export type TimelineProps = z.infer<typeof TimelinePropsSchema>

/** Diameter of the numbered circles (Kompast: 65). */
export const CIRCLE = 64.8
/** The most the block is moved down to sit in the middle of a tall region. */
const CENTRE_MAX = 120

/**
 * A horizontal timeline at Kompast's ratios. Numbered circles (01, 02, ...) sit on a connecting line, one column per step.
 * Under each circle: the title, the secondary line, the subtitle, the bullets and the outcome (an arrow, in accent2). The
 * block is moved down to the middle of a tall region (up to CENTRE_MAX). Step i animates with order animationStart + i.
 */
export function buildTimeline(p: TimelineProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'timeline', pal)
  const { x: rx, y: ry, w: rw, h: rh } = ctx.region
  const n = p.steps.length
  const colW = rw / n
  const textW = colW - 40

  const build = (target: Emitter, cy: number): number => {
    target.shape('line', { x: rx + CIRCLE / 2, y: cy + CIRCLE / 2 - 1.8, w: (n - 1) * colW, h: 3.6, shape: 'rect', fill: pal.stroke })
    let bottom = cy + CIRCLE
    p.steps.forEach((step, i) => {
      const x = rx + i * colW
      const anim = target.orderFor(i)
      const circleFill = pal.colors.accent
      target.shape(`step.${i}.circle`, { x, y: cy, w: CIRCLE, h: CIRCLE, shape: 'ellipse', fill: circleFill }, anim)
      // The numeral's box is as tall as its text, so it is centred in the circle by offsetting it, not by valign.
      const numeral = {
        x,
        w: CIRCLE,
        content: doc(para(String(i + 1).padStart(2, '0'))),
        style: textStyleOf(ctx, {
          font: 'heading',
          size: size1(tokens.small.size * SCALE.timelineNumeral),
          weight: 750,
          color: readableTextOn(circleFill, '#ffffff'),
          lineHeight: 1,
          align: 'center',
          autoFit: 'none',
        }),
      }
      const numeralH = new Emitter(ctx, 'timeline', pal, true).text('number', { ...numeral, y: cy })
      target.text(`step.${i}.number`, { ...numeral, y: cy + (CIRCLE - numeralH) / 2, anim })
      let y = cy + CIRCLE + 26
      y += target.text(`step.${i}.title`, {
        x,
        y,
        w: textW,
        content: doc(para(oneLine(step.title))),
        role: 'title',
        anim,
        style: textStyleOf(ctx, {
          font: 'body',
          size: size1(tokens.body.size * SCALE.timelineTitle),
          weight: 650,
          color: inkOn(pal, pal.text, false),
          lineHeight: 1.25,
          letterSpacing: -0.01,
          autoFit: 'grow-box',
        }),
      })
      if (ctx.secondaryLanguage && step.secondary) {
        y += 4
        y += target.text(`step.${i}.secondary`, {
          x,
          y,
          w: textW,
          content: doc(para(oneLine(step.secondary))),
          anim,
          style: textStyleOf(ctx, {
            font: 'body',
            size: size1(tokens.small.size * SCALE.timelineSecondary),
            weight: 500,
            color: inkOn(pal, pal.muted),
            lineHeight: 1.4,
            autoFit: 'grow-box',
          }),
        })
      }
      if (step.subtitle) {
        y += 4
        y += target.text(`step.${i}.subtitle`, {
          x,
          y,
          w: textW,
          content: doc(para(oneLine(step.subtitle))),
          role: 'subtitle',
          anim,
          style: textStyleOf(ctx, {
            font: 'body',
            size: size1(tokens.small.size * SCALE.timelineSecondary),
            weight: 500,
            color: inkOn(pal, pal.muted),
            lineHeight: 1.4,
            autoFit: 'grow-box',
          }),
        })
      }
      if (step.bullets && step.bullets.length > 0) {
        y += 14
        y += target.text(`step.${i}.bullets`, {
          x,
          y,
          w: textW,
          content: doc(bullets(step.bullets.map((b) => oneLine(b)))),
          anim,
          style: textStyleOf(ctx, { font: 'body', size: tokens.small.size, color: inkOn(pal, pal.text), lineHeight: 1.45, autoFit: 'grow-box' }),
        })
      }
      if (step.outcome) {
        y += 14
        y += target.text(`step.${i}.outcome`, {
          x,
          y,
          w: textW,
          content: doc(para(`→ ${oneLine(step.outcome)}`)),
          anim,
          style: textStyleOf(ctx, {
            font: 'body',
            size: size1(tokens.small.size * SCALE.timelineOutcome),
            weight: 600,
            color: inkOn(pal, pal.accent2),
            lineHeight: 1.3,
            autoFit: 'grow-box',
          }),
        })
      }
      bottom = Math.max(bottom, y)
    })
    return bottom
  }

  const natural = build(new Emitter(ctx, 'timeline', pal, true), ry) - ry
  const offset = Math.min(CENTRE_MAX, Math.max(0, (rh - natural) / 2))
  const bottom = build(em, ry + offset)
  return {
    elements: em.out,
    box: { x: rx, y: ry + offset, w: rw, h: bottom - ry - offset },
    bottom,
  }
}

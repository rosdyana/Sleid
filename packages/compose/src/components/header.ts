import { z } from 'zod'
import { type ComponentContext, type ComponentResult, Emitter, paletteFor, resolvedTokens, SCALE, size1, textStyleOf, oneLine } from './common.ts'
import { doc, para } from '../rich.ts'

export const HEADER_SIZES = ['title', 'heading', 'ask'] as const

export const HeaderPropsSchema = z.object({
  label: z.string().max(120).optional(),
  heading: z.string().min(1).max(240),
  subtitle: z.string().max(400).optional(),
  secondary: z.string().max(400).optional(),
  /**
   * The heading's size: 'title' (the theme's title size, for covers), 'heading' (the theme's heading size) or 'ask' (a
   * larger heading for the closing slide). Default: 'title' in the centre region (a cover), otherwise 'heading'.
   */
  size: z.enum(HEADER_SIZES).optional(),
})
export type HeaderProps = z.infer<typeof HeaderPropsSchema>

/**
 * A slide header: an optional label, the heading and a subtitle, at the ratios in common.ts (SCALE). The subtitle sits 8px under
 * the measured heading. With secondaryLanguage set, `secondary` is the subtitle when there is no subtitle, and a smaller line
 * under the subtitle otherwise. Nothing in the header animates. The returned bottom is where the body starts from (see bodyTopAfter).
 */
export function buildHeader(p: HeaderProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'header', pal)
  const { x, y, w } = ctx.region
  const heading = oneLine(p.heading)
  const size = p.size ?? (ctx.regionName === 'center' ? 'title' : 'heading')

  const headingSize = size === 'title' ? ctx.theme.sizes.title : size === 'ask' ? size1(tokens.heading.size * SCALE.askHeading) : tokens.heading.size
  const headingWeight = size === 'heading' ? tokens.heading.weight : 750
  const headingLH = size === 'title' ? 1 : size === 'ask' ? 1.1 : tokens.heading.lineHeight
  const subtitleSize =
    size === 'title'
      ? size1(tokens.body.size * SCALE.coverSubtitle)
      : size === 'ask'
        ? size1(tokens.body.size * SCALE.askSubtitle)
        : (ctx.theme.components?.subtitle?.size ?? size1(tokens.body.size * SCALE.subtitle))

  let headingY = y
  if (p.label) {
    const label = tokens.label
    const h = em.text('label', {
      x,
      y,
      w,
      content: doc(para(oneLine(p.label))),
      style: textStyleOf(ctx, {
        font: 'body',
        size: label.size,
        weight: label.weight,
        color: pal.label,
        lineHeight: 1,
        letterSpacing: label.letterSpacing,
        textTransform: label.textTransform,
        autoFit: 'grow-box',
      }),
    })
    headingY = y + Math.max(h, label.size * 1.39) + 8
  }

  const headingH = em.text('heading', {
    x,
    y: headingY,
    w,
    content: doc(para(heading)),
    role: 'title',
    style: textStyleOf(ctx, {
      font: 'heading',
      size: headingSize,
      weight: headingWeight,
      color: pal.text,
      lineHeight: headingLH,
      letterSpacing: tokens.heading.letterSpacing,
      autoFit: 'shrink',
    }),
  })
  let bottom = headingY + headingH

  const secondaryOn = Boolean(ctx.secondaryLanguage && p.secondary)
  const subtitleStyle = {
    size: subtitleSize,
    weight: 500,
    color: pal.subtitle,
    lineHeight: 1.2,
    autoFit: 'grow-box' as const,
  }

  if (p.subtitle) {
    const h = em.text('subtitle', {
      x,
      y: bottom + 8,
      w,
      content: doc(para(oneLine(p.subtitle))),
      role: 'subtitle',
      style: textStyleOf(ctx, { font: 'body', ...subtitleStyle }),
    })
    bottom = bottom + 8 + h
    if (secondaryOn) {
      const sh = em.text('secondary', {
        x,
        y: bottom + 6,
        w,
        content: doc(para(oneLine(p.secondary!))),
        style: textStyleOf(ctx, {
          font: 'body',
          size: size1(tokens.small.size * 0.95),
          weight: 500,
          color: pal.muted,
          lineHeight: 1.3,
          autoFit: 'grow-box',
        }),
      })
      bottom = bottom + 6 + sh
    }
  } else if (secondaryOn) {
    const h = em.text('secondary', {
      x,
      y: bottom + 8,
      w,
      content: doc(para(oneLine(p.secondary!))),
      style: textStyleOf(ctx, { font: 'body', ...subtitleStyle }),
    })
    bottom = bottom + 8 + h
  }

  return {
    elements: em.out,
    box: { x, y, w, h: bottom - y },
    bottom,
  }
}

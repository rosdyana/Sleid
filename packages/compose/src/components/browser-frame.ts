import { z } from 'zod'
import { type ComponentContext, type ComponentResult, Emitter, altOr, inkOn, oneLine, paletteFor, resolvedTokens, textStyleOf } from './common.ts'
import { mixHex } from '@sleid/model'
import { measureRich } from '../measure.ts'
import { doc, para } from '../rich.ts'

export const BrowserFramePropsSchema = z.object({
  assetId: z.string().min(1).max(200).optional(),
  src: z.string().min(1),
  url: z.string().max(200).optional(),
  alt: z.string().min(1).max(400),
  caption: z.string().max(300).optional(),
})
export type BrowserFrameProps = z.infer<typeof BrowserFramePropsSchema>

/** Height of the frame's top bar. */
export const BAR_H = 44
const DOT = 12
const DOT_COLORS = ['#ff5f57', '#febc2e', '#28c840'] as const
const DEFAULT_RATIO = 1.6

/**
 * A browser window around a screenshot. The frame is fitted into the region: the screenshot keeps its aspect ratio (taken from
 * ctx.images, else 16:10) and the frame is centred horizontally at the top of the region. The caption, if any, sits under it.
 */
export function buildBrowserFrame(p: BrowserFrameProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'browser_frame', pal)
  const { x: rx, y: ry, w: rw, h: rh } = ctx.region
  const size = (p.assetId && ctx.images?.[p.assetId]) || ctx.images?.[p.src]
  const ratio = size && size.height > 0 ? size.width / size.height : DEFAULT_RATIO

  const captionH = p.caption ? Math.ceil(tokens.small.size * 1.3) + 18 : 0
  const availH = Math.max(rh - captionH, BAR_H + 1)
  let fw = rw
  let fh = fw / ratio + BAR_H
  if (fh > availH) {
    fh = availH
    fw = (fh - BAR_H) * ratio
  }
  const fx = rx + (rw - fw) / 2
  const fy = ry
  const radius = tokens.card.radius * 0.78
  const imageRadius = tokens.card.radius * 0.6
  const barFill = barColor(pal)
  const anim = em.orderFor(0)

  em.shape(
    'frame.bg',
    {
      x: fx,
      y: fy,
      w: fw,
      h: fh,
      shape: 'roundRect',
      fill: pal.surface,
      stroke: pal.stroke,
      strokeWidth: 1.2,
      radius,
      shadow: ctx.variant === 'light' ? { x: 0, y: 36, blur: 84, color: 'rgba(30,32,40,0.14)' } : { x: 0, y: 36, blur: 96, color: 'rgba(8,14,30,0.45)' },
    },
    anim,
  )
  // The image starts under the bar so that its rounded top corners are hidden by it.
  em.image(
    'frame.image',
    {
      x: fx,
      y: fy + BAR_H - imageRadius,
      w: fw,
      h: fh - BAR_H + imageRadius,
      src: p.src,
      fit: 'cover',
      alt: altOr(p.alt, 'Screenshot'),
      radius: imageRadius,
    },
    anim,
  )
  em.shape(
    'frame.bar',
    { x: fx, y: fy, w: fw, h: BAR_H, shape: 'roundRect', fill: barFill, radius },
    anim,
  )
  em.shape('frame.bar-square', { x: fx, y: fy + BAR_H - radius, w: fw, h: radius, shape: 'rect', fill: barFill }, anim)
  DOT_COLORS.forEach((color, i) => {
    em.shape(
      `frame.dot.${i}`,
      { x: fx + 18 + i * 20, y: fy + (BAR_H - DOT) / 2, w: DOT, h: DOT, shape: 'ellipse', fill: color },
      anim,
    )
  })

  // With no url the pill is drawn empty. A url is written on one line, inside the pill.
  const url = p.url ? oneLine(p.url) : ''
  const urlSize = Math.round(tokens.small.size * 0.62 * 10) / 10
  const urlStyle = textStyleOf(ctx, { font: 'body', size: urlSize, color: inkOn(pal, pal.muted, true), lineHeight: 1, autoFit: 'none' })
  const textW = url ? measureRich(doc(para(url)), urlStyle, 1e6).widest : 0
  const pillX = fx + 18 + DOT_COLORS.length * 20 + 22
  // The text box gets the measured width plus the 4% measuring margin, so the URL stays on one line.
  const roomW = Math.max(fw - (pillX - fx) - 14, 40)
  const pillW = url ? Math.min(textW * 1.06 + 26, roomW) : Math.min(260, roomW)
  const pillH = 26
  const pillY = fy + (BAR_H - pillH) / 2
  em.shape('frame.url-pill', { x: pillX, y: pillY, w: pillW, h: pillH, shape: 'roundRect', fill: pal.surface, radius: pillH / 2 }, anim)
  if (url) {
    em.text('frame.url', {
      x: pillX + 13,
      y: pillY,
      w: Math.max(pillW - 26, 1),
      content: doc(para(url)),
      anim,
      style: { ...urlStyle, valign: 'middle' },
    })
  }

  let bottom = fy + fh
  if (p.caption) {
    const h = em.text('frame.caption', {
      x: rx,
      y: fy + fh + 18,
      w: rw,
      content: doc(para(oneLine(p.caption))),
      style: textStyleOf(ctx, {
        font: 'body',
        size: tokens.small.size,
        color: inkOn(pal, pal.muted),
        lineHeight: 1.3,
        align: 'center',
        autoFit: 'grow-box',
      }),
    })
    bottom = fy + fh + 18 + h
  }
  return {
    elements: em.out,
    box: { x: fx, y: fy, w: fw, h: bottom - fy },
    bottom,
  }
}

/** The top bar: the surface mixed a little toward the text colour (an rgba surface gets a fixed light tint). */
function barColor(p: { surface: string; text: string }): string {
  try {
    return mixHex(p.surface, p.text, 0.06)
  } catch {
    return 'rgba(255,255,255,0.08)'
  }
}

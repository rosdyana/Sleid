import { z } from 'zod'
import { type ComponentContext, type ComponentResult, Emitter, altOr, inkOn, oneLine, paletteFor, resolvedTokens, textStyleOf } from './common.ts'
import { doc, para } from '../rich.ts'
import { CANVAS_H, CANVAS_W } from '../regions.ts'

const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number().min(0), h: z.number().min(0) })

export const FooterPropsSchema = z.object({
  logoSrc: z.string().min(1).optional(),
  logoSrcDark: z.string().min(1).optional(),
  footerText: z.string().max(300).optional(),
  pageNumber: z.number().int().min(0).optional(),
  logoBox: BoxSchema.optional(),
  footerBox: BoxSchema.optional(),
})
export type FooterProps = z.infer<typeof FooterPropsSchema>

/** The default logo box: top right, 106px from the right edge, 56px from the top. */
export const DEFAULT_LOGO_BOX = { x: CANVAS_W - 106 - 150, y: 56, w: 150, h: 44 }
/** Footer text baseline row: 56px above the bottom edge, 24px tall. */
const FOOTER_Y = CANVAS_H - 56 - 24
const FOOTER_X = 56

/**
 * The slide chrome: a logo at the top right (the dark logo on dark slides when given), footer text at the bottom left and a page
 * number at the bottom right. Nothing animates.
 */
export function buildFooter(p: FooterProps, ctx: ComponentContext): ComponentResult {
  const tokens = resolvedTokens(ctx)
  const pal = paletteFor(ctx)
  const em = new Emitter(ctx, 'footer_and_logo', pal)
  const logo = ctx.variant === 'dark' && p.logoSrcDark ? p.logoSrcDark : p.logoSrc
  if (logo) {
    const box = p.logoBox ?? DEFAULT_LOGO_BOX
    em.image('logo', { ...box, src: logo, fit: 'contain', alt: altOr(undefined, 'Logo') })
  }
  const small = Math.round(tokens.small.size * 0.6 * 10) / 10
  const style = (align: 'left' | 'right') =>
    textStyleOf(ctx, { font: 'body', size: small, color: inkOn(pal, pal.muted), lineHeight: 1.2, align, valign: 'middle', autoFit: 'none' })
  const footerBox = p.footerBox ?? { x: FOOTER_X, y: FOOTER_Y, w: 900, h: 24 }
  if (p.footerText) {
    em.text('footer', { x: footerBox.x, y: footerBox.y, w: footerBox.w, content: doc(para(oneLine(p.footerText))), style: style('left') })
  }
  if (p.pageNumber !== undefined) {
    em.text('page', { x: CANVAS_W - 56 - 160, y: FOOTER_Y, w: 160, content: doc(para(String(p.pageNumber))), style: style('right') })
  }
  return {
    elements: em.out,
    box: { x: footerBox.x, y: FOOTER_Y, w: CANVAS_W - 2 * 56, h: 24 },
    bottom: FOOTER_Y + 24,
  }
}

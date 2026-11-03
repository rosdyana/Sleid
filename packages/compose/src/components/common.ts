import {
  deriveDarkVariant,
  type ElementInput,
  type ResolvedTokens,
  resolveTokens,
  type RichText,
  type Shadow,
  type TextElement,
  type Theme,
} from '@sleid/model'
import { iconElement } from '../icons.ts'
import { fitText, textHeight } from '../measure.ts'
import { ink, opaqueStops } from '../color.ts'
import type { Box, RegionName } from '../regions.ts'

export type Variant = 'light' | 'dark'
export type TextStyle = TextElement['style']
export type ComponentKind =
  | 'header'
  | 'card_grid'
  | 'browser_frame'
  | 'timeline'
  | 'comparison'
  | 'numbered_cards'
  | 'bullets_with_sublines'
  | 'stat_row'
  | 'footer_and_logo'

/**
 * Type scale of the components, as ratios of the theme tokens. The tokens are what resolveTokens gives: heading H, body B,
 * small S (for Kompast: H 64.8, B 25.2, S 21.6, and the title size of the theme, T, 134.4). Measured on the Kompast reference
 * deck (fixture slides 0, 1, 5, 12, 13, 15, 17), so a component drawn in another theme keeps Kompast's proportions.
 *
 *   header title (cover)     T        (134.4, weight 750, line height 1)
 *   header subtitle          B × 1.286  (32.4; on a cover B × 1.7 = 43.2; on an ask B × 1.333 = 33.6)
 *   header heading (ask)     H × 1.222  (79.2, weight 750)
 *   card title               B × 1.333  (33.6, weight 650)
 *   card body                B          (25.2, line height 1.5)
 *   card secondary line      S × 0.944  (20.4, pinned to the card bottom)
 *   comparison row text      B          (25.2, line height 1.4)
 *   timeline title           B × 1.238  (31.2, weight 650); subtitle S × 0.944 (20.4); bullets S (21.6, line 1.45);
 *                            outcome S × 0.833 (18, weight 600); numeral S × 1.11 (24) in a 64.8 circle
 *   numbered card number     H          (64.8, weight 750); title B × 1.333; body B × 0.9 (22.7, line 1.5)
 *   bullets main line        B × 1.05   (26.4, line 1.45); sub line S
 *   stat value               H × 1.1    (71.3, weight 700); label B × 0.9
 *
 * Vertical layout follows the same measurements: a card's icon tile is 62 px with 22 px to the title, the secondary line
 * sits 36 px above the card bottom, and rows and cards fill the region height up to a cap (460 px for cards, 60 px extra for
 * a comparison row, 90 px between bullets, 300 px for numbered cards, 360 px for stat cards).
 */
export const SCALE = {
  cardTitle: 1.333,
  cardSecondary: 0.944,
  coverSubtitle: 1.7,
  subtitle: 1.286,
  askSubtitle: 1.333,
  askHeading: 1.222,
  timelineTitle: 1.238,
  timelineSecondary: 0.944,
  timelineOutcome: 0.833,
  timelineNumeral: 1.11,
  numberedBody: 0.9,
  bulletMain: 1.05,
  statValue: 1.1,
} as const

/** Rounds to one decimal place, the precision the measured sizes are given to. */
export function size1(n: number): number {
  return Math.round(n * 10) / 10
}

export interface ComponentContext {
  theme: Theme
  /** resolveTokens(theme). Filled in by buildComponent when omitted. */
  tokens?: ResolvedTokens
  variant: Variant
  secondaryLanguage?: string
  /** The named region the component is placed in, when it is placed by name (a header in 'center' is a cover). */
  regionName?: RegionName
  region: Box
  /** The component's instance id. Stored as component.instance on every element. */
  instance: string
  /** Stable element id for a part name, e.g. (part) => `${slideId}-${part}`. */
  idFor: (part: string) => string
  /** The first animation order this component uses. Items use animationStart + index (when tokens.motion.stagger). */
  animationStart: number
  /** Image sizes by asset id or src, for aspect ratios. Missing entries fall back to 16:10. */
  images?: Record<string, { width: number; height: number }>
  /** The z of the component's first element. Each element takes zBase + its position. Default 0. */
  zBase?: number
}

export interface ComponentResult {
  elements: ElementInput[]
  /** The box the component occupies. */
  box: Box
  /** The lowest y the component reaches. Callers place the next block below it. */
  bottom: number
}

/** The colours a component draws with, resolved for the slide's variant. */
export interface Palette {
  /** Colours of text on the slide background. */
  text: string
  muted: string
  accent: string
  label: string
  subtitle: string
  /** Card and panel fill, and their stroke and shadow. */
  surface: string
  stroke: string
  shadow: Shadow | undefined
  /** Slide background stops, for contrast checks. */
  base: string[]
  /** What text inside a card sits on: the surface when it is opaque, otherwise the slide background. */
  cardBase: string[]
  /** Theme accents: accent2, accent3, accent4 (for item tints). */
  accent2: string
  accent3: string
  accent4: string
  /** The accent colours that a tint may name. */
  colors: Record<'accent' | 'accent2' | 'accent3' | 'accent4', string>
}

const NAVY_BASE = '#1b2a47'

export function resolvedTokens(ctx: ComponentContext): ResolvedTokens {
  return ctx.tokens ?? resolveTokens(ctx.theme)
}

/** The colours for a variant. Dark uses the deriveDarkVariant colours and the surface and stroke of the dark variant. */
export function paletteFor(ctx: ComponentContext): Palette {
  const tokens = resolvedTokens(ctx)
  const c = ctx.theme.colors
  if (ctx.variant === 'dark') {
    const dv = deriveDarkVariant(ctx.theme)
    const base = dv.background.type === 'color' ? [dv.background.value] : bgStopsOf(dv.background.value)
    return {
      text: dv.text,
      muted: dv.muted,
      accent: dv.accent,
      label: dv.accent,
      subtitle: dv.muted,
      surface: dv.surface,
      stroke: dv.stroke,
      shadow: undefined,
      base,
      cardBase: base,
      accent2: c.accent2,
      accent3: c.accent3,
      accent4: c.accent4,
      colors: { accent: dv.accent, accent2: c.accent2, accent3: c.accent3, accent4: c.accent4 },
    }
  }
  return {
    text: c.text,
    muted: c.muted,
    accent: c.accent,
    label: tokens.label.color,
    subtitle: tokens.subtitle.color,
    surface: tokens.card.fill,
    stroke: tokens.card.stroke,
    shadow: tokens.card.shadow,
    base: [c.background],
    cardBase: [tokens.card.fill],
    accent2: c.accent2,
    accent3: c.accent3,
    accent4: c.accent4,
    colors: { accent: c.accent, accent2: c.accent2, accent3: c.accent3, accent4: c.accent4 },
  }
}

function bgStopsOf(value: string): string[] {
  const stops = opaqueStops(value)
  return stops.length > 0 ? stops : [NAVY_BASE]
}

/** Text or icon colour that reaches contrast on the slide background (default) or on the card surface (`onCard`). */
export function inkOn(p: Palette, color: string, onCard = false, min = 4.5): string {
  return ink(color, onCard ? p.cardBase : p.base, min)
}

export function fontFor(ctx: ComponentContext, role: 'heading' | 'body'): string {
  return role === 'heading' ? ctx.theme.fonts.heading : ctx.theme.fonts.body
}

/** Text with newlines and runs of spaces flattened to one line, as the rich-text paragraph helper does. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

export interface TextOpts {
  x: number
  y: number
  w: number
  content: RichText
  style: TextStyle
  role?: 'title' | 'subtitle' | 'body'
  /** Animation order, or undefined for none. */
  anim?: number
}

/** The part-named elements of one component, in z order. A dry emitter measures without producing elements. */
export class Emitter {
  readonly out: ElementInput[] = []

  constructor(
    readonly ctx: ComponentContext,
    readonly kind: ComponentKind,
    readonly pal: Palette,
    readonly dry = false,
  ) {}

  get tokens(): ResolvedTokens {
    return resolvedTokens(this.ctx)
  }

  /** The animation order of item `index`: animationStart + index when tokens.motion.stagger, else animationStart. */
  orderFor(index: number): number {
    return this.ctx.animationStart + (this.tokens.motion.stagger ? index : 0)
  }

  private add(part: string, anim: number | undefined, body: Record<string, unknown>): void {
    if (this.dry) return
    const el: Record<string, unknown> = {
      ...body,
      rotation: 0,
      locked: false,
      opacity: 1,
      id: this.ctx.idFor(part),
      z: (this.ctx.zBase ?? 0) + this.out.length,
      component: { kind: this.kind, instance: this.ctx.instance, part },
    }
    if (anim !== undefined) el.animation = { effect: this.tokens.motion.effect, order: anim }
    this.out.push(el as unknown as ElementInput)
  }

  /**
   * A text element. The box height is the measured height (rounded up), then autoFit is applied. Returns the box height.
   */
  text(part: string, o: TextOpts): number {
    const draft = {
      type: 'text',
      id: part,
      z: 0,
      x: o.x,
      y: o.y,
      w: o.w,
      h: 0,
      rotation: 0,
      locked: false,
      opacity: 1,
      content: o.content,
      style: o.style,
    } as TextElement
    draft.h = Math.max(1, Math.ceil(textHeight(draft)))
    const fitted = fitText(draft)
    this.add(part, o.anim, {
      type: 'text',
      x: o.x,
      y: o.y,
      w: o.w,
      h: fitted.h,
      content: fitted.content,
      style: fitted.style,
      ...(o.role ? { role: o.role } : {}),
    })
    return fitted.h
  }

  shape(
    part: string,
    o: {
      x: number
      y: number
      w: number
      h: number
      shape: 'rect' | 'roundRect' | 'ellipse'
      fill: string
      stroke?: string
      strokeWidth?: number
      radius?: number
      shadow?: Shadow
    },
    anim?: number,
  ): void {
    this.add(part, anim, {
      type: 'shape',
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      shape: o.shape,
      fill: o.fill,
      stroke: o.stroke ?? 'transparent',
      strokeWidth: o.strokeWidth ?? 0,
      ...(o.radius !== undefined ? { radius: o.radius } : {}),
      ...(o.shadow ? { shadow: o.shadow } : {}),
    })
  }

  icon(part: string, name: string, box: { x: number; y: number; size: number }, color: string, anim?: number): void {
    const el = iconElement(name, box, color, 2) as unknown as Record<string, unknown>
    this.add(part, anim, el)
  }

  image(
    part: string,
    o: { x: number; y: number; w: number; h: number; src: string; fit: 'cover' | 'contain'; alt: string; radius?: number },
    anim?: number,
  ): void {
    this.add(part, anim, {
      type: 'image',
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      src: o.src,
      fit: o.fit,
      alt: o.alt,
      ...(o.radius !== undefined ? { radius: o.radius } : {}),
    })
  }
}

/** The height a text box needs, measured without emitting it. Same options as Emitter.text. */
export function measureText(em: Emitter, o: TextOpts): number {
  return new Emitter(em.ctx, em.kind, em.pal, true).text('measure', o)
}

/** Alt text for a component image. A caller with no alt gets the generic one. */
export function altOr(alt: string | undefined, fallback: string): string {
  const trimmed = alt?.trim()
  return trimmed ? trimmed : fallback
}

export function textStyleOf(
  ctx: ComponentContext,
  o: {
    font: 'heading' | 'body'
    size: number
    weight?: number
    color: string
    lineHeight?: number
    letterSpacing?: number
    textTransform?: TextStyle['textTransform']
    align?: TextStyle['align']
    valign?: TextStyle['valign']
    autoFit: 'grow-box' | 'shrink' | 'none'
  },
): TextStyle {
  return {
    fontFamily: fontFor(ctx, o.font),
    fontSize: o.size,
    color: o.color,
    align: o.align ?? 'left',
    valign: o.valign ?? 'top',
    ...(o.lineHeight !== undefined ? { lineHeight: o.lineHeight } : {}),
    ...(o.weight !== undefined ? { fontWeight: o.weight } : {}),
    ...(o.letterSpacing !== undefined ? { letterSpacing: o.letterSpacing } : {}),
    ...(o.textTransform ? { textTransform: o.textTransform } : {}),
    autoFit: o.autoFit,
  }
}

/** Colours a tint name stands for: 'accent' (default), 'accent2', 'accent3' or 'accent4'. */
export function tintColor(p: Palette, name: string | undefined): string {
  switch (name) {
    case 'accent2':
      return p.colors.accent2
    case 'accent3':
      return p.colors.accent3
    case 'accent4':
      return p.colors.accent4
    default:
      return p.colors.accent
  }
}

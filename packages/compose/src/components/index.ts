import { z } from 'zod'
import { resolveTokens } from '@sleid/model'
import { type ComponentContext, type ComponentKind, type ComponentResult } from './common.ts'
import { BrowserFramePropsSchema, buildBrowserFrame } from './browser-frame.ts'
import { BulletsPropsSchema, buildBullets } from './bullets.ts'
import { buildComparison, ComparisonPropsSchema } from './comparison.ts'
import { buildCardGrid, CardGridPropsSchema } from './card-grid.ts'
import { buildFooter, FooterPropsSchema } from './footer.ts'
import { buildHeader, HeaderPropsSchema } from './header.ts'
import { buildNumberedCards, NumberedCardsPropsSchema } from './numbered-cards.ts'
import { buildStatRow, StatRowPropsSchema } from './stat-row.ts'
import { buildTimeline, TimelinePropsSchema } from './timeline.ts'

export type { ComponentContext, ComponentKind, ComponentResult, Palette, Variant } from './common.ts'
export { paletteFor, Emitter } from './common.ts'
export { buildHeader, HeaderPropsSchema, type HeaderProps } from './header.ts'
export { buildCardGrid, CardGridPropsSchema, CardSchema, autoColumns, type CardGridProps, type CardProps } from './card-grid.ts'
export { buildBrowserFrame, BrowserFramePropsSchema, type BrowserFrameProps, BAR_H } from './browser-frame.ts'
export { buildTimeline, TimelinePropsSchema, TimelineStepSchema, type TimelineProps, CIRCLE } from './timeline.ts'
export { buildComparison, ComparisonPropsSchema, type ComparisonProps } from './comparison.ts'
export { buildNumberedCards, NumberedCardsPropsSchema, NumberedItemSchema, type NumberedCardsProps } from './numbered-cards.ts'
export { buildBullets, BulletsPropsSchema, BulletItemSchema, type BulletsProps } from './bullets.ts'
export { buildStatRow, StatRowPropsSchema, StatSchema, type StatRowProps } from './stat-row.ts'
export { buildFooter, FooterPropsSchema, DEFAULT_LOGO_BOX, type FooterProps } from './footer.ts'

/** The component kinds, in the order the MCP layer lists them. */
export const COMPONENT_KINDS = [
  'header',
  'card_grid',
  'browser_frame',
  'timeline',
  'comparison',
  'numbered_cards',
  'bullets_with_sublines',
  'stat_row',
  'footer_and_logo',
] as const satisfies readonly ComponentKind[]

/** One zod schema per kind. The MCP layer validates props with these and prints the errors. */
export const ComponentPropsSchemas = {
  header: HeaderPropsSchema,
  card_grid: CardGridPropsSchema,
  browser_frame: BrowserFramePropsSchema,
  timeline: TimelinePropsSchema,
  comparison: ComparisonPropsSchema,
  numbered_cards: NumberedCardsPropsSchema,
  bullets_with_sublines: BulletsPropsSchema,
  stat_row: StatRowPropsSchema,
  footer_and_logo: FooterPropsSchema,
} satisfies Record<(typeof COMPONENT_KINDS)[number], z.ZodType>

export type ComponentPropsMap = { [K in keyof typeof ComponentPropsSchemas]: z.infer<(typeof ComponentPropsSchemas)[K]> }

/**
 * Builds a component. The props are validated with ComponentPropsSchemas (a ZodError when they are wrong). Tokens are
 * resolved from the theme when ctx.tokens is absent.
 */
export function buildComponent<K extends (typeof COMPONENT_KINDS)[number]>(kind: K, props: unknown, ctx: ComponentContext): ComponentResult {
  const full: ComponentContext = { ...ctx, tokens: ctx.tokens ?? resolveTokens(ctx.theme) }
  switch (kind) {
    case 'header':
      return buildHeader(ComponentPropsSchemas.header.parse(props), full)
    case 'card_grid':
      return buildCardGrid(ComponentPropsSchemas.card_grid.parse(props), full)
    case 'browser_frame':
      return buildBrowserFrame(ComponentPropsSchemas.browser_frame.parse(props), full)
    case 'timeline':
      return buildTimeline(ComponentPropsSchemas.timeline.parse(props), full)
    case 'comparison':
      return buildComparison(ComponentPropsSchemas.comparison.parse(props), full)
    case 'numbered_cards':
      return buildNumberedCards(ComponentPropsSchemas.numbered_cards.parse(props), full)
    case 'bullets_with_sublines':
      return buildBullets(ComponentPropsSchemas.bullets_with_sublines.parse(props), full)
    case 'stat_row':
      return buildStatRow(ComponentPropsSchemas.stat_row.parse(props), full)
    case 'footer_and_logo':
      return buildFooter(ComponentPropsSchemas.footer_and_logo.parse(props), full)
    default:
      throw new Error(`Unknown component kind "${String(kind)}"`)
  }
}

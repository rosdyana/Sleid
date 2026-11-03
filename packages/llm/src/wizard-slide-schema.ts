// The model's answer for one wizard slide. Charts take their numbers from a reference table, and only
// `illustrative` numbers may come from the model itself (and are then marked on the slide).
import { z } from 'zod'
import { CHART_TYPES } from '@sleid/model'
import { WIZARD_LAYOUTS } from './wizard-schema.ts'

export const SlideChartFromTable = z.object({
  title: z.string().trim().min(1).max(120),
  chartType: z.enum(CHART_TYPES),
  sourceId: z.string().min(1).max(60),
  tableIndex: z.number().int().min(0).max(4),
  /** Column names from that table. The first is the category axis. */
  categoryColumn: z.string().min(1).max(120),
  valueColumns: z.array(z.string().min(1).max(120)).min(1).max(4),
})

export const SlideChartIllustrative = z.object({
  title: z.string().trim().min(1).max(120),
  chartType: z.enum(CHART_TYPES),
  categories: z.array(z.string().max(60)).min(2).max(10),
  series: z.array(z.object({ name: z.string().max(60), values: z.array(z.number()).min(2).max(10) })).min(1).max(3),
})

export const SlideDiagram = z.object({
  title: z.string().trim().min(1).max(120),
  mermaid: z.string().min(1).max(6000),
})

export const WizardSlideOutput = z.object({
  layout: z.enum(WIZARD_LAYOUTS),
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(300).optional(),
  bullets: z.array(z.string().trim().min(1).max(300)).max(6),
  /** Speaker notes. Cite sources as [1], [2] (the numbers from the reference list). */
  notes: z.string().max(2000).default(''),
  chartFromTable: SlideChartFromTable.optional(),
  chartIllustrative: SlideChartIllustrative.optional(),
  diagram: SlideDiagram.optional(),
})
export type WizardSlideOutput = z.infer<typeof WizardSlideOutput>

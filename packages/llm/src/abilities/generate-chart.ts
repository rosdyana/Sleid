// generateChart: a new chart element, or an edit of an existing one (updateElement).
// The data always comes from the input (the selection or pasted data), never from the model.
// The model chooses the chart type and title. Without input data it may propose the data.
import { z } from 'zod'
import { CHART_TYPES, ChartDataSchema, type ChartData, type Element, type ChartElement } from '@sleid/model'
import { describeDeck } from '../context.ts'
import { LlmError } from '../errors.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, untrustedBlock, locateElement, slideOf, type AbilityEnv, type AbilityOutcome } from './common.ts'

const Cell = z.union([z.string().max(60), z.number(), z.null()])

export const GenerateChartInput = z.object({
  prompt: z.string().min(1).max(1000),
  /** Edit this chart instead of adding one. */
  elementId: z.string().min(1).optional(),
  /** Data from the user's selection or pasted in. Used as-is. */
  data: ChartDataSchema.optional(),
  /** Slide for a new chart. Default: the focus slide, or the first one. */
  slideId: z.string().min(1).optional(),
  chartType: z.enum(CHART_TYPES).optional(),
})
export type GenerateChartInput = z.infer<typeof GenerateChartInput>

const Output = z.object({
  chartType: z.enum(CHART_TYPES),
  title: z.string().min(1).max(120),
  legend: z.boolean(),
  columns: z.array(z.string().min(1).max(60)).min(2).max(8),
  rows: z.array(z.array(Cell)).min(1).max(40),
})

function numericCells(data: ChartData): ChartData {
  const rows = data.rows.map((row) =>
    row.map((cell, i) => {
      if (i === 0 || typeof cell !== 'string') return cell
      const n = Number(cell)
      return cell.trim() !== '' && Number.isFinite(n) ? n : cell
    }),
  )
  return { columns: data.columns, rows }
}

export async function generateChart(env: AbilityEnv, rawInput: GenerateChartInput): Promise<AbilityOutcome> {
  const input = GenerateChartInput.parse(rawInput)
  let existing: ChartElement | undefined
  let slideId = input.slideId ?? env.deck.slides[0]?.id ?? ''
  if (input.elementId) {
    const found = locateElement(env.deck, input.elementId)
    if (found.element.type !== 'chart') throw new LlmError('bad-request', 'Select a chart to change it.')
    existing = found.element
    slideId = found.slideId
  } else {
    slideOf(env.deck, slideId)
  }

  const sourceData: ChartData | undefined = input.data ?? existing?.data
  const dataNote = sourceData
    ? `The data is fixed by the user (${sourceData.columns.length} columns, ${sourceData.rows.length} rows). Keep the columns and rows exactly as they are. Choose the chart type and a title that fit them.`
    : 'No data was given. Propose columns and rows that fit the request, with realistic, clearly labelled example values.'
  const current = existing ? `The chart being changed is currently a ${existing.chartType} chart titled "${existing.options.title ?? ''}".` : ''

  const result = await structured(env.provider, Output, {
    system: systemPrompt(
      `Task: choose a chart for the request. Use bar for comparisons, line for trends over time, pie or donut only for shares of one whole (at most 6 parts), scatter for two numeric variables, area for cumulative trends, stacked-bar for parts of totals. ${dataNote}`,
    ),
    user: `${describeDeck(env.deck, { focusSlideId: slideId, selectionIds: input.elementId ? [input.elementId] : [], maxChars: 3000 }).text}\n\n${current}\nRequest:\n${untrustedBlock('request', input.prompt)}${
      sourceData ? `\n\nData:\n${untrustedBlock('data', [sourceData.columns.join(' | '), ...sourceData.rows.map((r) => r.map((c) => (c === null ? '' : String(c))).join(' | '))].join('\n'))}` : ''
    }`,
    maxTokens: 1500,
    temperature: 0.4,
    name: 'chart',
    ...(env.compact !== undefined ? { compact: env.compact } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
  })

  const chartType = input.chartType ?? result.value.chartType
  const data = numericCells(sourceData ?? { columns: result.value.columns, rows: result.value.rows })
  const title = result.value.title
  const options = { title, legend: result.value.legend }
  const id = crypto.randomUUID()
  const raw: unknown[] = existing
    ? [{ op: 'updateElement', slideId, elementId: existing.id, patch: { chartType, data, options } }]
    : [
        {
          op: 'addElement',
          slideId,
          element: {
            id,
            type: 'chart',
            chartType,
            data,
            options,
            x: 160,
            y: 260,
            w: 1600,
            h: 720,
            rotation: 0,
            locked: false,
            opacity: 1,
            alt: title,
          } satisfies Partial<Element>,
        },
      ]
  const ops = checkOps(env.deck, raw, allowlist('addElement', 'updateElement'), 'generateChart')
  return {
    ability: 'generateChart',
    summary: existing ? `Change chart to ${chartType}: "${title.slice(0, 60)}"` : `Add ${chartType} chart "${title.slice(0, 60)}"`,
    ops,
    warnings: sourceData ? [] : ['The chart data was proposed by the assistant. Check the numbers.'],
    usage: result.usage,
    model: result.model,
  }
}

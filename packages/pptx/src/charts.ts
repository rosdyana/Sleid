import type { ChartElement, Theme } from '@sleid/model'
import { pptxColor } from './units.ts'

type Cell = string | number | null

export interface ChartSeries {
  name: string
  labels?: string[]
  values?: number[]
}

/** pptxgenjs chart type names. Scatter uses the x values as the first series. */
export function pptxChartKind(chart: ChartElement): 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' {
  switch (chart.chartType) {
    case 'bar':
    case 'stacked-bar':
      return 'bar'
    case 'line':
      return 'line'
    case 'area':
      return 'area'
    case 'pie':
      return 'pie'
    case 'donut':
      return 'doughnut'
    case 'scatter':
      return 'scatter'
  }
}

function num(cell: Cell | undefined): number {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell
  const n = Number(cell)
  return Number.isFinite(n) ? n : 0
}

/** Palette: the chart's own colours when they are valid, otherwise the theme accents. */
export function chartPalette(chart: ChartElement, theme: Theme): string[] {
  const own = (chart.options.colors ?? []).map((c) => pptxColor(c)).filter((c): c is string => !!c)
  if (own.length > 0) return own
  return [theme.colors.accent, theme.colors.accent2, theme.colors.accent3, theme.colors.accent4]
    .map((c) => pptxColor(c))
    .filter((c): c is string => !!c)
}

/**
 * The data series for pptxgenjs addChart. Column 0 holds the categories (or x values for scatter).
 * Pie and donut use the first value column. Blank cells become 0.
 */
export function chartSeries(chart: ChartElement): ChartSeries[] {
  const { columns, rows } = chart.data
  const labels = rows.map((r) => String(r[0] ?? ''))
  const valueCols = columns.slice(1).map((name, i) => ({ name, index: i + 1 }))
  switch (pptxChartKind(chart)) {
    case 'pie':
    case 'doughnut': {
      const first = valueCols[0]
      return [{ name: first?.name ?? 'Value', labels, values: rows.map((r) => (first ? num(r[first.index]) : 0)) }]
    }
    case 'scatter':
      return [
        { name: columns[0] ?? 'X', values: rows.map((r) => num(r[0])) },
        ...valueCols.map((c) => ({ name: c.name, values: rows.map((r) => num(r[c.index])) })),
      ]
    default:
      return valueCols.map((c) => ({ name: c.name, labels, values: rows.map((r) => num(r[c.index])) }))
  }
}

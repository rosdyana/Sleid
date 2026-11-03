// Chart parts (c:chartSpace). The data grid comes from the cached values in the chart XML
// (c:cat, c:val, c:xVal, c:yVal), so the embedded workbook is never opened.
import type { ChartData, ChartOptions } from '@sleid/model'
import type { ParsedTheme } from './theme.ts'
import { colorIn } from './theme.ts'
import { attr, child, childrenNamed, descendants, firstDescendant, kids, local, numAttr, textOf, type XNode } from './xml.ts'

export type ChartType = 'bar' | 'stacked-bar' | 'line' | 'area' | 'pie' | 'donut' | 'scatter'

export interface ImportedChart {
  chartType: ChartType
  data: ChartData
  options: ChartOptions
  /** Set when the import changed something the user should know about. */
  warning?: string
}

export type ChartResult = { ok: true; chart: ImportedChart } | { ok: false; reason: string }

const SUPPORTED: Record<string, true> = { barChart: true, lineChart: true, areaChart: true, pieChart: true, doughnutChart: true, scatterChart: true }

/** Values by point index from a cache (c:strCache, c:numCache, ...). */
function points(node: XNode | undefined): Map<number, string> {
  const map = new Map<number, string>()
  for (const pt of descendants(node, 'pt')) {
    const idx = numAttr(pt, 'idx')
    if (idx === undefined) continue
    map.set(idx, textOf(child(pt, 'v')))
  }
  return map
}

function numericPoints(node: XNode | undefined): Map<number, number | null> {
  const map = new Map<number, number | null>()
  for (const [idx, raw] of points(node)) {
    const n = Number(raw)
    map.set(idx, raw.trim() !== '' && Number.isFinite(n) ? n : null)
  }
  return map
}

function countOf(maps: Array<Map<number, unknown>>): number {
  let n = 0
  for (const m of maps) for (const idx of m.keys()) n = Math.max(n, idx + 1)
  return n
}

function seriesName(ser: XNode, index: number): string {
  const name = textOf(firstDescendant(child(ser, 'tx'), 'v')).trim()
  return name || `Series ${index + 1}`
}

function seriesColor(ser: XNode, theme: ParsedTheme | undefined): string | undefined {
  return colorIn(child(child(ser, 'spPr'), 'solidFill'), theme)
}

export function parseChart(root: XNode, theme: ParsedTheme | undefined): ChartResult {
  const chartEl = child(root, 'chart') ?? firstDescendant(root, 'chart')
  const plot = child(chartEl, 'plotArea')
  if (!plot) return { ok: false, reason: 'the chart has no plot area' }
  const typeNode = kids(plot).find((k) => /Chart$/.test(local(k.name)))
  if (!typeNode) return { ok: false, reason: 'the chart type is not supported' }
  const kind = local(typeNode.name)
  if (!SUPPORTED[kind]) return { ok: false, reason: `the ${kind.replace(/Chart$/, '')} chart type is not supported` }

  let warning: string | undefined
  const grouping = attr(child(typeNode, 'grouping'), 'val') ?? 'clustered'
  let chartType: ChartType
  switch (kind) {
    case 'barChart': {
      const horizontal = attr(child(typeNode, 'barDir'), 'val') === 'bar'
      if (horizontal) warning = 'a horizontal bar chart was imported as a column chart'
      chartType = grouping === 'stacked' || grouping === 'percentStacked' ? 'stacked-bar' : 'bar'
      break
    }
    case 'lineChart':
      chartType = 'line'
      break
    case 'areaChart':
      chartType = 'area'
      break
    case 'pieChart':
      chartType = 'pie'
      break
    case 'doughnutChart':
      chartType = 'donut'
      break
    default:
      chartType = 'scatter'
  }

  const sers = childrenNamed(typeNode, 'ser')
  if (sers.length === 0) return { ok: false, reason: 'the chart has no series' }

  const options: ChartOptions = { legend: !!child(chartEl, 'legend') }
  const title = textOf(child(chartEl, 'title')).trim()
  if (title) options.title = title.slice(0, 200)
  const colors = sers.map((s) => seriesColor(s, theme))
  if (colors.every((c): c is string => !!c) && colors.length > 0) options.colors = colors

  let data: ChartData
  if (chartType === 'scatter') {
    const xs = sers.map((s) => numericPoints(child(s, 'xVal')))
    const ys = sers.map((s) => numericPoints(child(s, 'yVal')))
    const n = countOf([...xs, ...ys])
    const names = sers.map((s, i) => seriesName(s, i))
    const rows: ChartData['rows'] = []
    for (let i = 0; i < n; i++) rows.push([xs[0]?.get(i) ?? null, ...ys.map((y) => y.get(i) ?? null)])
    data = { columns: ['X', ...names], rows }
  } else if (chartType === 'pie' || chartType === 'donut') {
    const first = sers[0]!
    const labels = points(child(first, 'cat'))
    const values = numericPoints(child(first, 'val'))
    const n = countOf([labels, values])
    const rows: ChartData['rows'] = []
    for (let i = 0; i < n; i++) rows.push([labels.get(i) ?? String(i + 1), values.get(i) ?? null])
    data = { columns: ['Category', seriesName(first, 0)], rows }
    if (sers.length > 1) warning = warning ?? 'a pie chart with several series was imported with the first series only'
  } else {
    const labels = points(child(sers[0]!, 'cat'))
    const values = sers.map((s) => numericPoints(child(s, 'val')))
    const n = countOf([labels, ...values])
    const rows: ChartData['rows'] = []
    for (let i = 0; i < n; i++) rows.push([labels.get(i) ?? String(i + 1), ...values.map((v) => v.get(i) ?? null)])
    data = { columns: ['Category', ...sers.map((s, i) => seriesName(s, i))], rows }
  }

  if (data.rows.length === 0) return { ok: false, reason: 'the chart has no data in its cache' }
  // A chart whose rows were only partly cached still imports; the missing cells are blank.
  return { ok: true, chart: { chartType, data, options, ...(warning ? { warning } : {}) } }
}

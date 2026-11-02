// Chart elements to ECharts options, and SSR SVG strings for the slide HTML.
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import type { ChartElement, Theme } from '@sleid/model'
import { fontStack, safeColor } from './html.ts'

type Cell = string | number | null

export function paletteFor(chart: ChartElement, theme: Theme): string[] {
  const custom = chart.options.colors?.map((c) => safeColor(c, '')).filter(Boolean)
  if (custom && custom.length > 0) return custom
  return [theme.colors.accent, theme.colors.accent2, theme.colors.accent3, theme.colors.accent4]
}

// Column 0 is the category (or x for scatter). Every other column is a series.
// Pie and donut use the first value column only.
export function chartToEchartsOption(chart: ChartElement, theme: Theme): EChartsOption {
  const { columns, rows } = chart.data
  const valueColumns = columns.slice(1).map((name, i) => ({ name, index: i + 1 }))
  const palette = paletteFor(chart, theme)
  const text = safeColor(theme.colors.text, '#202124')
  const muted = safeColor(theme.colors.muted, '#5f6368')
  const stacked = chart.options.stacked === true || chart.chartType === 'stacked-bar'
  const bodyFont = fontStack(theme.fonts.body, 'sans-serif')

  // Sizes are slide-space pixels on the 1920×1080 stage; ECharts' 12px defaults are unreadable there.
  const small = theme.sizes.small
  const titleSize = Math.round(theme.sizes.heading * 0.6)
  const titleH = chart.options.title ? titleSize + 24 : 0
  const legendH = chart.options.legend ? small + 24 : 0
  const label = { color: muted, fontSize: small }

  const base: Record<string, unknown> = {
    animation: false,
    backgroundColor: 'transparent',
    color: palette,
    textStyle: { color: text, fontFamily: bodyFont, fontSize: small },
    title: chart.options.title
      ? { text: chart.options.title, left: 'center', top: 0, textStyle: { color: text, fontSize: titleSize } }
      : { show: false },
    legend: chart.options.legend
      ? { show: true, top: titleH, itemWidth: small * 1.2, itemHeight: small * 0.7, itemGap: small, textStyle: { color: text, fontSize: small } }
      : { show: false },
    // Leave room above the plot for the title and the legend.
    grid: { top: titleH + legendH + 16, left: 16, right: 24, bottom: 16, containLabel: true },
  }

  const isPie = chart.chartType === 'pie' || chart.chartType === 'donut'
  if (isPie) {
    const first = valueColumns[0]
    const data = rows.map((r) => ({ name: String(r[0] ?? ''), value: numberOrZero(first ? r[first.index] : 0) }))
    base.series = [
      {
        type: 'pie',
        radius: chart.chartType === 'donut' ? ['40%', '70%'] : '65%',
        center: ['50%', '55%'],
        data,
        label: { color: text, fontSize: small },
      },
    ]
    return applyOverride(base, chart.echartsOverride)
  }

  const yAxisStyle = { axisLabel: label, splitLine: { lineStyle: { color: muted, opacity: 0.25 } } }

  if (chart.chartType === 'scatter') {
    base.xAxis = { type: 'value', axisLabel: label, splitLine: { show: false } }
    base.yAxis = { type: 'value', ...yAxisStyle }
    base.series = valueColumns.map((col) => ({
      type: 'scatter',
      name: col.name,
      data: rows.map((r) => [numberOrZero(r[0]), r[col.index] ?? null]),
    }))
    return applyOverride(base, chart.echartsOverride)
  }

  const seriesType = chart.chartType === 'line' || chart.chartType === 'area' ? 'line' : 'bar'
  const isArea = chart.chartType === 'area'
  base.xAxis = { type: 'category', data: rows.map((r) => String(r[0] ?? '')), axisLabel: label }
  base.yAxis = { type: 'value', ...yAxisStyle }
  base.series = valueColumns.map((col) => {
    const series: Record<string, unknown> = {
      type: seriesType,
      name: col.name,
      data: rows.map((r) => (r[col.index] ?? null) as Cell),
    }
    if (stacked) series.stack = 'total'
    if (isArea) series.areaStyle = {}
    return series
  })
  return applyOverride(base, chart.echartsOverride)
}

function numberOrZero(cell: Cell | undefined): number {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell
  const n = Number(cell)
  return Number.isFinite(n) ? n : 0
}

// echartsOverride is merged last. Objects merge key by key, arrays replace.
function applyOverride(base: Record<string, unknown>, override: Record<string, unknown> | undefined): EChartsOption {
  if (!override) return base as EChartsOption
  return deepMerge(base, override) as EChartsOption
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const current = out[key]
    if (isObject(current) && isObject(value)) out[key] = deepMerge(current, value)
    else out[key] = value
  }
  return out
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Renders the chart on the server as an SVG string sized to the element.
export function renderChartSvg(chart: ChartElement, theme: Theme): string {
  const width = Math.max(1, Math.round(chart.w))
  const height = Math.max(1, Math.round(chart.h))
  const instance = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
  try {
    instance.setOption(chartToEchartsOption(chart, theme))
    // ECharts escapes its own text, but do not rely on it for user labels.
    return sanitizeSvg(instance.renderToSVGString())
  } finally {
    instance.dispose()
  }
}

// Drops script elements, event handler attributes and javascript: URLs from the SVG.
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '')
}


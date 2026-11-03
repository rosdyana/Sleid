import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, type ChartElement } from '@sleid/model'
import { chartToEchartsOption, fitTitle, renderChartSvg } from './chart.ts'

const LONG = 'Tagihan listrik sebelum dan sesudah solar rooftop untuk bakery kecil di Jakarta'

function chart(overrides: Partial<ChartElement> = {}): ChartElement {
  return {
    id: 'c1',
    type: 'chart',
    chartType: 'bar',
    data: {
      columns: ['Bulan', 'Sebelum', 'Sesudah'],
      rows: [
        ['Jan', 4200000, 2600000],
        ['Feb', 4100000, 2550000],
        ['Mar', 4350000, 2480000],
      ],
    },
    options: { title: LONG, legend: true },
    x: 920,
    y: 260,
    w: 1008,
    h: 700,
    rotation: 0,
    z: 0,
    locked: false,
    opacity: 1,
    ...overrides,
  } as ChartElement
}

/** The title's text lines in the SVG: ECharts writes each line as a bold <text>. */
function titleLines(svg: string): number {
  return (svg.match(/<text[^>]*font-weight:bold[^>]*>/g) ?? []).length
}

describe('chart titles', () => {
  it('wraps a long title to at most two lines inside the chart width, with ellipsis for the rest', () => {
    const fitted = fitTitle(LONG, 500, 43, 2)
    expect(fitted.lines).toBeLessThanOrEqual(2)
    expect(fitted.text.split('\n').length).toBe(fitted.lines)
    expect(fitted.text.endsWith('…')).toBe(true)
  })

  it('keeps a short title on one line', () => {
    expect(fitTitle('Tagihan bulanan', 900, 43, 2)).toEqual({ text: 'Tagihan bulanan', lines: 1 })
  })

  it('sets the ECharts title width to the chart width minus padding, with overflow break', () => {
    const option = chartToEchartsOption(chart(), DEFAULT_THEME) as { title: { width: number; textStyle: { width: number; overflow: string } } }
    expect(option.title.width).toBe(1008 - 48)
    expect(option.title.textStyle.width).toBe(1008 - 48)
    expect(option.title.textStyle.overflow).toBe('break')
  })

  it('grows the grid top for a wrapped title, and a short title takes less room', () => {
    const long = chartToEchartsOption(chart({ w: 420 }), DEFAULT_THEME) as { grid: { top: number } }
    const short = chartToEchartsOption(chart({ w: 420, options: { title: 'Bulanan', legend: true } }), DEFAULT_THEME) as { grid: { top: number } }
    expect(long.grid.top).toBeGreaterThan(short.grid.top)
  })

  it('a narrow chart with a long title renders at most two title lines in the SVG (no clipped line)', () => {
    const svg = renderChartSvg(chart({ w: 420, h: 480 }), DEFAULT_THEME)
    expect(titleLines(svg)).toBeGreaterThan(0)
    expect(titleLines(svg)).toBeLessThanOrEqual(2)
  })

  it('a chart without a title has no title element', () => {
    const option = chartToEchartsOption(chart({ options: { legend: false } }), DEFAULT_THEME) as { title: { show?: boolean } }
    expect(option.title.show).toBe(false)
  })
})

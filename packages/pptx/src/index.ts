// deck to PPTX. Built with pptxgenjs, then post-processed with JSZip for the parts pptxgenjs cannot write
// (hidden slides). Output is a 16:9 (13.333 x 7.5 in) presentation with native text, shapes, tables and charts.
import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import type { Deck, DiagramElement, Element, TableElement } from '@sleid/model'
import { chartPalette, chartSeries, pptxChartKind } from './charts.ts'
import { monospaceRuns, richTextRuns, type PptxRun } from './text.ts'
import { inches, pptxColor, pptxFontFace, points, transparencyFor } from './units.ts'

export { chartSeries, pptxChartKind, chartPalette } from './charts.ts'
export { richTextRuns, monospaceRuns } from './text.ts'
export { inches, points, pptxColor, pptxFontFace, transparencyFor } from './units.ts'

export interface PptxAsset {
  data: Uint8Array
  mime: string
}

export interface DeckToPptxOptions {
  /** Bytes for an image or background src (an asset URL or a data URL). Null leaves the picture out. */
  resolveAsset?: (src: string) => Promise<PptxAsset | null>
  /** A PNG of a rendered Mermaid diagram at the element's size. Null falls back to the source text. */
  rasterizeDiagram?: (element: DiagramElement) => Promise<PptxAsset | null>
}

function dataUri(asset: PptxAsset): string {
  return `${asset.mime};base64,${Buffer.from(asset.data).toString('base64')}`
}

function firstGradientColor(value: string | undefined): string | undefined {
  if (!value) return undefined
  const hex = /#[0-9a-fA-F]{3,6}\b/.exec(value)
  return hex ? pptxColor(hex[0]) : undefined
}

export async function deckToPptx(deck: Deck, options: DeckToPptxOptions = {}): Promise<Uint8Array> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = deck.title
  pptx.author = 'Sleid'
  pptx.company = 'Sleid'

  const theme = deck.theme
  const bodyFace = pptxFontFace(theme.fonts.body, 'Arial')
  const headingFace = pptxFontFace(theme.fonts.heading, bodyFace)
  const monoFace = pptxFontFace(theme.fonts.mono, 'Consolas')
  const textColor = pptxColor(theme.colors.text) ?? '202124'
  const mutedColor = pptxColor(theme.colors.muted) ?? '5F6368'
  const surfaceColor = pptxColor(theme.colors.surface) ?? 'F8F9FA'
  const hiddenIndexes: number[] = []

  for (const slide of deck.slides) {
    const s = pptx.addSlide()
    if (slide.hidden) hiddenIndexes.push(deck.slides.indexOf(slide))

    // Background: explicit slide colour, else the theme colour. Gradients use their first colour.
    const bg = slide.background
    const themeBg = theme.backgroundStyle === 'gradient' ? firstGradientColor(theme.backgroundValue) : undefined
    const fallbackBg = pptxColor(theme.colors.background) ?? 'FFFFFF'
    if (bg?.type === 'color') s.background = { color: pptxColor(bg.value) ?? fallbackBg }
    else if (bg?.type === 'gradient') s.background = { color: firstGradientColor(bg.value) ?? fallbackBg }
    else if (bg?.type === 'image' || theme.backgroundStyle === 'image') {
      const src = bg?.type === 'image' ? bg.value : (theme.backgroundValue ?? '')
      const asset = options.resolveAsset ? await options.resolveAsset(src) : null
      s.background = asset ? { data: dataUri(asset) } : { color: fallbackBg }
    } else s.background = { color: themeBg ?? fallbackBg }

    const ordered = [...slide.elements].sort((a, b) => a.z - b.z)
    for (const el of ordered) {
      await addElement(pptx, s, el, { bodyFace, headingFace, monoFace, textColor, mutedColor, surfaceColor, theme, options })
    }
    if (slide.notes) s.addNotes(slide.notes)
  }

  const out = (await pptx.write({ outputType: 'uint8array' })) as Uint8Array
  return postProcess(out, hiddenIndexes)
}

interface Ctx {
  bodyFace: string
  headingFace: string
  monoFace: string
  textColor: string
  mutedColor: string
  surfaceColor: string
  theme: Deck['theme']
  options: DeckToPptxOptions
}

/** The box a pptxgenjs call needs, from a canvas element. */
function box(el: Element) {
  return { x: inches(el.x), y: inches(el.y), w: inches(el.w), h: inches(el.h), rotate: el.rotation || undefined }
}

function shapeTransparency(el: Element): number | undefined {
  const t = transparencyFor(el.opacity)
  return t > 0 ? t : undefined
}

async function addElement(pptx: PptxGenJS, s: ReturnType<PptxGenJS['addSlide']>, el: Element, ctx: Ctx): Promise<void> {
  const transparency = shapeTransparency(el)
  switch (el.type) {
    case 'text': {
      const style = el.style
      const fontSize = typeof style.fontSize === 'number' ? style.fontSize : ctx.theme.sizes.body
      const runs = richTextRuns(el.content, {
        fontFace: pptxFontFace(style.fontFamily, el.role === 'title' ? ctx.headingFace : ctx.bodyFace),
        monoFace: ctx.monoFace,
        fontSize,
        color: pptxColor(style.color) ?? ctx.textColor,
        align: style.align,
      })
      s.addText(runs as never, {
        ...box(el),
        valign: style.valign,
        align: style.align === 'justify' ? 'left' : style.align,
        margin: 0,
        transparency,
        fit: 'none',
      })
      return
    }
    case 'shape': {
      const fill = pptxColor(el.fill)
      const line = pptxColor(el.stroke)
      const common = {
        ...box(el),
        fill: fill ? { color: fill, transparency } : { type: 'none' as const },
        line: line && el.strokeWidth > 0 ? { color: line, width: points(el.strokeWidth) } : { type: 'none' as const },
      }
      if (el.shape === 'line') {
        const y = inches(el.y + el.h / 2)
        s.addShape(pptx.ShapeType.line, {
          x: inches(el.x),
          y,
          w: inches(el.w),
          h: 0,
          line: { color: line ?? ctx.textColor, width: Math.max(points(el.strokeWidth), 1) },
          rotate: el.rotation || undefined,
        })
        return
      }
      const type = SHAPE_TYPE[el.shape]!(pptx)
      const text = el.text ? richTextRuns(el.text, { fontFace: ctx.bodyFace, monoFace: ctx.monoFace, fontSize: ctx.theme.sizes.body, color: ctx.textColor, align: 'center' }) : []
      if (text.length > 0) {
        s.addText(text as never, { ...common, shape: type as never, valign: 'middle', align: 'center', margin: 4 })
      } else {
        s.addShape(type, common)
      }
      return
    }
    case 'image': {
      const asset = ctx.options.resolveAsset && el.src ? await ctx.options.resolveAsset(el.src) : null
      if (!asset) return
      s.addImage({
        data: dataUri(asset),
        ...box(el),
        sizing: el.crop ? undefined : { type: el.fit === 'contain' ? 'contain' : 'cover', w: inches(el.w), h: inches(el.h) },
        transparency,
        altText: el.alt,
      })
      return
    }
    case 'chart': {
      const kind = pptxChartKind(el)
      const type = CHART_TYPE[kind]!(pptx)
      const colors = chartPalette(el, ctx.theme)
      const opts: Record<string, unknown> = {
        ...box(el),
        showLegend: el.options.legend,
        legendPos: 'b',
        showTitle: !!el.options.title,
        title: el.options.title,
        titleFontFace: ctx.headingFace,
        titleColor: ctx.textColor,
        chartColors: colors,
        catAxisLabelColor: ctx.mutedColor,
        valAxisLabelColor: ctx.mutedColor,
        legendColor: ctx.textColor,
        valGridLine: { color: 'D9D9D9', style: 'solid', size: 0.5 },
        catGridLine: { style: 'none' },
        showValue: false,
      }
      if (kind === 'bar') {
        opts.barDir = 'col'
        opts.barGrouping = el.chartType === 'stacked-bar' || el.options.stacked ? 'stacked' : 'clustered'
      }
      if (kind === 'doughnut') opts.holeSize = 50
      if (kind === 'line') {
        opts.lineSize = 2
        opts.lineDataSymbol = 'circle'
      }
      s.addChart(type as never, chartSeries(el) as never, opts as never)
      return
    }
    case 'diagram': {
      const png = ctx.options.rasterizeDiagram ? await ctx.options.rasterizeDiagram(el) : null
      if (png) {
        s.addImage({ data: dataUri(png), ...box(el), altText: 'Diagram' })
      } else {
        s.addText(monospaceRuns(el.source, { fontFace: ctx.bodyFace, monoFace: ctx.monoFace, fontSize: 28, color: ctx.textColor, align: 'left' }) as never, {
          ...box(el),
          fill: { color: ctx.surfaceColor },
          margin: 12,
          valign: 'top',
        })
      }
      return
    }
    case 'table':
      addTable(s, el, ctx)
      return
    case 'code':
      s.addText(monospaceRuns(el.code, { fontFace: ctx.bodyFace, monoFace: ctx.monoFace, fontSize: 28, color: ctx.textColor, align: 'left' }) as never, {
        ...box(el),
        fill: { color: ctx.surfaceColor },
        margin: 24,
        valign: 'top',
        transparency,
      })
      return
    case 'embed': {
      // Embeds are not fetched in the export. The slide gets a labelled link instead.
      const runs: PptxRun[] = [
        { text: 'Embedded page: ', options: { fontFace: ctx.bodyFace, fontSize: 28, color: ctx.mutedColor } },
        { text: el.url, options: { fontFace: ctx.bodyFace, fontSize: 28, color: pptxColor(ctx.theme.colors.accent) ?? '0B57D0', hyperlink: { url: el.url }, breakLine: true } },
      ]
      s.addText(runs as never, { ...box(el), fill: { color: ctx.surfaceColor }, margin: 16, valign: 'middle', align: 'center' })
      return
    }
  }
}

const SHAPE_TYPE: Record<string, (pptx: PptxGenJS) => PptxGenJS.ShapeType> = {
  rect: (p) => p.ShapeType.rect,
  roundRect: (p) => p.ShapeType.roundRect,
  ellipse: (p) => p.ShapeType.ellipse,
  triangle: (p) => p.ShapeType.triangle,
  arrow: (p) => p.ShapeType.rightArrow,
  line: (p) => p.ShapeType.line,
  star: (p) => p.ShapeType.star5,
}

const CHART_TYPE: Record<string, (pptx: PptxGenJS) => PptxGenJS.CHART_NAME> = {
  bar: (p) => p.ChartType.bar,
  line: (p) => p.ChartType.line,
  area: (p) => p.ChartType.area,
  pie: (p) => p.ChartType.pie,
  doughnut: (p) => p.ChartType.doughnut,
  scatter: (p) => p.ChartType.scatter,
}

function addTable(s: ReturnType<PptxGenJS['addSlide']>, el: TableElement, ctx: Ctx): void {
  const cols = Math.max(1, ...el.rows.map((r) => r.length))
  const headerFill = typeof el.style?.headerFill === 'string' ? pptxColor(el.style.headerFill) : undefined
  const border = typeof el.style?.borderColor === 'string' ? pptxColor(el.style.borderColor) : undefined
  const fontPx = typeof el.style?.fontSize === 'number' ? el.style.fontSize : ctx.theme.sizes.small
  const rows = el.rows.map((row, r) => {
    const isHeader = el.header && r === 0
    return Array.from({ length: cols }, (_, c) => ({
      text: row[c] ?? '',
      options: {
        bold: isHeader,
        fill: isHeader && headerFill ? { color: headerFill } : undefined,
        color: ctx.textColor,
        fontFace: ctx.bodyFace,
        fontSize: points(fontPx),
      },
    }))
  })
  const colW = Array.from({ length: cols }, () => inches(el.w) / cols)
  s.addTable(rows as never, {
    x: inches(el.x),
    y: inches(el.y),
    w: inches(el.w),
    colW,
    border: { type: 'solid', pt: 0.75, color: border ?? 'BDBDBD' },
    margin: 0.05,
  })
}

/**
 * Fixes two things pptxgenjs gets wrong, on each slide part:
 * - It repeats <a:pPr> inside a paragraph whenever a run inherits alignment. Only the first one is valid, so the rest go.
 * - It cannot write hidden slides. A hidden slide keeps its place and gets show="0" on <p:sld>.
 */
async function postProcess(pptxBytes: Uint8Array, hiddenIndexes: number[]): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(pptxBytes)
  const hidden = new Set(hiddenIndexes)
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue
    const number = Number(/slide(\d+)\.xml$/.exec(name)![1])
    let xml = keepFirstParagraphProps(await zip.file(name)!.async('string'))
    if (hidden.has(number - 1)) xml = xml.replace(/<p:sld(\s|>)/, (_m, tail: string) => `<p:sld show="0"${tail}`)
    zip.file(name, xml)
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export function keepFirstParagraphProps(xml: string): string {
  return xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_m, body: string) => {
    let seen = false
    const cleaned = body.replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (pPr: string) => {
      if (seen) return ''
      seen = true
      return pPr
    })
    return `<a:p>${cleaned}</a:p>`
  })
}

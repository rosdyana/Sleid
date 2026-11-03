import type { RichMark, RichNode, RichText } from '@sleid/model'
import { pptxColor, points } from './units.ts'

/** One pptxgenjs text run. `options.breakLine` ends the paragraph. */
export interface PptxRun {
  text: string
  options: Record<string, unknown>
}

export interface TextBase {
  fontFace: string
  monoFace: string
  /** Canvas px. */
  fontSize: number
  color: string
  align: 'left' | 'center' | 'right' | 'justify'
  /** M10. Every run bold. Set when the element's font weight is 600 or more (PowerPoint has no 600 or 700 run weights). */
  bold?: boolean
  /** M10. Letter spacing for every run, in points (pptxgenjs charSpacing). */
  charSpacing?: number
  /** M10. Applied to the text of every run when exporting (PowerPoint has no text-transform). */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
}

/**
 * M10. A CSS letter-spacing ("0.14em", "-0.02em", "1.5px") as points, at the font size in canvas px.
 * Other units return undefined and are left out.
 */
export function letterSpacingPoints(value: string | undefined, fontSizePx: number): number | undefined {
  if (value === undefined) return undefined
  const m = /^(-?\d+(?:\.\d+)?)(em|px)$/.exec(value.trim())
  if (!m) return undefined
  const px = m[2] === 'em' ? Number(m[1]) * fontSizePx : Number(m[1])
  return Number.isFinite(px) ? points(px) : undefined
}

/** M10. The text as the element's text-transform shows it. */
export function transformText(text: string, mode: TextBase['textTransform']): string {
  switch (mode) {
    case 'uppercase':
      return text.toUpperCase()
    case 'lowercase':
      return text.toLowerCase()
    case 'capitalize':
      return text.replace(/(^|\s)(\S)/g, (_m, space: string, ch: string) => space + ch.toUpperCase())
    default:
      return text
  }
}

// pptxgenjs writes a bullet glyph only for `characterCode` (bullets) or `type: 'number'` (numbered lists).
function bulletOption(kind: 'bullet' | 'number'): Record<string, unknown> {
  return kind === 'number' ? { type: 'number', indent: 18 } : { characterCode: '2022', indent: 18 }
}

const HEADING_SCALE: Record<number, number> = { 1: 1.6, 2: 1.35, 3: 1.15, 4: 1, 5: 1, 6: 1 }

function isNode(value: unknown): value is RichNode {
  return typeof value === 'object' && value !== null && 'type' in value
}

/**
 * Rich text to pptxgenjs runs. Paragraphs end with breakLine. Bullets and numbers become
 * paragraph bullets. Marks become run options. Links become hyperlinks.
 */
export function richTextRuns(doc: RichText | RichNode | null | undefined, base: TextBase): PptxRun[] {
  const runs: PptxRun[] = []
  if (!doc) return runs
  const paragraphs = (nodes: RichNode[], ctx: BlockCtx) => {
    for (const node of nodes) block(node, ctx)
  }
  type BlockCtx = { size: number; bullet?: 'bullet' | 'number'; indent: number; bold?: boolean; italic?: boolean; mono?: boolean }
  const block = (node: RichNode, ctx: BlockCtx): void => {
    const children = Array.isArray(node.content) ? node.content : []
    switch (node.type) {
      case 'paragraph':
        paragraph(children, ctx)
        return
      case 'heading': {
        const level = typeof node.attrs?.level === 'number' ? Math.min(Math.max(Math.round(node.attrs.level), 1), 6) : 1
        paragraph(children, { ...ctx, size: ctx.size * (HEADING_SCALE[level] ?? 1), bold: true })
        return
      }
      case 'bulletList':
      case 'orderedList':
        for (const item of children) {
          if (!isNode(item)) continue
          const itemChildren = Array.isArray(item.content) ? item.content : []
          for (const inner of itemChildren) {
            if (!isNode(inner)) continue
            if (inner.type === 'paragraph') {
              paragraph(Array.isArray(inner.content) ? inner.content : [], {
                ...ctx,
                bullet: node.type === 'orderedList' ? 'number' : 'bullet',
                indent: ctx.indent,
              })
            } else block(inner, { ...ctx, bullet: node.type === 'orderedList' ? 'number' : 'bullet' })
          }
        }
        return
      case 'blockquote':
        paragraphs(children.filter(isNode), { ...ctx, italic: true })
        return
      case 'codeBlock':
        paragraph(children, { ...ctx, mono: true })
        return
      case 'horizontalRule':
        return
      default:
        paragraph([node], ctx)
    }
  }

  const paragraph = (inline: unknown[], ctx: BlockCtx) => {
    const start = runs.length
    for (const child of inline) {
      if (!isNode(child)) continue
      inlineNode(child, ctx)
    }
    const produced = runs.length - start
    if (produced === 0) {
      runs.push({ text: ' ', options: { fontSize: points(ctx.size), fontFace: ctx.mono ? base.monoFace : base.fontFace, color: base.color } })
    }
    // The first run of the paragraph carries the paragraph options, the last run ends it.
    const first = runs[start]
    if (first) {
      first.options = { ...first.options, align: base.align, ...(ctx.bullet ? { bullet: bulletOption(ctx.bullet) } : {}) }
    }
    const last = runs[runs.length - 1]
    if (last) last.options = { ...last.options, breakLine: true }
  }

  const inlineNode = (node: RichNode, ctx: BlockCtx): void => {
    if (node.type === 'hardBreak') {
      const last = runs[runs.length - 1]
      if (last) last.options = { ...last.options, breakLine: true }
      return
    }
    if (typeof node.text === 'string') {
      runs.push({ text: transformText(node.text, base.textTransform), options: runOptions(node.marks ?? [], ctx) })
      return
    }
    for (const child of Array.isArray(node.content) ? node.content : []) {
      if (isNode(child)) inlineNode(child, ctx)
    }
  }

  const runOptions = (marks: RichMark[], ctx: BlockCtx): Record<string, unknown> => {
    const options: Record<string, unknown> = {
      fontFace: ctx.mono ? base.monoFace : base.fontFace,
      fontSize: points(ctx.size),
      color: base.color,
    }
    if (ctx.bold || base.bold) options.bold = true
    if (ctx.italic) options.italic = true
    if (base.charSpacing !== undefined) options.charSpacing = base.charSpacing
    for (const mark of marks) {
      switch (mark.type) {
        case 'bold':
          options.bold = true
          break
        case 'italic':
          options.italic = true
          break
        case 'underline':
          options.underline = { style: 'sng' }
          break
        case 'strike':
          options.strike = 'sngStrike'
          break
        case 'code':
          options.fontFace = base.monoFace
          break
        case 'link': {
          const href = mark.attrs.href
          if (/^https?:\/\/|^mailto:/i.test(href)) options.hyperlink = { url: href }
          break
        }
        case 'textStyle': {
          const color = pptxColor(mark.attrs.color ?? undefined)
          if (color) options.color = color
          const size = mark.attrs.fontSize
          let sizePx = ctx.size
          if (size) {
            const px = parseFloat(String(size))
            if (Number.isFinite(px) && px > 0) {
              options.fontSize = points(px)
              sizePx = px
            }
          }
          // M10. A weight of 600 or more is bold, as for the whole element.
          // The editor stores weights read from HTML as strings ("650"), so numeric strings count too.
          const weight = typeof mark.attrs.fontWeight === 'string' && /^\d{3}$/.test(mark.attrs.fontWeight) ? Number(mark.attrs.fontWeight) : mark.attrs.fontWeight
          if ((typeof weight === 'number' && weight >= 600) || weight === 'bold') options.bold = true
          const spacing = letterSpacingPoints(typeof mark.attrs.letterSpacing === 'string' ? mark.attrs.letterSpacing : undefined, sizePx)
          if (spacing !== undefined) options.charSpacing = spacing
          break
        }
      }
    }
    return options
  }

  const rootChildren = Array.isArray(doc.content) ? doc.content.filter(isNode) : []
  paragraphs(rootChildren, { size: base.fontSize, indent: 0 })
  return runs
}

/** Plain lines for monospace blocks: one paragraph per line. */
export function monospaceRuns(text: string, base: TextBase): PptxRun[] {
  const lines = text.split('\n')
  return lines.map((line) => ({
    text: line.length > 0 ? line : ' ',
    options: {
      fontFace: base.monoFace,
      fontSize: points(base.fontSize),
      color: base.color,
      align: 'left',
      breakLine: true,
    },
  }))
}

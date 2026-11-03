// Text measurement for the compose layer. Widths come from a table measured in Chrome (src/metrics.json), so a box
// sized here wraps the way the browser wraps it. The renderer (packages/render) is the reference for the rules below:
// - .sleid-text has no inner padding; its paragraphs have a 0.4em bottom margin;
// - a text run without a line-height uses 'normal', approximated here as 1.2;
// - rich-text headings take Reveal's fixed sizes (h1 28pt, h2 24pt, h3/h4 22pt) and line-height 1.15;
// - list items are indented by 1.2em.
import type { RichMark, RichNode, RichText, TextElement } from '@sleid/model'

type TextStyle = TextElement['style']
import metricsData from './metrics.json'

/** Size used when a text style has no fontSize. The renderer uses the theme body size; Paper Navy's is 34. */
export const DEFAULT_TEXT_SIZE = 34
/** Size of text inside a shape. Reveal sets the base font size to 20pt (about 26.67px) and the shape text inherits it. */
export const SHAPE_TEXT_SIZE = 26.67

/** Extra width the measurement allows, so that a line the browser fits is not reported as wrapping. */
const SAFETY = 1.015
const PARAGRAPH_GAP_EM = 0.4
const HEADING_GAP_EM = 0.3
const LIST_INDENT_EM = 1.2
const HEADING_LINE_HEIGHT = 1.15
const DEFAULT_LINE_HEIGHT = 1.2
/** h1..h4 under Reveal's `font-size: 28pt/24pt/22pt !important`. h5 and h6 are the UA's 0.83em and 0.67em. */
const HEADING_PX = [28 * (4 / 3), 24 * (4 / 3), 22 * (4 / 3), 22 * (4 / 3)]

export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize'
export type FontClass = 'sans' | 'serif' | 'mono'
/**
 * A width table. Named tables were measured in Chrome for one family each; 'sans', 'serif' and 'mono' are the widest
 * of several families and are used when the stack names no family we measured (for example Inter, which may be a web font).
 */
export type FontTable = FontClass | 'system' | 'arial' | 'helvetica' | 'georgia' | 'times' | 'menlo' | 'courier'

const FAMILY_TABLES: Array<[RegExp, FontTable]> = [
  [/^(ui-sans-serif|-apple-system|system-ui|blinkmacsystemfont|segoe ui( variable( text| display)?)?|sf pro( text| display)?)$/, 'system'],
  [/^(arial|liberation sans|arimo)$/, 'arial'],
  [/^(helvetica( neue)?)$/, 'helvetica'],
  [/^inter$/, 'sans'],
  [/^georgia$/, 'georgia'],
  [/^(times( new roman)?|liberation serif|tinos|ui-serif|serif)$/, 'times'],
  [/^(menlo|sf mono|ui-monospace|monaco)$/, 'menlo'],
  [/^(courier( new)?|liberation mono|cousine|monospace)$/, 'courier'],
  [/^sans-serif$/, 'arial'],
]

/**
 * The table for a CSS font stack. The browser takes the first installed family, and which one that is depends on the
 * machine (SF on a Mac, Liberation Sans for Helvetica or Arial on the Linux worker). So a stack is measured as the widest
 * of the families in it that have a table: text that fits here fits on every platform we know about.
 */
export function fontTable(family?: string): FontTable {
  const found: FontTable[] = []
  for (const raw of (family ?? '').split(',')) {
    const name = raw.trim().replace(/^["']|["']$/g, '').toLowerCase()
    if (!name) continue
    const hit = FAMILY_TABLES.find(([re]) => re.test(name))?.[1] ?? (/mono|consolas/.test(name) ? 'mono' : undefined)
    if (hit && !found.includes(hit)) found.push(hit)
  }
  if (found.length === 0) return fontClass(family)
  if (found.length === 1) return found[0]!
  const key = `stack:${found.join('+')}` as FontTable
  if (!TABLES[`${key}-400`]) {
    for (const w of [400, 700] as const) {
      const merged: Table = {}
      for (const t of found) for (const [ch, v] of Object.entries(TABLES[`${t}-${w}`] ?? {})) merged[ch] = Math.max(merged[ch] ?? 0, v)
      TABLES[`${key}-${w}`] = merged
    }
  }
  return key
}

/** The style fields measurement reads. A TextStyle satisfies it. */
export interface MeasureStyle {
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  /** In em. */
  letterSpacing?: number
  textTransform?: TextTransform
  lineHeight?: number
}

export interface Measured {
  lines: number
  height: number
  /** The widest line, in canvas px. */
  widest: number
}

type Table = Record<string, number>
const TABLES = metricsData as unknown as Record<string, Table>
const AVERAGES = new Map<string, number>()

/** The class of a font family: mono and serif families are matched by name, everything else is sans. */
export function fontClass(family?: string): FontClass {
  const f = (family ?? '').toLowerCase()
  if (/mono|menlo|consolas|courier/.test(f)) return 'mono'
  if (/georgia|times|serif/.test(f) && !/sans-serif/.test(f)) return 'serif'
  return 'sans'
}

// Han, kana, hangul, CJK punctuation, fullwidth forms and the CJK extension blocks. These are one em wide and may break anywhere.
const CJK_RE =
  /[ᄀ-ᇿ⺀-⿟　-〿぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿＀-￯]|[\u{20000}-\u{2ebef}]/u

export function isCjk(ch: string): boolean {
  return CJK_RE.test(ch)
}

function clampWeight(weight: number | undefined): number {
  const w = weight ?? 400
  return Math.min(900, Math.max(100, w))
}

function averageOf(key: string): number {
  const cached = AVERAGES.get(key)
  if (cached !== undefined) return cached
  const table = TABLES[key] ?? {}
  let sum = 0
  let n = 0
  for (let c = 97; c <= 122; c++) {
    const v = table[String.fromCharCode(c)]
    if (v !== undefined) {
      sum += v
      n++
    }
  }
  const avg = n > 0 ? sum / n : 500
  AVERAGES.set(key, avg)
  return avg
}

function unitsAt(cls: FontTable, weight: 400 | 700, ch: string): number {
  const key = `${cls}-${weight}`
  return TABLES[key]?.[ch] ?? averageOf(key)
}

export interface CharStyle {
  size: number
  weight?: number
  cls?: FontTable
}

/**
 * The advance width of one character, in px. Weights between 400 and 700 interpolate between the two tables; below 400 the
 * 400 table is scaled by 0.98; above 700 the 700 table is used. CJK characters are one em wide.
 */
export function charWidth(ch: string, o: CharStyle): number {
  if (isCjk(ch)) return o.size
  const cls = o.cls ?? 'sans'
  const w = clampWeight(o.weight)
  const regular = unitsAt(cls, 400, ch)
  let units: number
  if (w < 400) units = regular * 0.98
  else {
    const t = Math.min(1, (w - 400) / 300)
    units = regular + (unitsAt(cls, 700, ch) - regular) * t
  }
  return (units * o.size) / 1000
}

export function applyTransform(text: string, transform?: TextTransform): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase()
    case 'lowercase':
      return text.toLowerCase()
    case 'capitalize':
      return text.replace(/(^|\s)(\S)/gu, (_m, lead: string, ch: string) => lead + ch.toUpperCase())
    default:
      return text
  }
}

/** One character as the wrapper sees it. `w` includes letter-spacing. */
interface Unit {
  ch: string
  w: number
  size: number
  cjk: boolean
}

interface Run {
  size: number
  weight: number
  cls: FontTable
  /** em */
  ls: number
  tt: TextTransform
  lh: number
  indent: number
}

function unitsOf(text: string, r: Run): Unit[] {
  const out: Unit[] = []
  for (const ch of applyTransform(text, r.tt)) {
    const cjk = isCjk(ch)
    const w = charWidth(ch, { size: r.size, weight: r.weight, cls: r.cls }) + (cjk ? 0 : r.size * r.ls)
    out.push({ ch, w, size: r.size, cjk })
  }
  return out
}

interface Line {
  text: string
  width: number
  size: number
}

type TokKind = 'space' | 'word' | 'cjk'
interface Tok {
  kind: TokKind
  units: Unit[]
  w: number
}

/**
 * Greedy line breaking. Breaks happen at spaces, and next to CJK characters (which may break anywhere). A word wider than
 * the line breaks between characters. Spaces at a line start or end are dropped.
 */
function wrapUnits(units: Unit[], width: number, baseSize: number): Line[] {
  const max = Math.max(width, 1)
  const toks: Tok[] = []
  for (const u of units) {
    const space = /\s/.test(u.ch)
    const last = toks[toks.length - 1]
    if (space) {
      if (last?.kind === 'space') continue
      toks.push({ kind: 'space', units: [u], w: u.w })
    } else if (u.cjk) {
      toks.push({ kind: 'cjk', units: [u], w: u.w })
    } else if (last?.kind === 'word') {
      last.units.push(u)
      last.w += u.w
    } else {
      toks.push({ kind: 'word', units: [u], w: u.w })
    }
  }

  const lines: Unit[][] = []
  let line: Unit[] = []
  let lineW = 0
  let pending: Tok | undefined
  let prevCjk = false
  const emit = () => {
    lines.push(line)
    line = []
    lineW = 0
  }
  // A token that does not fit on an empty line is split between characters.
  const placeOnEmpty = (tok: Tok) => {
    if (tok.w <= max) {
      line.push(...tok.units)
      lineW = tok.w
      return
    }
    for (const u of tok.units) {
      if (line.length > 0 && lineW + u.w > max) emit()
      line.push(u)
      lineW += u.w
    }
  }

  for (const tok of toks) {
    if (tok.kind === 'space') {
      pending = tok
      continue
    }
    if (line.length === 0) {
      placeOnEmpty(tok)
    } else {
      const canBreak = pending !== undefined || prevCjk || tok.kind === 'cjk'
      const gap = pending?.w ?? 0
      if (!canBreak || lineW + gap + tok.w <= max) {
        if (pending) line.push(...pending.units)
        line.push(...tok.units)
        lineW += gap + tok.w
      } else {
        emit()
        placeOnEmpty(tok)
      }
    }
    prevCjk = tok.kind === 'cjk'
    pending = undefined
  }
  lines.push(line)

  return lines.map((units) => ({
    text: units.map((u) => u.ch).join(''),
    width: units.reduce((sum, u) => sum + u.w, 0),
    size: units.reduce((m, u) => Math.max(m, u.size), baseSize),
  }))
}

/** Wraps plain text at `maxWidth` px. Line breaks in the text start new lines. Uppercase is applied before measuring. */
export function measureLines(text: string, style: MeasureStyle & { fontSize: number }, maxWidth: number): string[] {
  const run: Run = {
    size: style.fontSize,
    weight: style.fontWeight ?? 400,
    cls: fontTable(style.fontFamily),
    ls: style.letterSpacing ?? 0,
    tt: style.textTransform ?? 'none',
    lh: style.lineHeight ?? DEFAULT_LINE_HEIGHT,
    indent: 0,
  }
  const out: string[] = []
  for (const para of text.split('\n')) {
    for (const line of wrapUnits(unitsOf(para, run), maxWidth, run.size)) out.push(line.text)
  }
  return out
}

interface Block {
  segments: Unit[][]
  lh: number
  size: number
  indent: number
  gapEm: number
}

function parseLength(value: string, base: number): number | undefined {
  const m = /^(-?\d*\.?\d+)(px|pt|em|rem)?$/.exec(value.trim())
  if (!m) return undefined
  const n = Number(m[1])
  switch (m[2]) {
    case 'pt':
      return n * (4 / 3)
    case 'em':
    case 'rem':
      return n * base
    default:
      return n
  }
}

/** The run a set of marks gives text inside `r`. Bold is 700 unless a textStyle sets a weight. */
function applyMarks(r: Run, marks: RichMark[] | undefined): Run {
  let out = { ...r }
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        out.weight = 700
        break
      case 'code':
        out.cls = 'menlo'
        break
      case 'textStyle': {
        const a = mark.attrs
        if (a.fontSize) out = { ...out, size: parseLength(a.fontSize, r.size) ?? out.size }
        if (a.fontWeight !== undefined && a.fontWeight !== null) {
          const fw = a.fontWeight
          const n = typeof fw === 'number' ? fw : fw === 'bold' ? 700 : fw === 'normal' ? 400 : Number(fw)
          if (Number.isFinite(n)) out.weight = n
        }
        if (a.fontFamily) out.cls = fontTable(a.fontFamily)
        if (a.letterSpacing) {
          const px = parseLength(a.letterSpacing, out.size)
          if (px !== undefined) out.ls = px / out.size
        }
        break
      }
    }
  }
  return out
}

function collectInline(node: RichNode, r: Run, units: Unit[], breakLine: () => void): void {
  if (node.type === 'hardBreak') {
    breakLine()
    return
  }
  if (typeof node.text === 'string') {
    units.push(...unitsOf(node.text, applyMarks(r, node.marks)))
    return
  }
  for (const child of node.content ?? []) collectInline(child, applyMarks(r, node.marks), units, breakLine)
}

function makeBlock(inlines: RichNode[], r: Run, lh: number, size: number, gapEm: number): Block {
  const segments: Unit[][] = []
  let units: Unit[] = []
  const breakLine = () => {
    segments.push(units)
    units = []
  }
  const base: Run = { ...r, size, lh }
  for (const node of inlines) collectInline(node, base, units, breakLine)
  segments.push(units)
  return { segments, lh, size, indent: r.indent, gapEm }
}

function flatten(node: RichNode, r: Run, out: Block[]): void {
  const kids = node.content ?? []
  switch (node.type) {
    case 'doc':
    case 'listItem':
    case 'blockquote':
      for (const child of kids) flatten(child, r, out)
      return
    case 'bulletList':
    case 'orderedList':
      for (const child of kids) flatten(child, { ...r, indent: r.indent + LIST_INDENT_EM * r.size }, out)
      return
    case 'paragraph':
    case 'codeBlock':
      out.push(makeBlock(kids, r, r.lh, r.size, PARAGRAPH_GAP_EM))
      return
    case 'heading': {
      const level = Math.min(Math.max(Math.round(Number(node.attrs?.level ?? 1)), 1), 6)
      const size = level <= 4 ? HEADING_PX[level - 1]! : r.size * (level === 5 ? 0.83 : 0.67)
      out.push(makeBlock(kids, { ...r, weight: 700 }, HEADING_LINE_HEIGHT, size, HEADING_GAP_EM))
      return
    }
    case 'horizontalRule':
      return
    default:
      if (typeof node.text === 'string') out.push(makeBlock([node], r, r.lh, r.size, PARAGRAPH_GAP_EM))
      else for (const child of kids) flatten(child, r, out)
  }
}

/**
 * Measures a rich-text doc set in a box `width` px wide, with the given style. Paragraphs, headings and list items each start
 * a new line. Height is the sum of the line heights (lineHeight, default 1.2, times the largest size on the line) plus the
 * paragraph gaps. The width is divided by 1.04 before wrapping, so a line that just fits is not reported as wrapping.
 */
export function measureRich(content: RichText | RichNode | null | undefined, style: MeasureStyle, width: number): Measured {
  const size = style.fontSize ?? DEFAULT_TEXT_SIZE
  const run: Run = {
    size,
    weight: style.fontWeight ?? 400,
    cls: fontTable(style.fontFamily),
    ls: style.letterSpacing ?? 0,
    tt: style.textTransform ?? 'none',
    lh: style.lineHeight ?? DEFAULT_LINE_HEIGHT,
    indent: 0,
  }
  const blocks: Block[] = []
  if (content) flatten(content as RichNode, run, blocks)
  if (blocks.length === 0) blocks.push({ segments: [[]], lh: run.lh, size, indent: 0, gapEm: 0 })

  const avail = Math.max(width / SAFETY, 1)
  let lines = 0
  let height = 0
  let widest = 0
  blocks.forEach((b, i) => {
    for (const seg of b.segments) {
      for (const line of wrapUnits(seg, Math.max(avail - b.indent, 1), b.size)) {
        lines++
        height += line.size * b.lh
        widest = Math.max(widest, line.width)
      }
    }
    if (i < blocks.length - 1) height += b.gapEm * b.size
  })
  return { lines, height, widest }
}

/** Measured height of a text element's content in its box width. */
export function textHeight(el: Pick<TextElement, 'content' | 'style' | 'w'>): number {
  return measureRich(el.content, el.style as TextStyle, el.w).height
}

/** The extent of the measured text block inside its box, per the box's vertical alignment. */
export function textBlock(el: Pick<TextElement, 'content' | 'style' | 'w' | 'x' | 'y' | 'h'>): { top: number; bottom: number } {
  const mh = textHeight(el)
  const valign = el.style.valign
  if (valign === 'middle') return { top: el.y + (el.h - mh) / 2, bottom: el.y + (el.h + mh) / 2 }
  if (valign === 'bottom') return { top: el.y + el.h - mh, bottom: el.y + el.h }
  return { top: el.y, bottom: el.y + mh }
}

function scaleLength(value: string, factor: number): string {
  const m = /^(-?\d*\.?\d+)(px|pt)?$/.exec(value.trim())
  if (!m) return value
  const n = Number(m[1]) * factor
  return `${Math.round(n * 100) / 100}${m[2] ?? ''}`
}

function scaleNode(node: RichNode, factor: number): RichNode {
  const out: RichNode = { ...node }
  if (node.marks) {
    out.marks = node.marks.map((m) =>
      m.type === 'textStyle' && m.attrs.fontSize ? ({ ...m, attrs: { ...m.attrs, fontSize: scaleLength(m.attrs.fontSize, factor) } } as RichMark) : m,
    )
  }
  if (node.content) out.content = node.content.map((c) => scaleNode(c, factor))
  return out
}

/**
 * Honours `style.autoFit`. 'shrink' lowers the font size (and the sizes of textStyle marks) in 2% steps, to 60% at the least,
 * until the text fits its height. 'grow-box' sets the height to the measured height, rounded up. 'none' or no autoFit leaves
 * the element unchanged. A shrink that cannot fit at 60% keeps the 60% size; the linter reports the overflow.
 */
export function fitText(el: TextElement): TextElement {
  const mode = el.style.autoFit
  if (mode === 'grow-box') return { ...el, h: Math.ceil(textHeight(el)) }
  if (mode !== 'shrink') return el
  if (textHeight(el) <= el.h + 0.01) return el
  const base = el.style.fontSize ?? DEFAULT_TEXT_SIZE
  let last: TextElement = el
  for (let step = 1; step <= 20; step++) {
    const factor = 1 - step * 0.02
    const candidate: TextElement = {
      ...el,
      style: { ...el.style, fontSize: Math.round(base * factor * 100) / 100 },
      content: scaleNode(el.content as RichNode, factor) as TextElement['content'],
    }
    last = candidate
    if (textHeight(candidate) <= el.h + 0.01) return candidate
  }
  return last
}

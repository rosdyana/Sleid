// One slide: its shapes, text, pictures, tables and charts, with placeholder inheritance and
// group transforms. Everything is converted to canvas pixels here.
import { newId, type Element, type RichNode, type Slide, type SlideLayout, type Theme } from '@sleid/model'
import { parseChart } from './chart.ts'
import { readPart, relOfType, type Relationships } from './package.ts'
import { colorIn, type ParsedTheme } from './theme.ts'
import { attr, child, childrenNamed, firstDescendant, kids, local, numAttr, textOf, type XNode } from './xml.ts'
import type { PackageFiles } from './zip.ts'

/** EMU to canvas px: x_px = ox + x_emu * scale. */
export interface Fit {
  scale: number
  ox: number
  oy: number
}

/** An affine map from one coordinate space to the slide's EMU space. */
export interface Xf {
  ax: number
  bx: number
  ay: number
  by: number
}

export const IDENTITY: Xf = { ax: 1, bx: 0, ay: 1, by: 0 }

/** `outer` applied after `inner`. */
export function compose(outer: Xf, inner: Xf): Xf {
  return {
    ax: outer.ax * inner.ax,
    bx: outer.ax * inner.bx + outer.bx,
    ay: outer.ay * inner.ay,
    by: outer.ay * inner.by + outer.by,
  }
}

export interface EmuFrame {
  x: number
  y: number
  w: number
  h: number
}

export interface Canvas {
  x: number
  y: number
  w: number
  h: number
  rotation: number
}

export interface SlideEnv {
  files: PackageFiles
  fit: Fit
  theme: Theme
  parsedTheme: ParsedTheme | undefined
  /** Largest picture or background, in bytes. */
  maxImageBytes: number
  warnings: string[]
}

const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const SUPPORTED_SHAPES = new Set(['rect', 'roundRect', 'ellipse', 'line'])
const SHAPE_NAMES = ['rect', 'roundRect', 'ellipse', 'line'] as const

/** Fit a slide of cx by cy EMU onto the 1920 by 1080 canvas, centred. Equal to 16:9 gives scale 1920 / cx. */
export function fitFor(cx: number, cy: number): Fit {
  const scale = Math.min(1920 / cx, 1080 / cy)
  return { scale, ox: (1920 - cx * scale) / 2, oy: (1080 - cy * scale) / 2 }
}

/** Points to canvas px: 1 pt is 12 700 EMU. */
function ptToPx(pt: number, fit: Fit): number {
  return pt * 12700 * fit.scale
}

export function toCanvas(frame: EmuFrame, fit: Fit): Canvas {
  return {
    x: round(fit.ox + frame.x * fit.scale),
    y: round(fit.oy + frame.y * fit.scale),
    w: round(frame.w * fit.scale),
    h: round(frame.h * fit.scale),
    rotation: 0,
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** The transform of a `a:xfrm` or `p:xfrm` node, as a local frame and a rotation in degrees. */
export function readXfrm(xfrm: XNode | undefined): { frame: EmuFrame; rotation: number } | undefined {
  if (!xfrm) return undefined
  const off = child(xfrm, 'off')
  const ext = child(xfrm, 'ext')
  const x = numAttr(off, 'x')
  const y = numAttr(off, 'y')
  const w = numAttr(ext, 'cx')
  const h = numAttr(ext, 'cy')
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined
  const rot = numAttr(xfrm, 'rot') ?? 0
  return { frame: { x, y, w, h }, rotation: Math.round((rot / 60000) * 100) / 100 }
}

/** The map from a group's child space to its parent space. */
export function groupXf(grpSpPr: XNode | undefined): Xf {
  const xfrm = readXfrm(child(grpSpPr, 'xfrm'))
  const chOff = child(child(grpSpPr, 'xfrm'), 'chOff')
  const chExt = child(child(grpSpPr, 'xfrm'), 'chExt')
  if (!xfrm || numAttr(chOff, 'x') === undefined) return IDENTITY
  const chX = numAttr(chOff, 'x')!
  const chY = numAttr(chOff, 'y')!
  const chW = numAttr(chExt, 'cx') || xfrm.frame.w
  const chH = numAttr(chExt, 'cy') || xfrm.frame.h
  const ax = chW === 0 ? 1 : xfrm.frame.w / chW
  const ay = chH === 0 ? 1 : xfrm.frame.h / chH
  return { ax, bx: xfrm.frame.x - chX * ax, ay, by: xfrm.frame.y - chY * ay }
}

export function applyXf(frame: EmuFrame, xf: Xf): EmuFrame {
  return { x: xf.ax * frame.x + xf.bx, y: xf.ay * frame.y + xf.by, w: frame.w * xf.ax, h: frame.h * xf.ay }
}

// ---------------------------------------------------------------------------
// Placeholders and inheritance
// ---------------------------------------------------------------------------

export interface Placeholder {
  type: string
  idx: string | undefined
}

export function placeholderOf(sp: XNode): Placeholder | undefined {
  const ph = child(child(child(sp, 'nvSpPr'), 'nvPr'), 'ph') ?? child(child(child(sp, 'nvPicPr'), 'nvPr'), 'ph')
  if (!ph) return undefined
  return { type: attr(ph, 'type') ?? 'obj', idx: attr(ph, 'idx') }
}

/** Equivalent placeholder kinds: ctrTitle is a title, obj is a body. */
function phKind(type: string): string {
  if (type === 'ctrTitle') return 'title'
  if (type === 'obj') return 'body'
  return type
}

function spTreeOf(root: XNode): XNode[] {
  return childrenNamed(firstDescendant(root, 'spTree'), 'sp')
}

/** The shape on a layout or master that a slide placeholder inherits from. */
export function findInherited(ph: Placeholder, sources: XNode[][]): XNode | undefined {
  for (const list of sources) {
    const same = list.filter((sp) => {
      const p = placeholderOf(sp)
      return p !== undefined && phKind(p.type) === phKind(ph.type)
    })
    const byIdx = same.find((sp) => ph.idx !== undefined && placeholderOf(sp)?.idx === ph.idx)
    const found = byIdx ?? same[0]
    if (found && readXfrm(child(child(found, 'spPr'), 'xfrm'))) return found
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const ALIGN: Record<string, 'left' | 'center' | 'right' | 'justify'> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }
const VALIGN: Record<string, 'top' | 'middle' | 'bottom'> = { t: 'top', ctr: 'middle', b: 'bottom' }

interface TextRead {
  doc: { type: 'doc'; content: RichNode[] }
  align: 'left' | 'center' | 'right' | 'justify'
  valign: 'top' | 'middle' | 'bottom'
  fontSize?: number
  plain: string
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true'
}

function runMarks(rPr: XNode | undefined, slideRels: Relationships, env: SlideEnv, notes: { size?: number }): RichNode['marks'] {
  const marks: NonNullable<RichNode['marks']> = []
  if (truthy(attr(rPr, 'b'))) marks.push({ type: 'bold' })
  if (truthy(attr(rPr, 'i'))) marks.push({ type: 'italic' })
  const u = attr(rPr, 'u')
  if (u && u !== 'none') marks.push({ type: 'underline' })
  const strike = attr(rPr, 'strike')
  if (strike && strike !== 'noStrike') marks.push({ type: 'strike' })
  const link = child(rPr, 'hlinkClick')
  const rid = attr(link, 'r:id')
  if (rid) {
    const rel = slideRels.get(rid)
    if (rel?.external && /^(https?:\/\/|mailto:)/i.test(rel.target)) {
      marks.push({ type: 'link', attrs: { href: rel.target, target: '_blank', rel: 'noopener noreferrer' } })
    }
  }
  const attrs: Record<string, string> = {}
  const color = colorIn(child(rPr, 'solidFill'), env.parsedTheme)
  if (color) attrs.color = color
  const sz = numAttr(rPr, 'sz')
  if (sz !== undefined && sz > 0) {
    const px = Math.round(ptToPx(sz / 100, env.fit) * 10) / 10
    attrs.fontSize = String(px)
    if (notes.size === undefined) notes.size = px
  }
  const face = attr(child(rPr, 'latin'), 'typeface')
  if (face && !face.startsWith('+')) attrs.fontFamily = face.slice(0, 120)
  if (Object.keys(attrs).length > 0) marks.push({ type: 'textStyle', attrs })
  return marks.length > 0 ? marks : undefined
}

/** A paragraph's runs, line breaks and fields, in document order. */
function inlineOf(p: XNode, slideRels: Relationships, env: SlideEnv, notes: { size?: number }): RichNode[] {
  const out: RichNode[] = []
  for (const c of kids(p)) {
    const name = local(c.name)
    if (name === 'r' || name === 'fld') {
      const text = textOf(child(c, 't'))
      if (text.length === 0) continue
      const marks = runMarks(child(c, 'rPr'), slideRels, env, notes)
      out.push({ type: 'text', text, ...(marks ? { marks } : {}) })
    } else if (name === 'br') {
      out.push({ type: 'hardBreak' })
    }
  }
  return out
}

/** Paragraphs of a text body as a RichText doc. Consecutive bullets become one list. */
export function readText(txBody: XNode | undefined, slideRels: Relationships, env: SlideEnv): TextRead {
  const notes: { size?: number } = {}
  const bodyPr = child(txBody, 'bodyPr')
  const valign = VALIGN[attr(bodyPr, 'anchor') ?? ''] ?? 'top'
  const paras = childrenNamed(txBody, 'p')
  const content: RichNode[] = []
  let firstAlign: 'left' | 'center' | 'right' | 'justify' | undefined
  let group: { kind: 'bulletList' | 'orderedList'; items: RichNode[] } | undefined
  const flush = () => {
    if (group) content.push({ type: group.kind, content: group.items })
    group = undefined
  }
  const plainParts: string[] = []
  for (const p of paras) {
    const pPr = child(p, 'pPr')
    const algn = ALIGN[attr(pPr, 'algn') ?? '']
    if (algn && !firstAlign) firstAlign = algn
    const inline = inlineOf(p, slideRels, env, notes)
    plainParts.push(inline.map((n) => (n.type === 'text' ? (n.text ?? '') : '')).join(''))
    const paragraph: RichNode = { type: 'paragraph', content: inline }
    const kind = child(pPr, 'buAutoNum') ? 'orderedList' : child(pPr, 'buChar') ? 'bulletList' : undefined
    if (kind) {
      if (!group || group.kind !== kind) {
        flush()
        group = { kind, items: [] }
      }
      group.items.push({ type: 'listItem', content: [paragraph] })
    } else {
      flush()
      content.push(paragraph)
    }
  }
  flush()
  const plain = plainParts.join('\n').trim()
  return {
    doc: { type: 'doc', content },
    align: firstAlign ?? 'left',
    valign,
    ...(notes.size !== undefined ? { fontSize: notes.size } : {}),
    plain,
  }
}

// ---------------------------------------------------------------------------
// Slide walk
// ---------------------------------------------------------------------------

export interface Draft {
  x: number
  y: number
  w: number
  h: number
  rotation: number
  // The element body. Id and z are assigned when the slide is finished.
  body: Record<string, unknown> & { type: Element['type'] }
  alt?: string
}

export interface SlideResult {
  slide: Omit<Slide, 'id'>
  notes: string
}

interface Walk {
  env: SlideEnv
  slideRels: Relationships
  slideNo: number
  drafts: Draft[]
}

function warn(walk: Walk, message: string): void {
  walk.env.warnings.push(`Slide ${walk.slideNo}: ${message}`)
}

/** Shape-level fill and line, read from `spPr`. */
function fillAndLine(spPr: XNode | undefined, env: SlideEnv): { fill?: string; stroke?: string; strokeWidth: number } {
  const fill = colorIn(child(spPr, 'solidFill'), env.parsedTheme)
  const ln = child(spPr, 'ln')
  const stroke = ln && !child(ln, 'noFill') ? colorIn(child(ln, 'solidFill'), env.parsedTheme) : undefined
  const w = numAttr(ln, 'w')
  const strokeWidth = stroke && w !== undefined && w > 0 ? Math.round(w * env.fit.scale * 100) / 100 : stroke ? 1 : 0
  return { fill, stroke, strokeWidth }
}

async function imageDataUrl(walk: Walk, rid: string, label: string): Promise<{ src: string } | undefined> {
  const rel = walk.slideRels.get(rid)
  if (!rel) {
    warn(walk, `${label} refers to a missing part, so it was left out.`)
    return undefined
  }
  if (rel.external) {
    warn(walk, `${label} links to a file outside the presentation. It was not fetched and was left out.`)
    return undefined
  }
  const ext = (rel.target.split('.').pop() ?? '').toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (!mime) {
    warn(walk, `${label} is in a format that is not supported (.${ext || 'unknown'}), so it was left out.`)
    return undefined
  }
  const bytes = await walk.env.files.read(rel.target)
  if (!bytes) {
    warn(walk, `${label} is missing from the file, so it was left out.`)
    return undefined
  }
  if (bytes.byteLength > walk.env.maxImageBytes) {
    warn(walk, `${label} is larger than ${Math.round(walk.env.maxImageBytes / (1024 * 1024))} MB, so it was left out.`)
    return undefined
  }
  return { src: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` }
}

function textRole(ph: Placeholder | undefined): 'title' | 'subtitle' | 'body' | undefined {
  if (!ph) return undefined
  if (ph.type === 'title' || ph.type === 'ctrTitle') return 'title'
  if (ph.type === 'subTitle') return 'subtitle'
  return 'body'
}

async function walkNodes(nodes: XNode[], xf: Xf, walk: Walk, inheritedFrom: XNode[][]): Promise<void> {
  for (const node of nodes) {
    const name = local(node.name)
    if (name === 'sp') await convertSp(node, xf, walk, inheritedFrom)
    else if (name === 'cxnSp') await convertCxn(node, xf, walk)
    else if (name === 'pic') await convertPic(node, xf, walk, inheritedFrom)
    else if (name === 'grpSp') {
      const grpSpPr = child(node, 'grpSpPr')
      const inner = compose(xf, groupXf(grpSpPr))
      if (readXfrm(child(grpSpPr, 'xfrm'))?.rotation) warn(walk, 'a rotated group was imported without its rotation.')
      await walkNodes(kids(node), inner, walk, inheritedFrom)
    } else if (name === 'graphicFrame') {
      await convertFrame(node, xf, walk)
    } else if (name === 'AlternateContent') {
      await convertAlternate(node, xf, walk, inheritedFrom)
    } else if (name === 'nvGrpSpPr' || name === 'grpSpPr' || name === 'extLst') {
      continue
    } else if (name !== '#text') {
      warn(walk, `an unsupported element (${node.name}) was skipped.`)
    }
  }
}

/** mc:AlternateContent: the Choice is used; the Fallback is used when the Choice is not supported. */
async function convertAlternate(node: XNode, xf: Xf, walk: Walk, inheritedFrom: XNode[][]): Promise<void> {
  const choice = child(node, 'Choice')
  const fallback = child(node, 'Fallback')
  const before = walk.drafts.length
  const failedBefore = walk.env.warnings.length
  if (choice) await walkNodes(kids(choice), xf, walk, inheritedFrom)
  const failed = walk.env.warnings.slice(failedBefore).some((w) => w.includes('[Chart not imported]'))
  if (failed && fallback) {
    walk.drafts.length = before
    walk.env.warnings.length = failedBefore
    await walkNodes(kids(fallback), xf, walk, inheritedFrom)
  }
}

async function convertSp(sp: XNode, xf: Xf, walk: Walk, inheritedFrom: XNode[][]): Promise<void> {
  const ph = placeholderOf(sp)
  const spPr = child(sp, 'spPr')
  let local_ = readXfrm(child(spPr, 'xfrm'))
  if (!local_ && ph) {
    const inherited = findInherited(ph, inheritedFrom)
    local_ = readXfrm(child(child(inherited, 'spPr'), 'xfrm'))
  }
  const txBody = child(sp, 'txBody')
  const text = txBody ? readText(txBody, walk.slideRels, walk.env) : undefined
  const hasText = !!text && text.plain.length > 0
  const prst = attr(child(spPr, 'prstGeom'), 'prst')
  const custom = !!child(spPr, 'custGeom')
  if (!local_) {
    if (hasText) warn(walk, 'a text box had no position, so it was left out.')
    return
  }
  const frame = applyXf(local_.frame, xf)
  const canvas = { ...toCanvas(frame, walk.env.fit), rotation: local_.rotation }
  const { fill, stroke, strokeWidth } = fillAndLine(spPr, walk.env)
  const alt = attr(child(child(sp, 'nvSpPr'), 'cNvPr'), 'descr')

  // Shapes. A preset that is not supported becomes a rectangle, with a warning.
  if (prst !== undefined || custom) {
    const kind = prst !== undefined && SUPPORTED_SHAPES.has(prst) ? prst : undefined
    const visible = fill !== undefined || (stroke !== undefined && strokeWidth > 0)
    if (kind && visible) {
      walk.drafts.push(shapeDraft(kind, canvas, fill, stroke, strokeWidth, alt))
    } else if (!kind && !ph) {
      if (visible) {
        warn(walk, `the shape "${prst ?? 'custom'}" is not supported, so a rectangle was imported.`)
        walk.drafts.push(shapeDraft('rect', canvas, fill, stroke, strokeWidth, alt))
      } else if (!hasText) {
        warn(walk, `the shape "${prst ?? 'custom'}" is not supported and was left out.`)
      }
    }
  }

  // Text. Empty placeholders are not imported: a layout's prompt text is not content.
  if (hasText && text) {
    const role = textRole(ph)
    const style: Record<string, unknown> = { align: text.align, valign: text.valign }
    if (text.fontSize !== undefined) style.fontSize = text.fontSize
    walk.drafts.push({
      ...canvas,
      body: { type: 'text', content: text.doc, style, ...(role ? { role } : {}) },
      ...(alt ? { alt } : {}),
    })
  }
}

function shapeDraft(kind: string, canvas: Canvas, fill: string | undefined, stroke: string | undefined, strokeWidth: number, alt: string | undefined): Draft {
  return {
    ...canvas,
    body: {
      type: 'shape',
      shape: SHAPE_NAMES.includes(kind as (typeof SHAPE_NAMES)[number]) ? kind : 'rect',
      fill: fill ?? 'transparent',
      stroke: stroke ?? 'transparent',
      strokeWidth,
    },
    ...(alt ? { alt } : {}),
  }
}

async function convertCxn(cxn: XNode, xf: Xf, walk: Walk): Promise<void> {
  const spPr = child(cxn, 'spPr')
  const local_ = readXfrm(child(spPr, 'xfrm'))
  if (!local_) return
  const prst = attr(child(spPr, 'prstGeom'), 'prst')
  if (prst !== 'line' && prst !== 'straightConnector1') {
    warn(walk, `the connector "${prst ?? 'custom'}" is not supported, so it was left out.`)
    return
  }
  const { stroke, strokeWidth } = fillAndLine(spPr, walk.env)
  const frame = applyXf(local_.frame, xf)
  const canvas = { ...toCanvas(frame, walk.env.fit), rotation: local_.rotation }
  walk.drafts.push(shapeDraft('line', canvas, undefined, stroke ?? '#000000', Math.max(strokeWidth, 1), undefined))
}

async function convertPic(pic: XNode, xf: Xf, walk: Walk, inheritedFrom: XNode[][]): Promise<void> {
  const ph = placeholderOf(pic)
  const spPr = child(pic, 'spPr')
  let local_ = readXfrm(child(spPr, 'xfrm'))
  if (!local_ && ph) local_ = readXfrm(child(child(findInherited(ph, inheritedFrom), 'spPr'), 'xfrm'))
  if (!local_) {
    warn(walk, 'a picture had no position, so it was left out.')
    return
  }
  const blip = firstDescendant(pic, 'blip')
  const rid = attr(blip, 'r:embed')
  if (!rid) {
    warn(walk, 'a picture had no image, so it was left out.')
    return
  }
  const image = await imageDataUrl(walk, rid, 'A picture')
  if (!image) return
  const srcRect = firstDescendant(pic, 'srcRect')
  const crop = cropOf(srcRect)
  const frame = applyXf(local_.frame, xf)
  const alt = attr(child(child(pic, 'nvPicPr'), 'cNvPr'), 'descr')
  walk.drafts.push({
    ...toCanvas(frame, walk.env.fit),
    rotation: local_.rotation,
    body: { type: 'image', src: image.src, fit: 'contain', ...(crop ? { crop } : {}) },
    ...(alt ? { alt } : {}),
  })
}

function cropOf(srcRect: XNode | undefined): { x: number; y: number; w: number; h: number } | undefined {
  if (!srcRect) return undefined
  const l = (numAttr(srcRect, 'l') ?? 0) / 100000
  const t = (numAttr(srcRect, 't') ?? 0) / 100000
  const r = (numAttr(srcRect, 'r') ?? 0) / 100000
  const b = (numAttr(srcRect, 'b') ?? 0) / 100000
  const w = 1 - l - r
  const h = 1 - t - b
  if (l < 0 || t < 0 || r < 0 || b < 0 || w <= 0 || h <= 0) return undefined
  if (l === 0 && t === 0 && r === 0 && b === 0) return undefined
  return { x: round(l), y: round(t), w: round(w), h: round(h) }
}

async function convertFrame(frameNode: XNode, xf: Xf, walk: Walk): Promise<void> {
  const xfrm = readXfrm(child(frameNode, 'xfrm'))
  if (!xfrm) return
  const graphicData = firstDescendant(frameNode, 'graphicData')
  const uri = attr(graphicData, 'uri') ?? ''
  const frame = applyXf(xfrm.frame, xf)
  const canvas = { ...toCanvas(frame, walk.env.fit), rotation: xfrm.rotation }

  const tbl = child(graphicData, 'tbl')
  if (tbl) {
    const rows = childrenNamed(tbl, 'tr').map((tr) =>
      childrenNamed(tr, 'tc').map((tc) => childrenNamed(child(tc, 'txBody'), 'p').map((p) => textOf(p)).join(' ').trim()),
    )
    if (rows.length === 0) return
    const first = child(tbl, 'tblPr')
    walk.drafts.push({ ...canvas, body: { type: 'table', rows, header: truthy(attr(first, 'firstRow')) } })
    return
  }

  if (uri.includes('/chart') && !uri.includes('chartex')) {
    const chartRef = child(graphicData, 'chart')
    const rid = attr(chartRef, 'r:id')
    const rel = rid ? walk.slideRels.get(rid) : undefined
    const root = rel && !rel.external ? await readPart(walk.env.files, rel.target) : null
    const parsed = root ? parseChart(root, walk.env.parsedTheme) : { ok: false as const, reason: 'the chart part is missing' }
    if (parsed.ok) {
      if (parsed.chart.warning) warn(walk, `${parsed.chart.warning}.`)
      walk.drafts.push({
        ...canvas,
        body: { type: 'chart', chartType: parsed.chart.chartType, data: parsed.chart.data, options: parsed.chart.options },
      })
      return
    }
    warn(walk, `[Chart not imported]: ${parsed.reason}.`)
    walk.drafts.push(placeholderText(canvas, '[Chart not imported]'))
    return
  }

  if (uri.includes('chartex')) {
    warn(walk, '[Chart not imported]: this chart type is not supported.')
    walk.drafts.push(placeholderText(canvas, '[Chart not imported]'))
    return
  }
  warn(walk, `an unsupported object (${uri.split('/').pop() || 'unknown'}) was skipped.`)
}

function placeholderText(canvas: Canvas, text: string): Draft {
  return {
    ...canvas,
    body: {
      type: 'text',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'italic' }] }] }] },
      style: { align: 'center', valign: 'middle' },
    },
  }
}

// ---------------------------------------------------------------------------
// Public: convert one slide
// ---------------------------------------------------------------------------

/** The slide's layout-type to the deck's layout set. */
export function layoutFor(layoutType: string | undefined): SlideLayout {
  switch (layoutType) {
    case 'title':
    case 'ctrTitle':
      return 'title'
    case 'secHead':
      return 'section'
    case 'twoObj':
    case 'twoTxTwoObj':
    case 'twoColTx':
      return 'two-column'
    case 'blank':
      return 'blank'
    case 'picTx':
      return 'image-left'
    default:
      return 'title-content'
  }
}

async function backgroundOf(root: XNode, walk: Walk): Promise<Slide['background']> {
  const bg = child(child(root, 'cSld'), 'bg')
  if (!bg) return undefined
  const bgPr = child(bg, 'bgPr')
  if (bgPr) {
    const solid = colorIn(child(bgPr, 'solidFill'), walk.env.parsedTheme)
    if (solid) return { type: 'color', value: solid }
    const grad = child(bgPr, 'gradFill')
    if (grad) {
      const first = colorIn(firstDescendant(grad, 'gs'), walk.env.parsedTheme)
      if (first) {
        warn(walk, 'a gradient background was imported as its first colour.')
        return { type: 'color', value: first }
      }
    }
    const blip = child(bgPr, 'blipFill')
    if (blip) {
      const rid = attr(child(blip, 'blip'), 'r:embed')
      if (rid) {
        const image = await imageDataUrl(walk, rid, 'The slide background')
        if (image) return { type: 'image', value: image.src }
      }
    }
    return undefined
  }
  const bgRef = child(bg, 'bgRef')
  const color = colorIn(bgRef, walk.env.parsedTheme)
  return color ? { type: 'color', value: color } : undefined
}

/** Converts one slide. The env carries shared state, so the layout and master are read once per slide. */
export async function convertSlide(
  slideRoot: XNode,
  slideRels: Relationships,
  layout: { root: XNode | undefined; rels: Relationships } | undefined,
  master: { root: XNode | undefined } | undefined,
  env: SlideEnv,
  slideNo: number,
  notesText: string,
): Promise<SlideResult> {
  const walk: Walk = { env, slideRels, slideNo, drafts: [] }
  const inheritedFrom: XNode[][] = [layout?.root ? spTreeOf(layout.root) : [], master?.root ? spTreeOf(master.root) : []]
  const layoutAttr = layout?.root ? attr(layout.root, 'type') : undefined
  const sld = slideRoot
  const spTree = firstDescendant(child(sld, 'cSld'), 'spTree')
  const background = await backgroundOf(sld, walk)

  await walkNodes(kids(spTree), IDENTITY, walk, inheritedFrom)

  // Element ids and z order are assigned here, in document order, so z follows the file.
  const elements = walk.drafts.map((d, i): Record<string, unknown> => ({
    ...d.body,
    x: d.x,
    y: d.y,
    w: d.w,
    h: d.h,
    rotation: d.rotation,
    id: newId(),
    z: i,
    locked: false,
    opacity: 1,
    ...(d.alt ? { alt: d.alt } : {}),
  }))
  const slide: Omit<Slide, 'id'> = {
    layout: layoutFor(layoutAttr),
    notes: notesText,
    transition: 'none',
    autoAnimate: false,
    hidden: attr(sld, 'show') === '0',
    elements: elements as unknown as Element[],
    ...(background ? { background } : {}),
  }
  return { slide, notes: notesText }
}

/** The speaker notes of a slide: the body placeholder of its notes page. */
export async function readNotes(files: PackageFiles, slideRels: Relationships, env: SlideEnv): Promise<string> {
  const rel = relOfType(slideRels, '/notesSlide')
  if (!rel) return ''
  const root = await readPart(files, rel.target)
  if (!root) return ''
  const parts: string[] = []
  for (const sp of spTreeOf(root)) {
    const ph = placeholderOf(sp)
    if (!ph || ph.type !== 'body') continue
    const text = readText(child(sp, 'txBody'), new Map(), env)
    if (text.plain) parts.push(text.plain)
  }
  return parts.join('\n').slice(0, 20000)
}

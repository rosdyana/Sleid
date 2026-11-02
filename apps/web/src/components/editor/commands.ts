// Element templates, labels, clipboard and small geometry helpers shared by
// the menus, the toolbar, the canvas and the side panel.
import { ElementSchema, type Element, type Slide, type Theme } from '@sleid/model'
import { plainToRich, richToPlain } from './rich.ts'

export const CANVAS_W = 1920
export const CANVAS_H = 1080

export type ElementDraft = { type: string } & Record<string, unknown>

const base = { rotation: 0, locked: false, opacity: 1 }

function centered(w: number, h: number) {
  return { x: Math.round((CANVAS_W - w) / 2), y: Math.round((CANVAS_H - h) / 2) }
}

export function textDraft(theme: Theme, text = 'Text'): ElementDraft {
  const { x, y } = centered(640, 200)
  return {
    ...base,
    type: 'text',
    x,
    y,
    w: 640,
    h: 200,
    content: plainToRich(text),
    style: {
      fontFamily: theme.fonts.body,
      fontSize: theme.sizes.body,
      color: theme.colors.text,
      align: 'left',
      valign: 'top',
    },
  }
}

export const SHAPE_LABELS: Record<string, string> = {
  rect: 'Rectangle',
  roundRect: 'Rounded rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  arrow: 'Arrow',
  line: 'Line',
  star: 'Star',
}

export const CHART_LABELS: Record<string, string> = {
  bar: 'Bar',
  line: 'Line',
  pie: 'Pie',
  donut: 'Donut',
  area: 'Area',
  'stacked-bar': 'Stacked bar',
  scatter: 'Scatter',
}

export function shapeDraft(theme: Theme, shape: string): ElementDraft {
  const { x, y } = centered(400, 260)
  return {
    ...base,
    type: 'shape',
    shape,
    x,
    y,
    w: 400,
    h: 260,
    fill: theme.colors.accent,
    stroke: theme.colors.text,
    strokeWidth: 0,
  }
}

export function imageDraft(src: string): ElementDraft {
  const { x, y } = centered(640, 480)
  return { ...base, type: 'image', x, y, w: 640, h: 480, src, fit: 'contain' }
}

export function chartDraft(chartType: string): ElementDraft {
  const { x, y } = centered(960, 540)
  const data =
    chartType === 'scatter'
      ? { columns: ['X', 'Y'], rows: [[1, 4], [2, 7], [3, 3], [4, 9]] }
      : chartType === 'pie' || chartType === 'donut'
        ? { columns: ['Category', 'Share'], rows: [['A', 40], ['B', 35], ['C', 25]] }
        : {
            columns: ['Category', 'Series 1', 'Series 2'],
            rows: [['Jan', 4, 3], ['Feb', 7, 5], ['Mar', 3, 8]],
          }
  return { ...base, type: 'chart', x, y, w: 960, h: 540, chartType, data, options: { legend: true } }
}

export function tableDraft(): ElementDraft {
  const { x, y } = centered(960, 300)
  return {
    ...base,
    type: 'table',
    x,
    y,
    w: 960,
    h: 300,
    rows: [['Item', 'Value'], ['First', '10'], ['Second', '20']],
    header: true,
  }
}

export function codeDraft(): ElementDraft {
  const { x, y } = centered(960, 320)
  return { ...base, type: 'code', x, y, w: 960, h: 320, code: 'console.log("hello")', language: 'javascript' }
}

export function diagramDraft(): ElementDraft {
  const { x, y } = centered(960, 540)
  return { ...base, type: 'diagram', x, y, w: 960, h: 540, source: 'graph TD\n  A[Start] --> B[Finish]' }
}

export function elementLabel(el: Element): string {
  switch (el.type) {
    case 'text':
      return el.role ? `Text (${el.role})` : 'Text box'
    case 'shape':
      return SHAPE_LABELS[el.shape] ?? 'Shape'
    case 'image':
      return 'Image'
    case 'chart':
      return `Chart (${CHART_LABELS[el.chartType] ?? el.chartType})`
    case 'diagram':
      return 'Diagram'
    case 'table':
      return 'Table'
    case 'code':
      return 'Code'
    case 'embed':
      return 'Embed'
  }
}

/** The first title-role text box's text, or the first text box's, as the slide's title. */
export function slideTitle(slide: Slide): string {
  const title = slide.elements.find((e) => e.type === 'text' && e.role === 'title')
  if (title && title.type === 'text') return richToPlain(title.content)
  const first = slide.elements.find((e) => e.type === 'text')
  return first && first.type === 'text' ? richToPlain(first.content) : ''
}

// ---------------------------------------------------------------------------
// Clipboard. Elements copied in this tab are kept in memory, and also written
// to the system clipboard as JSON with a marker, so they paste into another tab.
// ---------------------------------------------------------------------------

const CLIPBOARD_MARKER = 'sleid-elements/v1'
let internalClipboard: Element[] = []

export function setInternalClipboard(elements: Element[]) {
  internalClipboard = elements.map((el) => structuredClone(el))
}

export function getInternalClipboard(): Element[] {
  return internalClipboard.map((el) => structuredClone(el))
}

export function serializeClipboard(elements: Element[]): string {
  return JSON.stringify({ marker: CLIPBOARD_MARKER, elements })
}

/** Elements from a system clipboard string, or null when it is not ours. */
export function parseClipboard(text: string): Element[] | null {
  try {
    const parsed = JSON.parse(text) as { marker?: unknown; elements?: unknown }
    if (parsed.marker !== CLIPBOARD_MARKER || !Array.isArray(parsed.elements)) return null
    const elements: Element[] = []
    for (const raw of parsed.elements) {
      const result = ElementSchema.safeParse(raw)
      if (!result.success) return null
      elements.push(result.data)
    }
    return elements
  } catch {
    return null
  }
}

/** Input for addElement: id and z are reassigned, so pasted copies do not clash. */
export function asNewElement(el: Element, dx = 0, dy = 0): ElementDraft {
  const { id: _id, z: _z, ...rest } = el as Element & Record<string, unknown>
  return { ...rest, x: el.x + dx, y: el.y + dy } as ElementDraft
}

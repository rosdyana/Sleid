import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createDeck, createSlide, CHART_TYPES, type ChartElement, type Deck } from '@sleid/model'
import { fullDeck } from '../../model/src/fixtures.ts'
import { deckToPptx, type PptxAsset } from './index.ts'

// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG: PptxAsset = { data: Uint8Array.from(Buffer.from(PNG_B64, 'base64')), mime: 'image/png' }

async function resolveAsset(src: string): Promise<PptxAsset | null> {
  return src.startsWith('data:') || src.startsWith('/api/assets/') ? PNG : null
}

async function open(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files)
  const read = async (name: string) => {
    const file = zip.file(name)
    if (!file) throw new Error(`missing part ${name}`)
    return file.async('string')
  }
  return { zip, names, read }
}

function slideNumbersWithText(names: string[]): string[] {
  return names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
}

/** The fixture deck, with its image pointed at an asset URL so the resolver supplies bytes. */
function coverageDeck(): Deck {
  const deck = fullDeck()
  for (const slide of deck.slides) {
    for (const el of slide.elements) {
      if (el.type === 'image') el.src = '/api/assets/0f3c9a52-1b2c-4d5e-8f90-a1b2c3d4e5f6'
    }
  }
  return deck
}

describe('deckToPptx', () => {
  it('writes one part per slide, with text runs, notes, media, hidden flags and positions', async () => {
    const bytes = await deckToPptx(coverageDeck(), { resolveAsset, rasterizeDiagram: async () => PNG })
    const { names, read } = await open(bytes)

    const slides = slideNumbersWithText(names)
    expect(slides).toHaveLength(3)

    const second = await read('ppt/slides/slide2.xml')
    expect(second).toContain('<a:t>Heading</a:t>')
    expect(second).toMatch(/<a:rPr[^>]*b="1"[^>]*>[\s\S]*?<a:t>bold<\/a:t>/)
    expect(second).toContain('<a:t>first</a:t>')
    expect(second).toContain('<a:t>a link</a:t>')
    expect(second).toContain('https://example.com')
    expect(second).toContain('<a:t>in a box</a:t>')
    expect(second).toContain('buChar') // bulleted list

    // Speaker notes become notes slides.
    const notes = names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    expect(notes.length).toBeGreaterThanOrEqual(1)
    const noteTexts = await Promise.all(notes.map((n) => read(n)))
    expect(noteTexts.some((x) => x.includes('Speaker notes'))).toBe(true)

    // Images end up in the media folder.
    expect(names.some((n) => n.startsWith('ppt/media/'))).toBe(true)

    // The hidden slide keeps its place and gets show="0".
    const hidden = await read('ppt/slides/slide3.xml')
    expect(hidden).toMatch(/<p:sld show="0"/)
    expect(await read('ppt/slides/slide2.xml')).not.toMatch(/<p:sld show=/)
  })

  it('converts canvas pixels to EMU at 1920 px = 13.333 in (about 6349.8 EMU per px)', async () => {
    const EMU_PER_PX = (13.333 * 914400) / 1920
    const bytes = await deckToPptx(coverageDeck(), { resolveAsset, rasterizeDiagram: async () => PNG })
    const { read } = await open(bytes)
    const second = await read('ppt/slides/slide2.xml')
    // The text element at x=100, y=100 px.
    const offsets = [...second.matchAll(/<a:off x="(\d+)" y="(\d+)"\/>/g)].map((m): [number, number] => [Number(m[1]), Number(m[2])])
    const at = (px: number) => Math.round(px * EMU_PER_PX)
    const match = offsets.find(([x, y]) => Math.abs(x - at(100)) <= 20 && Math.abs(y - at(100)) <= 20)
    expect(match, `no offset near ${at(100)} in ${JSON.stringify(offsets.slice(0, 6))}`).toBeDefined()
    // The shape at x=900, y=100 px, 400 px wide.
    const shape = [...second.matchAll(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((m): [number, number, number, number] => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
    expect(shape.find(([x, y, cx]) => Math.abs(x - at(900)) <= 20 && Math.abs(y - at(100)) <= 20 && Math.abs(cx - at(400)) <= 20)).toBeDefined()
  })

  it('the 16:9 layout is 13.333 x 7.5 in', async () => {
    const bytes = await deckToPptx(createDeck('Layout'))
    const { read } = await open(bytes)
    const presentation = await read('ppt/presentation.xml')
    expect(presentation).toMatch(/<p:sldSz cx="12191695" cy="6858000"|<p:sldSz cx="12192000" cy="6858000"/)
  })

  it('writes a native chart part for every chart type', async () => {
    const deck = createDeck('Charts')
    const slide = createSlide('blank', deck.theme)
    slide.elements = CHART_TYPES.map((chartType, i) => ({
      id: `chart-${chartType}`,
      type: 'chart',
      chartType,
      x: (i % 4) * 460,
      y: Math.floor(i / 4) * 500,
      w: 440,
      h: 480,
      z: i,
      rotation: 0,
      locked: false,
      opacity: 1,
      data:
        chartType === 'scatter'
          ? { columns: ['X', 'Y'], rows: [[1, 2], [2, 3], [3, null]] }
          : { columns: ['Quarter', 'Sales', 'Costs'], rows: [['Q1', 10, 4], ['Q2', 14, null], ['Q3', 9, 6]] },
      options: { title: `Chart ${chartType}`, legend: true },
    })) as ChartElement[]
    deck.slides = [slide]
    const bytes = await deckToPptx(deck)
    const { names, read } = await open(bytes)
    const charts = names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))
    expect(charts).toHaveLength(CHART_TYPES.length)
    const kinds = await Promise.all(charts.map((c) => read(c)))
    expect(kinds.some((x) => x.includes('<c:pieChart>'))).toBe(true)
    expect(kinds.some((x) => x.includes('<c:doughnutChart>'))).toBe(true)
    expect(kinds.some((x) => x.includes('<c:scatterChart>'))).toBe(true)
    expect(kinds.some((x) => x.includes('<c:areaChart>'))).toBe(true)
    expect(kinds.some((x) => x.includes('<c:lineChart>'))).toBe(true)
    expect(kinds.some((x) => x.includes('<c:barChart>') && x.includes('stacked'))).toBe(true)
    // The data values reach the chart part.
    expect(kinds.some((x) => x.includes('<c:v>14</c:v>'))).toBe(true)
  })

  it('tables, code and embeds become native table, monospace text and a link', async () => {
    const deck = createDeck('Table')
    const slide = createSlide('blank', deck.theme)
    slide.elements = [
      { id: 't', type: 'table', x: 0, y: 0, w: 800, h: 200, z: 0, rotation: 0, locked: false, opacity: 1, rows: [['Name', 'Score'], ['Ada', '10']], header: true, style: { headerFill: '#eeeeee' } },
      { id: 'c', type: 'code', x: 0, y: 300, w: 800, h: 200, z: 1, rotation: 0, locked: false, opacity: 1, code: 'const x = 1\nconst y = 2', language: 'ts' },
      { id: 'e', type: 'embed', x: 0, y: 600, w: 640, h: 360, z: 2, rotation: 0, locked: false, opacity: 1, url: 'https://example.com/embed' },
    ]
    deck.slides = [slide]
    const { read } = await open(await deckToPptx(deck))
    const xml = await read('ppt/slides/slide1.xml')
    expect(xml).toContain('<a:tbl>')
    expect(xml).toContain('<a:t>Ada</a:t>')
    expect(xml).toContain('Consolas')
    expect(xml).toContain('const y = 2')
    expect(xml).toContain('https://example.com/embed')
  })

  it('shapes map to DrawingML preset geometries', async () => {
    const deck = createDeck('Shapes')
    const slide = createSlide('blank', deck.theme)
    const kinds = ['rect', 'roundRect', 'ellipse', 'triangle', 'arrow', 'line', 'star'] as const
    slide.elements = kinds.map((shape, i) => ({
      id: `s-${shape}`,
      type: 'shape',
      shape,
      x: i * 200,
      y: 100,
      w: 180,
      h: 120,
      z: i,
      rotation: 0,
      locked: false,
      opacity: 0.5,
      fill: '#0b57d0',
      stroke: '#202124',
      strokeWidth: 3,
    }))
    deck.slides = [slide]
    const { read } = await open(await deckToPptx(deck))
    const xml = await read('ppt/slides/slide1.xml')
    for (const preset of ['rect', 'roundRect', 'ellipse', 'triangle', 'rightArrow', 'line', 'star5']) {
      expect(xml).toContain(`prst="${preset}"`)
    }
    // Opacity 0.5 becomes 50% transparency on the fill.
    expect(xml).toMatch(/<a:alpha val="50000"\/>/)
  })

  it('diagrams use the rasterized PNG when given, and the placeholder (never the source) when not', async () => {
    const deck = createDeck('Diagrams')
    const slide = createSlide('blank', deck.theme)
    slide.elements = [{ id: 'd', type: 'diagram', source: 'graph TD; A-->B', x: 0, y: 0, w: 300, h: 300, z: 0, rotation: 0, locked: false, opacity: 1 }]
    deck.slides = [slide]
    const withPng = await open(await deckToPptx(deck, { rasterizeDiagram: async () => PNG }))
    expect(withPng.names.some((n) => n.startsWith('ppt/media/'))).toBe(true)
    const withoutPng = await open(await deckToPptx(deck))
    const xml = await withoutPng.read('ppt/slides/slide1.xml')
    expect(xml).toContain('Diagram could not be drawn')
    // The source is not shown, and no monospace text is written for it.
    expect(xml).not.toContain('graph TD')
    expect(xml).not.toContain('A--&gt;B')
    expect(xml).not.toContain('Consolas')
  })

  it('font sizes convert from px to pt at 0.5 pt per px', async () => {
    const deck = fullDeck()
    const { read } = await open(await deckToPptx(deck))
    // Heading and body text box are 40 px, which is 20 pt: sz="2000".
    expect(await read('ppt/slides/slide2.xml')).toContain('sz="2000"')
  })
})

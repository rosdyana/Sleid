import { describe, expect, it } from 'vitest'
import { createDeck, type ChartElement, type Deck, type Element, type Slide, type TextElement } from '@sleid/model'
import { chartToEchartsOption, googleFontsHref, renderChartSvg, renderDeckHtml, renderSlideHtml } from './render.ts'
import { renderStandaloneDeckHtml } from './render-node.ts'
import { BASE_CSS } from './styles.ts'
import { richTextToHtml } from './rich-text.ts'

const base = { rotation: 0, locked: false, opacity: 1, z: 0 }

function textEl(id: string, content: TextElement['content'], overrides: Partial<TextElement> = {}): TextElement {
  return {
    ...base,
    id,
    type: 'text',
    x: 10,
    y: 20,
    w: 300,
    h: 100,
    role: 'body',
    style: { align: 'left', valign: 'top' },
    content,
    ...overrides,
  } as TextElement
}

function chartEl(chartType: ChartElement['chartType'], rows: ChartElement['data']['rows'], columns = ['cat', 'a', 'b']): ChartElement {
  return {
    ...base,
    id: `chart-${chartType}`,
    type: 'chart',
    x: 0,
    y: 0,
    w: 800,
    h: 500,
    chartType,
    data: { columns, rows },
    options: { legend: true },
  }
}

function slideWith(elements: Element[], overrides: Partial<Slide> = {}): Slide {
  return {
    id: 'slide-1',
    layout: 'blank',
    notes: '',
    transition: 'none',
    autoAnimate: false,
    hidden: false,
    elements,
    ...overrides,
  }
}

function deckWith(slides: Slide[]): Deck {
  const deck = createDeck('Render test')
  return { ...deck, slides }
}

describe('renderSlideHtml', () => {
  it('emits a section with the stage, transition, auto-animate, hidden and notes', () => {
    const deck = deckWith([])
    const html = renderSlideHtml(
      slideWith([textEl('t1', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] })], {
        transition: 'fade',
        autoAnimate: true,
        hidden: true,
        notes: 'Say hello',
      }),
      deck,
    )
    expect(html.startsWith('<section ')).toBe(true)
    expect(html).toContain('data-transition="fade"')
    expect(html).toContain('data-auto-animate')
    expect(html).toContain('data-visibility="hidden"')
    expect(html).toContain('<div class="sleid-stage">')
    expect(html).toContain('<aside class="notes">Say hello</aside>')
    expect(html).toContain('<p>Hello</p>')
  })

  it('positions elements absolutely in the 1920x1080 coordinate space', () => {
    const html = renderSlideHtml(slideWith([textEl('t1', { type: 'doc', content: [] }, { x: 111, y: 222, w: 333, h: 444 })]), deckWith([]))
    expect(html).toContain('left:111px;top:222px;width:333px;height:444px')
    expect(html).toContain('data-id="t1"')
  })

  it('maps element animation to reveal fragment classes and data-fragment-index', () => {
    const html = renderSlideHtml(
      slideWith([textEl('t1', { type: 'doc', content: [] }, { animation: { effect: 'fade-up', order: 2 } })]),
      deckWith([]),
    )
    expect(html).toMatch(/class="sleid-el sleid-text-el fragment fade-up"[^>]*data-fragment-index="2"/)
  })

  it('renders slides in z-order', () => {
    const html = renderSlideHtml(
      slideWith([
        textEl('top', { type: 'doc', content: [] }, { z: 5 }),
        textEl('bottom', { type: 'doc', content: [] }, { z: 1 }),
      ]),
      deckWith([]),
    )
    expect(html.indexOf('data-id="bottom"')).toBeLessThan(html.indexOf('data-id="top"'))
  })

  it('escapes the speaker notes', () => {
    const html = renderSlideHtml(slideWith([], { notes: '<img src=x onerror=alert(1)>' }), deckWith([]))
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('XSS and sanitising', () => {
  it('renders a script tag in text as inert text', () => {
    const html = renderSlideHtml(
      slideWith([textEl('t1', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }] })]),
      deckWith([]),
    )
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('drops a javascript: link and keeps its text', () => {
    const html = renderSlideHtml(
      slideWith([
        textEl('t1', {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
            },
          ],
        }),
      ]),
      deckWith([]),
    )
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<a ')
    expect(html).toContain('click')
  })

  it('keeps an https link, and marks it rel="noopener noreferrer"', () => {
    const html = renderSlideHtml(
      slideWith([
        textEl('t1', {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com/a?b=1' } }] }],
            },
          ],
        }),
      ]),
      deckWith([]),
    )
    expect(html).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">docs</a>')
  })

  it('does not let an element id break out of its attribute', () => {
    const html = renderSlideHtml(slideWith([textEl('x"onmouseover="alert(1)', { type: 'doc', content: [] })]), deckWith([]))
    expect(html).not.toContain('onmouseover="alert')
    expect(html).toContain('data-id="x&quot;onmouseover=&quot;alert(1)"')
  })

  it('blocks javascript: image sources and embeds', () => {
    const html = renderSlideHtml(
      slideWith([
        { ...base, id: 'img', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)', fit: 'cover' },
        { ...base, id: 'emb', type: 'embed', x: 0, y: 0, w: 10, h: 10, url: 'javascript:alert(1)' },
      ]),
      deckWith([]),
    )
    expect(html).not.toContain('javascript:')
    expect(html).toContain('sleid-embed-blocked')
    expect(html).toContain('sleid-image-empty')
  })

  it('sandboxes a valid embed', () => {
    const html = renderSlideHtml(
      slideWith([{ ...base, id: 'emb', type: 'embed', x: 0, y: 0, w: 10, h: 10, url: 'https://example.com/v' }]),
      deckWith([]),
    )
    expect(html).toContain('<iframe class="sleid-embed" src="https://example.com/v" sandbox="allow-scripts allow-popups allow-presentation"')
  })

  it('escapes code and diagram source', () => {
    const html = renderSlideHtml(
      slideWith([
        { ...base, id: 'code', type: 'code', x: 0, y: 0, w: 10, h: 10, code: '<b>x</b>', language: 'ts"><script>' },
        { ...base, id: 'dia', type: 'diagram', x: 0, y: 0, w: 10, h: 10, source: 'A-->B</pre><script>alert(1)</script>' },
      ]),
      deckWith([]),
    )
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('<pre class="mermaid sleid-diagram">A--&gt;B&lt;/pre&gt;')
  })

  it('drops unsafe CSS values from text styles', () => {
    const html = renderSlideHtml(
      slideWith([
        textEl('t1', { type: 'doc', content: [] }, {
          style: { align: 'left', valign: 'top', color: 'red;background:url(//evil)', fontFamily: 'Inter; } body { display:none' },
        }),
      ]),
      deckWith([]),
    )
    expect(html).not.toContain('evil')
    expect(html).not.toContain('display:none')
  })
})

describe('charts', () => {
  const theme = createDeck('t').theme

  it('bar chart has one series per value column', () => {
    const option = chartToEchartsOption(chartEl('bar', [['Q1', 1, 2], ['Q2', 3, null]]), theme) as { series: unknown[] }
    expect(option.series).toHaveLength(2)
    expect(option).toMatchObject({ xAxis: { type: 'category', data: ['Q1', 'Q2'] } })
  })

  it('pie chart has one series with one data point per row', () => {
    const option = chartToEchartsOption(chartEl('pie', [['A', 4, 1], ['B', 6, 2], ['C', 2, 3]]), theme) as {
      series: Array<{ type: string; data: unknown[] }>
    }
    expect(option.series).toHaveLength(1)
    expect(option.series[0]).toMatchObject({ type: 'pie', data: [{ name: 'A', value: 4 }, { name: 'B', value: 6 }, { name: 'C', value: 2 }] })
  })

  it('donut uses a ring radius and stacked-bar sets a stack key', () => {
    const donut = chartToEchartsOption(chartEl('donut', [['A', 1]], ['c', 'v']), theme) as { series: Array<{ radius: unknown }> }
    expect(donut.series[0]!.radius).toEqual(['40%', '70%'])
    const stacked = chartToEchartsOption(chartEl('stacked-bar', [['A', 1, 2]]), theme) as { series: Array<{ stack?: string }> }
    expect(stacked.series.every((s) => s.stack === 'total')).toBe(true)
  })

  it('echartsOverride is merged last', () => {
    const el = { ...chartEl('bar', [['A', 1, 2]]), echartsOverride: { backgroundColor: '#123456' } }
    const option = chartToEchartsOption(el, theme) as { backgroundColor: string }
    expect(option.backgroundColor).toBe('#123456')
  })

  it('renders an SVG string sized to the element', () => {
    const svg = renderChartSvg(chartEl('bar', [['Q1', 1, 2], ['Q2', 3, 4]]), theme)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('width="800"')
  })

  it('does not pass a script in a category label into the SVG', () => {
    const svg = renderChartSvg(chartEl('bar', [['<script>alert(1)</script>', 1, 2]]), theme)
    expect(svg).not.toContain('<script')
  })

  it('embeds the chart SVG in the slide', () => {
    const html = renderSlideHtml(slideWith([chartEl('line', [['Q1', 1, 2]])]), deckWith([]))
    expect(html).toContain('<div class="sleid-chart"><svg')
  })
})

describe('renderDeckHtml', () => {
  const deck = deckWith([slideWith([textEl('t1', { type: 'doc', content: [] })]), slideWith([chartEl('bar', [['A', 1, 2]])], { id: 's2' })])

  it('present mode loads reveal from the pinned CDN with the 1920x1080 config', () => {
    const html = renderDeckHtml(deck, { mode: 'present' })
    expect(html).toContain('https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/dist/reveal.js')
    expect(html).toContain('width: 1920, height: 1080, margin: 0, hash: true, plugins: [RevealNotes]')
    expect(html).toContain('<div class="reveal"><div class="slides">')
    expect(html.match(/<section /g)).toHaveLength(2)
  })

  it('emits theme tokens as CSS variables', () => {
    const html = renderDeckHtml(deck, { mode: 'present' })
    expect(html).toContain(`--sleid-accent: ${deck.theme.colors.accent};`)
    expect(html).toContain('--sleid-font-body: Inter, sans-serif;')
  })

  it('print mode hides controls and progress', () => {
    const html = renderDeckHtml(deck, { mode: 'print' })
    expect(html).toContain('controls: false, progress: false')
  })

  it('standalone mode refuses to render without inlined assets', () => {
    expect(() => renderDeckHtml(deck, { mode: 'standalone' })).toThrow(/standalone mode needs reveal.js assets/)
  })

  it('standalone mode inlines the supplied reveal assets and omits the CDN scripts', () => {
    const html = renderDeckHtml(deck, {
      mode: 'standalone',
      assets: { revealCss: '.reveal{color:red}', revealJs: 'window.Reveal={}', notesJs: 'window.RevealNotes={}' },
    })
    expect(html).toContain('.reveal{color:red}')
    expect(html).toContain('window.Reveal={}')
    expect(html).not.toContain('cdn.jsdelivr.net/npm/reveal.js')
  })

  it('refuses to inline reveal assets that contain a closing script tag', () => {
    expect(() =>
      renderDeckHtml(deck, { mode: 'standalone', assets: { revealCss: '', revealJs: '</script><script>x()', notesJs: '' } }),
    ).toThrow(/closing <\/script>/)
  })

  it('standalone (Node) output inlines the real reveal.js files', () => {
    const html = renderStandaloneDeckHtml(deck)
    expect(html).toContain('Reveal.initialize({ width: 1920')
    expect(html).toContain('RevealNotes')
    expect(html).not.toContain('cdn.jsdelivr.net/npm/reveal.js')
    expect(html).not.toContain('mermaid')
  })

  it('loads mermaid only in standalone output, and only when a deck has a diagram', () => {
    const withDiagram = deckWith([slideWith([{ ...base, id: 'd', type: 'diagram', x: 0, y: 0, w: 10, h: 10, source: 'graph TD; A-->B' }])])
    expect(renderDeckHtml(withDiagram, { mode: 'present' })).not.toContain('mermaid.esm')
    const standalone = renderStandaloneDeckHtml(withDiagram)
    expect(standalone).toContain('mermaid.esm.min.mjs')
    expect(standalone).toContain('<pre class="mermaid sleid-diagram">graph TD; A--&gt;B</pre>')
  })

  it('escapes the deck title', () => {
    const html = renderDeckHtml({ ...deck, title: '<img src=x onerror=alert(1)>' }, { mode: 'present' })
    expect(html).toContain('<title>&lt;img src=x onerror=alert(1)&gt;</title>')
  })
})

// M9: a table header's text is readable on its fill, and mermaid is themed from the deck.
describe('table headers and diagram theme (M9)', () => {
  const tableOn = (headerFill: string) =>
    slideWith([{ ...base, id: 't', type: 'table', x: 0, y: 0, w: 400, h: 200, rows: [['Quarter', 'Revenue'], ['Q1', '10']], header: true, style: { headerFill } } as unknown as Element])

  it('a dark header fill gets a light header text, and a light fill keeps a dark one', () => {
    const dark = renderSlideHtml(tableOn('#1a73e8'), deckWith([]))
    expect(dark).toMatch(/<th style="background:#1a73e8;\s?color:#ffffff">/)
    const light = renderSlideHtml(tableOn('#eeeeee'), deckWith([]))
    const headerColour = /<th style="background:#eeeeee;\s?color:(#[0-9a-f]{6})">/i.exec(light)?.[1]
    expect(headerColour).toBeDefined()
    expect(headerColour).not.toBe('#ffffff')
  })

  it('mermaid is initialised with the deck theme (base theme, the deck colours and font), so dark decks get light diagrams', () => {
    const deck = deckWith([slideWith([{ ...base, id: 'd', type: 'diagram', x: 0, y: 0, w: 10, h: 10, source: 'graph TD; A-->B' }])])
    const dark = { ...deck, theme: { ...deck.theme, colors: { ...deck.theme.colors, background: '#0b1020', surface: '#151c33', text: '#f5f5f5', muted: '#9aa4c7', accent: '#3d5afe' } } }
    const html = renderStandaloneDeckHtml(dark)
    expect(html).toContain('"theme":"base"')
    expect(html).toContain('"mainBkg":"#151c33"')
    expect(html).toContain('"textColor":"#f5f5f5"')
    expect(html).not.toContain("mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })")
  })
})

// ---------------------------------------------------------------------------
// M10 fidelity: typography, shapes, gradients, shadows, vectors, animate keys, fonts
// ---------------------------------------------------------------------------

function shapeEl(overrides: Record<string, unknown>): Element {
  return {
    ...base,
    id: 'shape-1',
    type: 'shape',
    x: 0,
    y: 0,
    w: 400,
    h: 200,
    shape: 'rect',
    fill: '#ff0000',
    stroke: '#000000',
    strokeWidth: 0,
    ...overrides,
  } as Element
}

function imageEl(overrides: Record<string, unknown> = {}): Element {
  return {
    ...base,
    id: 'img-1',
    type: 'image',
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    src: 'https://example.com/a.png',
    fit: 'cover',
    ...overrides,
  } as Element
}

function vectorEl(paths: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Element {
  return {
    ...base,
    id: 'vec-1',
    type: 'vector',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    viewBox: { x: 0, y: 0, w: 24, h: 24 },
    paths: paths.map((p) => ({ d: 'M0 0L24 24', fill: '#112233', stroke: 'none', strokeWidth: 0, ...p })),
    preserveAspectRatio: true,
    ...overrides,
  } as Element
}

function htmlOf(el: Element): string {
  return renderSlideHtml(slideWith([el]), deckWith([]))
}

describe('M10 typography', () => {
  it('emits weight, letter spacing, text transform and text shadow on the text box', () => {
    const el = textEl('t1', { type: 'doc', content: [] } as TextElement['content'], {
      style: {
        align: 'left',
        valign: 'top',
        fontWeight: 700,
        letterSpacing: 0.14,
        textTransform: 'uppercase',
      },
      shadow: { x: 2, y: 4, blur: 8, color: 'rgba(0,0,0,0.4)' },
    })
    const html = htmlOf(el)
    expect(html).toContain('font-weight:700')
    expect(html).toContain('letter-spacing:0.14em')
    expect(html).toContain('text-transform:uppercase')
    expect(html).toContain('text-shadow:2px 4px 8px rgba(0,0,0,0.4)')
  })

  it('drops an out-of-range weight and a bad shadow colour', () => {
    const el = textEl('t2', { type: 'doc', content: [] } as TextElement['content'], {
      style: { align: 'left', valign: 'top', fontWeight: 1200 },
      shadow: { x: 0, y: 0, blur: 0, color: 'red;}body{' },
    })
    const html = htmlOf(el)
    expect(html).not.toContain('font-weight:1200')
    expect(html).toContain('text-shadow:0px 0px 0px transparent')
    expect(html).not.toContain('red;}')
  })

  it('applies mark weight and letter spacing, and rejects unsafe values', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'textStyle', attrs: { fontWeight: 600, letterSpacing: '0.14em' } }] },
            { type: 'text', text: 'b', marks: [{ type: 'textStyle', attrs: { fontWeight: 'bold', letterSpacing: '-0.02em' } }] },
            { type: 'text', text: 'c', marks: [{ type: 'textStyle', attrs: { fontWeight: 'x; color:red', letterSpacing: '50%' } }] },
            { type: 'text', text: 'd', marks: [{ type: 'textStyle', attrs: { letterSpacing: '2rem' } }] },
            { type: 'text', text: 'e', marks: [{ type: 'textStyle', attrs: { fontWeight: '650' } }] },
            { type: 'text', text: 'f', marks: [{ type: 'textStyle', attrs: { fontWeight: '1200' } }] },
          ],
        },
      ],
    }
    const html = richTextToHtml(doc as never)
    expect(html).toContain('font-weight:600')
    // The editor stores weights read from HTML as strings.
    expect(html).toContain('font-weight:650')
    expect(html).not.toContain('font-weight:1200')
    expect(html).toContain('letter-spacing:0.14em')
    expect(html).toContain('font-weight:bold')
    expect(html).toContain('letter-spacing:-0.02em')
    expect(html).not.toContain('color:red')
    expect(html).not.toContain('50%')
    expect(html).not.toContain('2rem')
  })
})

describe('M10 shapes', () => {
  it('draws rect, roundRect and ellipse as styled boxes with the legacy corner when radius is absent', () => {
    const rect = htmlOf(shapeEl({ shape: 'rect', fill: '#ff0000', radius: 6 }))
    expect(rect).toContain('sleid-shape-box')
    expect(rect).toContain('background-color:#ff0000')
    expect(rect).toContain('border-radius:6px')

    expect(htmlOf(shapeEl({ shape: 'roundRect' }))).toContain('border-radius:12%')
    expect(htmlOf(shapeEl({ shape: 'roundRect', radius: 24 }))).toContain('border-radius:24px')
    expect(htmlOf(shapeEl({ shape: 'ellipse' }))).toContain('border-radius:50%')
  })

  it('draws a dashed border, a dotted border and a box shadow', () => {
    const dashed = htmlOf(shapeEl({ shape: 'roundRect', strokeWidth: 3, stroke: '#00ff00', strokeDash: 'dashed' }))
    expect(dashed).toContain('border:3px dashed #00ff00')
    expect(htmlOf(shapeEl({ shape: 'rect', strokeWidth: 2, stroke: '#000000', strokeDash: 'dotted' }))).toContain('border:2px dotted #000000')
    const shadowed = htmlOf(shapeEl({ shape: 'rect', shadow: { x: 0, y: 10, blur: 20, spread: 2, color: 'rgba(0,0,0,0.3)' } }))
    expect(shadowed).toContain('box-shadow:0px 10px 20px 2px rgba(0,0,0,0.3)')
  })

  it('builds a linear gradient from the stops, with the angle, and a radial one', () => {
    const linear = htmlOf(
      shapeEl({
        shape: 'rect',
        gradient: {
          type: 'linear',
          angle: 90,
          stops: [
            { color: '#111111', at: 0 },
            { color: '#eeeeee', at: 0.5 },
          ],
        },
      }),
    )
    expect(linear).toContain('background:linear-gradient(90deg, #111111 0%, #eeeeee 50%)')

    const radial = htmlOf(
      shapeEl({
        shape: 'ellipse',
        gradient: {
          type: 'radial',
          stops: [
            { color: '#ffffff', at: 0 },
            { color: '#000000', at: 1 },
          ],
        },
      }),
    )
    expect(radial).toContain('radial-gradient(circle, #ffffff 0%, #000000 100%)')
  })

  it('drops a bad colour stop, and falls back to the flat fill when fewer than two stops remain', () => {
    const mixed = htmlOf(
      shapeEl({
        shape: 'rect',
        gradient: {
          type: 'linear',
          stops: [
            { color: 'red" onload="x', at: 0 },
            { color: '#0000ff', at: 0.2 },
            { color: '#00ff00', at: 1 },
          ],
        },
      }),
    )
    expect(mixed).toContain('linear-gradient(180deg, #0000ff 20%, #00ff00 100%)')
    expect(mixed).not.toContain('onload')

    const oneLeft = htmlOf(
      shapeEl({
        shape: 'rect',
        fill: '#abcdef',
        gradient: {
          type: 'linear',
          stops: [
            { color: 'javascript:alert(1)', at: 0 },
            { color: '#0000ff', at: 1 },
          ],
        },
      }),
    )
    expect(oneLeft).toContain('background-color:#abcdef')
    expect(oneLeft).not.toContain('linear-gradient')
  })

  it('keeps dash, gradient and shadow on the SVG shapes', () => {
    const tri = htmlOf(shapeEl({ shape: 'triangle', strokeWidth: 2, stroke: '#000000', strokeDash: 'dashed' }))
    expect(tri).toContain('stroke-dasharray="6 4"')
    const dot = htmlOf(shapeEl({ shape: 'star', strokeWidth: 2, stroke: '#000000', strokeDash: 'dotted' }))
    expect(dot).toContain('stroke-dasharray="0 4"')
    expect(dot).toContain('stroke-linecap="round"')
    const grad = htmlOf(
      shapeEl({
        shape: 'arrow',
        fill: '#999999',
        gradient: {
          type: 'linear',
          stops: [
            { color: '#123456', at: 0 },
            { color: '#654321', at: 1 },
          ],
        },
      }),
    )
    expect(grad).toContain('fill="#123456"')
    const shadowed = htmlOf(shapeEl({ shape: 'triangle', shadow: { x: 3, y: 4, blur: 5, color: '#000000' } }))
    expect(shadowed).toContain('filter:drop-shadow(3px 4px 5px #000000)')
  })
})

describe('M10 images', () => {
  it('rounds the wrapper and adds a shadow', () => {
    const html = htmlOf(imageEl({ radius: 32, shadow: { x: 0, y: 6, blur: 12, color: '#000000' } }))
    expect(html).toContain('border-radius:32px')
    expect(html).toContain('overflow:hidden')
    expect(html).toContain('box-shadow:0px 6px 12px 0px #000000')
  })
})

describe('M10 vector icons', () => {
  it('renders one path per entry with the viewBox and aspect mode', () => {
    const html = htmlOf(
      vectorEl(
        [
          { d: 'M0 0L24 24', fill: '#112233', lineCap: 'round', lineJoin: 'bevel', opacity: 0.5 },
          { d: 'M2 2h20v20H2z', fill: 'none', stroke: '#ff0000', strokeWidth: 2 },
        ],
        { preserveAspectRatio: false },
      ),
    )
    expect(html).toContain('<svg class="sleid-vector" viewBox="0 0 24 24" preserveAspectRatio="none"')
    expect(html).toContain('<path d="M0 0L24 24" fill="#112233" stroke="transparent"')
    expect(html).toContain('stroke-linecap="round"')
    expect(html).toContain('stroke-linejoin="bevel"')
    expect(html).toContain('opacity="0.5"')
    expect(html).toContain('d="M2 2h20v20H2z" fill="transparent" stroke="#ff0000" stroke-width="2"')
  })

  it('keeps xMidYMid meet when the aspect is preserved', () => {
    expect(htmlOf(vectorEl([{}]))).toContain('preserveAspectRatio="xMidYMid meet"')
  })

  it('drops a path whose d fails the check, and sanitises paints', () => {
    const html = htmlOf(
      vectorEl([
        { d: 'M0 0" onload="alert(1)' },
        { d: 'M1 1L2 2', fill: 'red" onmouseover="x', stroke: '#00ff00' },
      ]),
    )
    expect(html).not.toContain('onload')
    expect(html).not.toContain('onmouseover')
    expect(html).toContain('d="M1 1L2 2"')
    expect(html.match(/<path /g)?.length).toBe(1)
  })
})

describe('M10 animations and auto-animate keys', () => {
  it('uses animateKey as data-id and keeps the real id in data-el', () => {
    const html = htmlOf(imageEl({ id: 'real-1', animateKey: 'hero' }))
    expect(html).toContain('data-id="hero"')
    expect(html).toContain('data-el="real-1"')
    expect(htmlOf(imageEl({ id: 'real-2' }))).toContain('data-id="real-2"')
  })

  it('maps the exit effects to reveal classes and wipe to sleid-wipe', () => {
    for (const effect of ['fade-out', 'current-visible', 'fade-in-then-out', 'semi-fade-out'] as const) {
      const html = htmlOf(imageEl({ animation: { effect, order: 0 } }))
      expect(html).toContain(`fragment ${effect}`)
    }
    expect(htmlOf(imageEl({ animation: { effect: 'wipe', order: 0 } }))).toContain('fragment sleid-wipe')
  })

  it('styles the wipe fragment so it wins over reveal', () => {
    const css = BASE_CSS
    expect(css).toContain('.reveal .slides .fragment.sleid-wipe { opacity: 1; visibility: inherit; clip-path: inset(0 100% 0 0);')
    expect(css).toContain('.reveal .slides .fragment.sleid-wipe.visible { clip-path: inset(0 0 0 0); }')
  })
})

describe('M10 web fonts', () => {
  it('builds one css2 URL from fontImports, with spaces as + and the axis list kept', () => {
    const deck = deckWith([])
    const themed = { ...deck, theme: { ...deck.theme, fontImports: ['Inter:wght@400;600;700', 'Playfair Display'] } }
    const href = googleFontsHref(themed.theme)
    expect(href).toBe('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Playfair+Display&display=swap')
    expect(googleFontsHref(deck.theme)).toBeUndefined()
  })

  it('emits the stylesheet link in every mode, and drops a bad import', () => {
    const deck = deckWith([slideWith([textEl('t', { type: 'doc', content: [] } as TextElement['content'])])])
    const withFonts = {
      ...deck,
      theme: { ...deck.theme, fontImports: ['Inter:wght@400', 'Bad"><script>alert(1)</script>'] },
    }
    for (const mode of ['present', 'print'] as const) {
      const html = renderDeckHtml(withFonts as Deck, { mode })
      expect(html).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400&amp;display=swap">')
      expect(html).not.toContain('<script>alert')
    }
    const plain = renderDeckHtml(deck, { mode: 'present' })
    expect(plain).not.toContain('fonts.googleapis.com')
  })
})

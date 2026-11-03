import { describe, expect, it } from 'vitest'
import { createDeck, type ChartElement, type Deck, type Element, type Slide, type TextElement } from '@sleid/model'
import { chartToEchartsOption, renderChartSvg, renderDeckHtml, renderSlideHtml } from './render.ts'
import { renderStandaloneDeckHtml } from './render-node.ts'

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

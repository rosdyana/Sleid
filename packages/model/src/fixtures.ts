// Test fixture: a deck that uses every element type and the rich-text marks.
import { createDeck, layoutElements, type Deck, type Element, type Slide } from './index.ts'

export function fullDeck(): Deck {
  const deck = createDeck('Fixture deck')
  const theme = deck.theme
  const baseline = { rotation: 0, locked: false, opacity: 1, z: 0 }
  const elements: Element[] = [
    {
      ...baseline,
      id: 'txt-1',
      type: 'text',
      x: 100,
      y: 100,
      w: 800,
      h: 200,
      z: 0,
      role: 'body',
      style: { fontFamily: 'Inter', fontSize: 40, color: '#202124', align: 'left', valign: 'top', lineHeight: 1.4 },
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
              { type: 'text', text: ' and ' },
              {
                type: 'text',
                text: 'a link',
                marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener' } }],
              },
              { type: 'text', text: ' in red', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] },
            ],
          },
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
            ],
          },
        ],
      },
    },
    {
      ...baseline,
      id: 'shape-1',
      type: 'shape',
      shape: 'roundRect',
      x: 900,
      y: 100,
      w: 400,
      h: 200,
      z: 1,
      fill: theme.colors.accent,
      stroke: theme.colors.text,
      strokeWidth: 4,
      text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'in a box' }] }] },
      animation: { effect: 'fade-up', order: 0 },
    },
    {
      ...baseline,
      id: 'img-1',
      type: 'image',
      x: 0,
      y: 400,
      w: 600,
      h: 400,
      z: 2,
      src: 'https://example.com/a.png',
      fit: 'cover',
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      alt: 'An example image',
    },
    {
      ...baseline,
      id: 'chart-1',
      type: 'chart',
      x: 700,
      y: 400,
      w: 900,
      h: 500,
      z: 3,
      chartType: 'bar',
      data: {
        columns: ['Quarter', 'Sales', 'Costs'],
        rows: [
          ['Q1', 10, 4],
          ['Q2', 14, null],
          ['Q3', 9, 6],
        ],
      },
      options: { title: 'Revenue', legend: true, colors: ['#0b57d0', '#e37400'] },
      echartsOverride: { grid: { left: 80 } },
      animation: { effect: 'grow', order: 1 },
    },
    { ...baseline, id: 'dia-1', type: 'diagram', x: 0, y: 0, w: 300, h: 300, z: 4, source: 'graph TD; A-->B' },
    {
      ...baseline,
      id: 'tbl-1',
      type: 'table',
      x: 0,
      y: 0,
      w: 500,
      h: 200,
      z: 5,
      rows: [
        ['Name', 'Score'],
        ['Ada', '10'],
      ],
      header: true,
      style: { headerFill: '#eeeeee', borderWidth: 1 },
    },
    { ...baseline, id: 'code-1', type: 'code', x: 0, y: 0, w: 500, h: 200, z: 6, code: 'const x = 1', language: 'ts' },
    { ...baseline, id: 'emb-1', type: 'embed', x: 0, y: 0, w: 640, h: 360, z: 7, url: 'https://example.com/embed' },
  ]
  const slide: Slide = {
    id: 'slide-full',
    sectionId: undefined,
    layout: 'blank',
    background: { type: 'color', value: '#fafafa' },
    notes: 'Speaker notes\nsecond line',
    transition: 'slide',
    autoAnimate: true,
    hidden: false,
    elements,
  }
  deck.slides.push(slide)
  deck.slides.push({
    id: 'slide-placeholders',
    layout: 'two-column',
    notes: '',
    transition: 'none',
    autoAnimate: false,
    hidden: true,
    elements: layoutElements('two-column', theme, (i) => `ph-${i}`),
  })
  return deck
}

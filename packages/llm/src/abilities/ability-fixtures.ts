// A small deck for the ability tests: two slides, with text, a chart, an image and a diagram.
import { applyOps, createDeck, deckToYDoc, yDocToDeck, type Deck } from '@sleid/model'

export function fixtureDeck(): Deck {
  const deck = createDeck('Quarterly review')
  const doc = deckToYDoc(deck)
  applyOps(doc, [
    { op: 'addSlide', layout: 'title-content', slide: { id: 'slide-2', notes: 'old notes' } },
    {
      op: 'addElement',
      slideId: 'slide-2',
      element: {
        id: 'body-1',
        type: 'text',
        role: 'body',
        x: 120,
        y: 272,
        w: 1680,
        h: 600,
        rotation: 0,
        locked: false,
        opacity: 1,
        style: { fontSize: 40, align: 'left', valign: 'top', color: '#202124' },
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Revenue grew by a fifth this quarter across all regions.' }] }] },
      },
    },
    {
      op: 'addElement',
      slideId: 'slide-2',
      element: {
        id: 'chart-1',
        type: 'chart',
        chartType: 'bar',
        x: 900,
        y: 300,
        w: 900,
        h: 500,
        rotation: 0,
        locked: false,
        opacity: 1,
        data: { columns: ['Region', 'Sales'], rows: [['North', 10], ['South', 14]] },
        options: { title: 'Sales by region', legend: false },
      },
    },
    {
      op: 'addElement',
      slideId: 'slide-2',
      element: { id: 'img-1', type: 'image', x: 120, y: 300, w: 500, h: 400, rotation: 0, locked: false, opacity: 1, src: 'https://example.com/a.png', fit: 'cover' },
    },
    {
      op: 'addElement',
      slideId: 'slide-2',
      element: { id: 'dia-1', type: 'diagram', x: 300, y: 300, w: 400, h: 300, rotation: 0, locked: false, opacity: 1, source: 'graph TD; A-->B' },
    },
  ])
  return yDocToDeck(doc)
}

export function titleText(deck: Deck, slideId: string): string {
  const slide = deck.slides.find((s) => s.id === slideId)!
  const el = slide.elements.find((e) => e.type === 'text')
  return el && el.type === 'text' ? JSON.stringify(el.content) : ''
}

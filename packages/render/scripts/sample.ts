// Writes a 4-slide demo deck as standalone HTML, with reveal.js inlined.
// Run from the repo root: node packages/render/scripts/sample.ts [outPath]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDeck, createSlide, DEFAULT_THEME, type Element, type RichNode, type RichText, type Slide } from '@sleid/model'
import { renderStandaloneDeckHtml } from '../src/render-node.ts'

const DEFAULT_OUT =
  '/private/tmp/claude-501/-Users-rosdyanakusuma-Ross-projects-sleid/c1400ba8-0388-449b-ad43-785f923a7331/scratchpad/sample-deck.html'
const outPath = process.argv[2] ?? DEFAULT_OUT

const para = (text: string): RichNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const bullets = (items: string[]): RichNode => ({
  type: 'bulletList',
  content: items.map((t) => ({ type: 'listItem', content: [para(t)] })),
})
const doc = (...content: RichNode[]): RichText => ({ type: 'doc', content })

const base = { rotation: 0, locked: false, opacity: 1 }
const theme = DEFAULT_THEME
const deck = createDeck('Sleid demo')
type TextEl = Extract<Element, { type: 'text' }>

// Slide 1: title
const s1 = createSlide('title', theme)
const [t1, sub1] = s1.elements as [TextEl, TextEl]
t1.content = doc(para('Sleid demo deck'))
sub1.content = doc(para('Model, deck-ops and the reveal renderer (M1a)'))

// Slide 2: bullets, plus an animated callout that fades up on the first step
const s2: Slide = createSlide('title-content', theme)
s2.id = 'slide-bullets'
const [title2, body2] = s2.elements as [TextEl, TextEl]
title2.content = doc(para('Why one command layer'))
body2.content = doc(bullets(['Every change goes through typed deck-ops', 'The UI, the AI and MCP share one path', 'Yjs merges concurrent edits and undo works per origin']))
body2.h = 480
s2.elements.push({
  ...base,
  id: 'callout',
  type: 'shape',
  shape: 'roundRect',
  x: 1180,
  y: 760,
  w: 620,
  h: 200,
  z: 2,
  fill: theme.colors.accent,
  stroke: theme.colors.accent,
  strokeWidth: 0,
  text: doc(para('One command layer')),
  animation: { effect: 'fade-up', order: 0 },
})

// Slide 3: chart
const s3: Slide = createSlide('title-content', theme)
s3.id = 'slide-chart'
const [title3] = s3.elements as [TextEl, TextEl]
title3.content = doc(para('Revenue against costs'))
s3.elements = [
  title3,
  {
    ...base,
    id: 'chart-quarters',
    type: 'chart',
    chartType: 'bar',
    x: 120,
    y: 290,
    w: 1680,
    h: 700,
    z: 1,
    data: {
      columns: ['Quarter', 'Revenue', 'Costs'],
      rows: [
        ['Q1', 120, 80],
        ['Q2', 150, 95],
        ['Q3', 170, 110],
        ['Q4', 210, 120],
      ],
    },
    options: { title: 'Revenue vs costs (k USD)', legend: true },
  },
]

// Slide 4: two columns, a code block and a link
const s4: Slide = createSlide('two-column', theme)
s4.id = 'slide-columns'
const [title4, left4, right4] = s4.elements as [TextEl, TextEl, TextEl]
title4.content = doc(para('Two columns, code and a link'))
left4.content = doc(bullets(['Absolute positions on a 1920 x 1080 stage', 'Reveal scales the stage to any screen']))
right4.content = doc({
  type: 'paragraph',
  content: [
    { type: 'text', text: 'Read the ' },
    { type: 'text', text: 'reveal.js docs', marks: [{ type: 'link', attrs: { href: 'https://revealjs.com' } }] },
    { type: 'text', text: '.' },
  ],
})
s4.elements.push({
  ...base,
  id: 'code-sample',
  type: 'code',
  x: 988,
  y: 420,
  w: 812,
  h: 360,
  z: 2,
  code: 'const r = applyOps(doc, ops, "ui")',
  language: 'ts',
})

deck.slides = [s1, s2, s3, s4]

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, renderStandaloneDeckHtml(deck), 'utf8')
console.log(`wrote ${outPath}`)

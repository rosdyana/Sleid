// Built-in templates (M9). Each one is a complete deck: a built-in theme, 4 to 6
// slides with placeholder content, and charts or diagrams where they fit.
// Built-in templates are code, so they need no table. A user template is the
// same shape of data (a Deck), stored in the database (see @sleid/db).
import type { RichText } from './schema.ts'
import { BUILT_IN_THEMES, cloneTheme } from './defaults.ts'
import { withFreshIds } from './import-json.ts'
import { CANVAS_HEIGHT, CANVAS_WIDTH, DeckSchema, type Deck, type SlideLayout, type Theme } from './schema.ts'

export const TEMPLATE_CATEGORIES = ['business', 'education', 'general'] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

export interface BuiltInTemplateInfo {
  /** Stable id, prefixed so it never collides with a database id. */
  id: string
  name: string
  description: string
  category: TemplateCategory
  themeName: string
  slideCount: number
}

export const BUILT_IN_TEMPLATE_PREFIX = 'builtin:'

type ElementSpec = Record<string, unknown> & { type: string }

interface SlideSpec {
  layout: SlideLayout
  background?: { type: 'color'; value: string }
  notes?: string
  elements: ElementSpec[]
}

interface TemplateSpec {
  key: string
  name: string
  description: string
  category: TemplateCategory
  themeName: string
  title: string
  build: (t: Palette) => SlideSpec[]
}

interface Palette {
  theme: Theme
  heading: string
  body: string
}

// ---------------------------------------------------------------------------
// Rich text and element builders
// ---------------------------------------------------------------------------

/** A line of text: a plain paragraph, a bold heading line, or a bullet list. */
type Line = string | { head: string } | { bullets: string[] }

function rich(lines: Line[]): RichText {
  const content = lines.map((line) => {
    if (typeof line === 'string') {
      return line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
    }
    if ('head' in line) {
      return { type: 'paragraph', content: [{ type: 'text', text: line.head, marks: [{ type: 'bold' as const }] }] }
    }
    return {
      type: 'bulletList',
      content: line.bullets.map((b) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: b }] }],
      })),
    }
  })
  return { type: 'doc', content }
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface TextOpts extends Box {
  role?: 'title' | 'subtitle' | 'body'
  font: string
  size: number
  color: string
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom'
  lines: Line[]
}

function text(o: TextOpts): ElementSpec {
  return {
    type: 'text',
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    ...(o.role ? { role: o.role } : {}),
    content: rich(o.lines),
    style: {
      fontFamily: o.font,
      fontSize: o.size,
      color: o.color,
      align: o.align ?? 'left',
      valign: o.valign ?? 'top',
    },
  }
}

function box(o: Box & { fill: string; kind?: 'rect' | 'roundRect' | 'ellipse' }): ElementSpec {
  return {
    type: 'shape',
    shape: o.kind ?? 'rect',
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    fill: o.fill,
    stroke: o.fill,
    strokeWidth: 0,
  }
}

function chart(
  o: Box & { chartType: 'bar' | 'line' | 'pie' | 'area' | 'donut' | 'stacked-bar'; columns: string[]; rows: Array<Array<string | number>>; title?: string; legend?: boolean },
): ElementSpec {
  return {
    type: 'chart',
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    chartType: o.chartType,
    data: { columns: o.columns, rows: o.rows },
    options: { legend: o.legend ?? true, ...(o.title ? { title: o.title } : {}) },
  }
}

function diagram(o: Box & { source: string }): ElementSpec {
  return { type: 'diagram', x: o.x, y: o.y, w: o.w, h: o.h, source: o.source }
}

function table(o: Box & { rows: string[][]; headerFill: string; borderColor: string; fontSize: number }): ElementSpec {
  return {
    type: 'table',
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    rows: o.rows,
    header: true,
    style: { headerFill: o.headerFill, borderColor: o.borderColor, fontSize: o.fontSize },
  }
}

/** Title and body text in the theme's own heading and body fonts. */
function titleBox(p: Palette, label: string, x = 120, y = 96, w = 1680, h = 140): ElementSpec {
  return text({ x, y, w, h, role: 'title', font: p.heading, size: p.theme.sizes.heading, color: p.theme.colors.text, valign: 'middle', lines: [label] })
}

function bodyBox(p: Palette, lines: Line[], x: number, y: number, w: number, h: number, size?: number, color?: string): ElementSpec {
  return text({ x, y, w, h, role: 'body', font: p.body, size: size ?? p.theme.sizes.body, color: color ?? p.theme.colors.text, lines })
}

function mutedBox(p: Palette, lines: Line[], x: number, y: number, w: number, h: number, size = 28, align: 'left' | 'center' = 'left'): ElementSpec {
  return text({ x, y, w, h, font: p.body, size, color: p.theme.colors.muted, align, lines })
}

function subtitleBox(p: Palette, label: string, x: number, y: number, w: number, h: number, align: 'left' | 'center' = 'left'): ElementSpec {
  return text({ x, y, w, h, role: 'subtitle', font: p.body, size: p.theme.sizes.small + 8, color: p.theme.colors.muted, align, lines: [label] })
}

/** A card: a surface rectangle with a big value and a caption on top. */
function statCard(p: Palette, x: number, y: number, w: number, h: number, value: string, caption: string): ElementSpec[] {
  return [
    box({ x, y, w, h, fill: p.theme.colors.surface, kind: 'roundRect' }),
    text({ x: x + 48, y: y + 48, w: w - 96, h: 150, font: p.heading, size: 96, color: p.theme.colors.accent, valign: 'bottom', lines: [{ head: value }] }),
    text({ x: x + 48, y: y + 220, w: w - 96, h: h - 268, font: p.body, size: 34, color: p.theme.colors.muted, lines: [caption] }),
  ]
}

/** A small rounded card with a heading and body text. */
function textCard(p: Palette, x: number, y: number, w: number, h: number, heading: string, body: string): ElementSpec[] {
  return [
    box({ x, y, w, h, fill: p.theme.colors.surface, kind: 'roundRect' }),
    box({ x: x + 48, y: y + 56, w: 72, h: 8, fill: p.theme.colors.accent }),
    text({ x: x + 48, y: y + 90, w: w - 96, h: 90, font: p.heading, size: p.theme.sizes.small + 16, color: p.theme.colors.text, valign: 'top', lines: [{ head: heading }] }),
    text({ x: x + 48, y: y + 190, w: w - 96, h: h - 230, font: p.body, size: 34, color: p.theme.colors.muted, lines: [body] }),
  ]
}

function footer(p: Palette, label: string): ElementSpec {
  return mutedBox(p, [label], 120, 990, 1200, 40, 24)
}

// Accent bar under a title slide's title. Shared by the title layouts.
function accentRule(p: Palette, x: number, y: number): ElementSpec {
  return box({ x, y, w: 120, h: 10, fill: p.theme.colors.accent })
}

// ---------------------------------------------------------------------------
// The five built-in templates
// ---------------------------------------------------------------------------

const TEMPLATES: TemplateSpec[] = [
  {
    key: 'pitch',
    name: 'Pitch',
    description: 'A short investor or sales pitch: problem, solution, market, plan and the ask.',
    category: 'business',
    themeName: 'Midnight',
    title: 'Pitch',
    build: (p) => [
      {
        layout: 'title',
        elements: [
          accentRule(p, 160, 330),
          text({ x: 160, y: 360, w: 1600, h: 260, role: 'title', font: p.heading, size: p.theme.sizes.title, color: p.theme.colors.text, valign: 'bottom', lines: ['Company name'] }),
          subtitleBox(p, 'One line on what you do, and for whom', 160, 650, 1400, 120),
          footer(p, 'Confidential  ·  Draft'),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'The problem'),
          bodyBox(
            p,
            [{ bullets: ['Who has this problem, and how often', 'What they do today and what it costs them', 'Why the options they have fall short'] }],
            120,
            272,
            1000,
            640,
          ),
          ...statCard(p, 1240, 272, 560, 600, '3.2 h', 'lost each week, per team, to manual reporting'),
        ],
      },
      {
        layout: 'two-column',
        elements: [
          titleBox(p, 'Our solution'),
          bodyBox(p, [{ bullets: ['One place where the work happens', 'Set up in an afternoon, not a quarter', 'Works with the tools the team already uses'] }], 120, 272, 812, 640),
          ...textCard(p, 988, 272, 812, 300, 'Capture', 'Data comes in from the sources people already use.'),
          ...textCard(p, 988, 612, 812, 300, 'Decide', 'Teams see the answer, with the reasons behind it.'),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Market size'),
          chart({
            x: 120,
            y: 272,
            w: 1040,
            h: 700,
            chartType: 'bar',
            columns: ['Year', 'Revenue (USD m)'],
            rows: [
              ['2026', 2.1],
              ['2027', 4.8],
              ['2028', 9.6],
              ['2029', 17.2],
            ],
            title: 'Revenue plan',
            legend: false,
          }),
          bodyBox(p, [{ head: 'TAM  ·  $2.4 bn' }, 'Every team that reports on work', { head: 'SAM  ·  $310 m' }, 'Teams of 20 to 500 people', { head: 'SOM  ·  $17 m' }, 'Reached in four years'], 1240, 300, 560, 640, 34, p.theme.colors.muted),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'How it works'),
          diagram({ x: 120, y: 272, w: 1680, h: 640, source: 'flowchart LR\n  A[Capture] --> B[Analyse] --> C[Decide] --> D[Act]' }),
        ],
      },
      {
        layout: 'section',
        elements: [
          text({ x: 160, y: 380, w: 1600, h: 200, role: 'title', font: p.heading, size: p.theme.sizes.title, color: p.theme.colors.text, valign: 'bottom', lines: ['Thank you'] }),
          subtitleBox(p, 'Questions, and the next step: name@company.com', 160, 600, 1600, 160),
        ],
      },
    ],
  },
  {
    key: 'quarterly-review',
    name: 'Quarterly review',
    description: 'A team update: headline numbers, a trend, a metrics table, risks and next quarter.',
    category: 'business',
    themeName: 'Sheets Light',
    title: 'Quarterly review',
    build: (p) => [
      {
        layout: 'title',
        elements: [
          accentRule(p, 160, 330),
          text({ x: 160, y: 360, w: 1600, h: 260, role: 'title', font: p.heading, size: p.theme.sizes.title, color: p.theme.colors.text, valign: 'bottom', lines: ['Quarterly review'] }),
          subtitleBox(p, 'Q3 2026  ·  Team name  ·  Presenter', 160, 650, 1600, 120),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Highlights'),
          ...statCard(p, 120, 300, 520, 420, '+18%', 'Revenue against Q2'),
          ...statCard(p, 700, 300, 520, 420, '13.9k', 'Active users, up from 12.4k'),
          ...statCard(p, 1280, 300, 520, 420, '48', 'Customer NPS, up 7 points'),
          bodyBox(p, [{ bullets: ['Two launches shipped on time', 'Support backlog cut in half'] }], 120, 780, 1680, 200, 36, p.theme.colors.muted),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Revenue by month'),
          chart({
            x: 120,
            y: 272,
            w: 1100,
            h: 700,
            chartType: 'line',
            columns: ['Month', 'Actual', 'Target'],
            rows: [
              ['Jul', 118, 110],
              ['Aug', 124, 115],
              ['Sep', 139, 120],
              ['Oct', 131, 125],
              ['Nov', 146, 130],
              ['Dec', 158, 135],
            ],
            title: 'Revenue (USD k)',
          }),
          bodyBox(p, [{ head: 'What drove it' }, { bullets: ['Enterprise renewals closed early', 'Pricing change in July', 'Fewer failed payments'] }], 1280, 300, 520, 600, 34),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Key metrics'),
          table({
            x: 120,
            y: 272,
            w: 1680,
            h: 520,
            rows: [
              ['Metric', 'Q2', 'Q3', 'Change'],
              ['Active users', '12,400', '13,900', '+12%'],
              ['Churn (monthly)', '3.1%', '2.6%', '-0.5 pt'],
              ['Net promoter score', '41', '48', '+7'],
              ['Median response time', '6.2 h', '4.1 h', '-34%'],
            ],
            headerFill: p.theme.colors.accent,
            borderColor: p.theme.colors.muted,
            fontSize: 32,
          }),
        ],
      },
      {
        layout: 'two-column',
        elements: [
          titleBox(p, 'Risks and mitigations'),
          bodyBox(p, [{ bullets: ['Hiring is behind plan by two roles', 'Mitigation: contractors for Q4 while we recruit'] }], 120, 272, 812, 640),
          bodyBox(p, [{ bullets: ['Vendor price rise from January', 'Mitigation: renegotiate before the contract ends'] }], 988, 272, 812, 640),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Next quarter priorities'),
          bodyBox(p, [{ bullets: ['Launch the self-serve plan', 'Cut median response time to 3 hours', 'Hire two engineers and one designer', 'Review targets with the leadership team'] }], 120, 272, 1680, 640, 40),
        ],
      },
    ],
  },
  {
    key: 'lesson',
    name: 'Lesson',
    description: 'A class lesson: objectives, the key idea, a process diagram, questions and a summary.',
    category: 'education',
    themeName: 'Warm Paper',
    title: 'Lesson',
    build: (p) => [
      {
        layout: 'title',
        elements: [
          accentRule(p, 160, 330),
          text({ x: 160, y: 360, w: 1600, h: 260, role: 'title', font: p.heading, size: p.theme.sizes.title, color: p.theme.colors.text, valign: 'bottom', lines: ['Lesson title'] }),
          subtitleBox(p, 'Subject  ·  Year group  ·  45 minutes', 160, 650, 1600, 120),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Learning objectives'),
          bodyBox(p, [{ bullets: ['Explain the key idea in your own words', 'Apply it to a new example', 'Describe the steps of the process'] }], 120, 272, 1680, 640, 46),
        ],
      },
      {
        layout: 'two-column',
        elements: [
          titleBox(p, 'The key idea'),
          bodyBox(p, ['A short explanation goes here. Two or three sentences work best, written so a student can read them aloud.', 'Follow with one concrete example from everyday life.'], 120, 272, 812, 640, 40),
          ...textCard(p, 988, 272, 812, 420, 'Definition', 'A precise statement of the idea, in one or two sentences.'),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'How the process flows'),
          diagram({ x: 120, y: 272, w: 1680, h: 640, source: 'flowchart TD\n  A[Observe] --> B[Hypothesise]\n  B --> C[Test]\n  C --> D[Conclude]' }),
        ],
      },
      {
        layout: 'two-column',
        elements: [
          titleBox(p, 'Check your understanding'),
          bodyBox(p, [{ bullets: ['Question one: what does the process start with?', 'Question two: why do we test the idea?', 'Question three: give a case where it fails'] }], 120, 272, 812, 640, 38),
          bodyBox(p, [{ head: 'Answers' }, { bullets: ['Observation, the first step', 'So we can tell a guess from a result', 'When the test is run under the wrong conditions'] }], 988, 272, 812, 640, 38, p.theme.colors.muted),
        ],
      },
      {
        layout: 'section',
        elements: [
          text({ x: 160, y: 380, w: 1600, h: 200, role: 'title', font: p.heading, size: p.theme.sizes.heading + 16, color: p.theme.colors.text, valign: 'bottom', lines: ['Summary'] }),
          subtitleBox(p, 'Three things to remember from today', 160, 600, 1600, 160),
        ],
      },
    ],
  },
  {
    key: 'project-kickoff',
    name: 'Project kickoff',
    description: 'Start a project: goals, owners and dates, a timeline, risks and the decisions needed.',
    category: 'business',
    themeName: 'High Contrast',
    title: 'Project kickoff',
    build: (p) => [
      {
        layout: 'title',
        elements: [
          box({ x: 0, y: 0, w: CANVAS_WIDTH, h: 40, fill: p.theme.colors.accent }),
          text({ x: 160, y: 340, w: 1600, h: 260, role: 'title', font: p.heading, size: p.theme.sizes.title, color: p.theme.colors.text, valign: 'bottom', lines: [{ head: 'Project name' }] }),
          subtitleBox(p, 'Kickoff  ·  Project owner  ·  Start date', 160, 620, 1600, 120),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Goals'),
          box({ x: 120, y: 300, w: 520, h: 600, fill: p.theme.colors.surface }),
          text({ x: 160, y: 340, w: 440, h: 140, font: p.heading, size: 110, color: p.theme.colors.accent, lines: [{ head: '01' }] }),
          text({ x: 160, y: 500, w: 440, h: 360, font: p.body, size: 40, color: p.theme.colors.text, lines: ['Ship the first version to 50 pilot users by week 8.'] }),
          box({ x: 700, y: 300, w: 520, h: 600, fill: p.theme.colors.surface }),
          text({ x: 740, y: 340, w: 440, h: 140, font: p.heading, size: 110, color: p.theme.colors.accent, lines: [{ head: '02' }] }),
          text({ x: 740, y: 500, w: 440, h: 360, font: p.body, size: 40, color: p.theme.colors.text, lines: ['Cut manual work in the pilot teams by a third.'] }),
          box({ x: 1280, y: 300, w: 520, h: 600, fill: p.theme.colors.surface }),
          text({ x: 1320, y: 340, w: 440, h: 140, font: p.heading, size: 110, color: p.theme.colors.accent, lines: [{ head: '03' }] }),
          text({ x: 1320, y: 500, w: 440, h: 360, font: p.body, size: 40, color: p.theme.colors.text, lines: ['Agree the success measures with finance.'] }),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Scope and owners'),
          table({
            x: 120,
            y: 272,
            w: 1680,
            h: 420,
            rows: [
              ['Workstream', 'Owner', 'Due'],
              ['Discovery and research', 'Name', 'Week 2'],
              ['Build the first version', 'Name', 'Week 6'],
              ['Pilot with users', 'Name', 'Week 8'],
              ['Launch and handover', 'Name', 'Week 10'],
            ],
            headerFill: p.theme.colors.accent,
            borderColor: p.theme.colors.text,
            fontSize: 34,
          }),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Timeline'),
          diagram({ x: 120, y: 272, w: 1680, h: 640, source: 'flowchart LR\n  A[Discovery] --> B[Build] --> C[Pilot] --> D[Launch]' }),
        ],
      },
      {
        layout: 'two-column',
        elements: [
          titleBox(p, 'Risks'),
          bodyBox(p, [{ bullets: ['Two team members start late', 'The data export is slower than expected', 'Pilot users are hard to recruit'] }], 120, 272, 812, 640, 40),
          titleBox(p, 'Decisions needed', 988, 96, 812, 140),
          bodyBox(p, [{ bullets: ['Budget for the pilot', 'Who signs off the launch', 'Which team goes first'] }], 988, 272, 812, 640, 40),
        ],
      },
      {
        layout: 'section',
        elements: [
          text({ x: 160, y: 380, w: 1600, h: 200, role: 'title', font: p.heading, size: p.theme.sizes.title, color: p.theme.colors.text, valign: 'bottom', lines: ['Questions'] }),
          subtitleBox(p, 'Next step: first check-in on Friday', 160, 600, 1600, 160),
        ],
      },
    ],
  },
  {
    key: 'minimal',
    name: 'Minimal',
    description: 'A quiet deck with plenty of space: a title, an overview, a quote and a closing slide.',
    category: 'general',
    themeName: 'Sheets Light',
    title: 'Minimal',
    build: (p) => [
      {
        layout: 'title',
        elements: [
          text({ x: 160, y: 360, w: 1600, h: 260, role: 'title', font: p.heading, size: p.theme.sizes.title, color: p.theme.colors.text, align: 'center', valign: 'bottom', lines: ['A clear title'] }),
          subtitleBox(p, 'A short line of context', 160, 650, 1600, 120, 'center'),
        ],
      },
      {
        layout: 'title-content',
        elements: [
          titleBox(p, 'Overview'),
          bodyBox(p, [{ bullets: ['The first point', 'The second point', 'The third point'] }], 120, 272, 1680, 640, 48),
        ],
      },
      {
        layout: 'quote',
        elements: [
          text({ x: 240, y: 300, w: 1440, h: 480, role: 'body', font: p.heading, size: p.theme.sizes.heading, color: p.theme.colors.text, align: 'center', valign: 'middle', lines: ['A quote or the one message to remember.'] }),
          mutedBox(p, ['Attribution'], 240, 820, 1440, 60, 32, 'center'),
        ],
      },
      {
        layout: 'blank',
        elements: [
          text({ x: 160, y: 380, w: 1600, h: 320, font: p.heading, size: p.theme.sizes.heading + 24, color: p.theme.colors.accent, align: 'left', valign: 'middle', lines: ['One statement, given room to breathe.'] }),
        ],
      },
      {
        layout: 'section',
        elements: [
          text({ x: 160, y: 380, w: 1600, h: 200, role: 'title', font: p.heading, size: p.theme.sizes.title, color: p.theme.colors.text, valign: 'bottom', lines: ['Thank you'] }),
          subtitleBox(p, 'Questions and discussion', 160, 600, 1600, 160),
        ],
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Building the decks
// ---------------------------------------------------------------------------

function themeNamed(name: string): Theme {
  const found = BUILT_IN_THEMES.find((t) => t.name === name)
  if (!found) throw new Error(`built-in theme not found: ${name}`)
  return cloneTheme(found)
}

function buildTemplateDeck(spec: TemplateSpec): Deck {
  const theme = themeNamed(spec.themeName)
  const palette: Palette = { theme, heading: theme.fonts.heading, body: theme.fonts.body }
  const slides = spec.build(palette).map((slide, si) => {
    const slideId = `${spec.key}-s${si + 1}`
    return {
      id: slideId,
      layout: slide.layout,
      ...(slide.background ? { background: slide.background } : {}),
      notes: slide.notes ?? '',
      transition: 'fade' as const,
      autoAnimate: false,
      hidden: false,
      elements: slide.elements.map((el, ei) => ({
        rotation: 0,
        locked: false,
        opacity: 1,
        ...el,
        id: `${slideId}-e${ei + 1}`,
        z: ei,
      })),
    }
  })
  return DeckSchema.parse({
    id: `template-${spec.key}`,
    title: spec.title,
    size: { w: CANVAS_WIDTH, h: CANVAS_HEIGHT },
    theme,
    sections: [],
    slides,
    version: 1,
  })
}

const BUILT_IN_DECKS = new Map<string, Deck>(TEMPLATES.map((t) => [`${BUILT_IN_TEMPLATE_PREFIX}${t.key}`, buildTemplateDeck(t)]))

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplateInfo[] = TEMPLATES.map((t) => ({
  id: `${BUILT_IN_TEMPLATE_PREFIX}${t.key}`,
  name: t.name,
  description: t.description,
  category: t.category,
  themeName: t.themeName,
  slideCount: BUILT_IN_DECKS.get(`${BUILT_IN_TEMPLATE_PREFIX}${t.key}`)!.slides.length,
}))

export function isBuiltInTemplateId(id: string): boolean {
  return id.startsWith(BUILT_IN_TEMPLATE_PREFIX)
}

/** A fresh copy of a built-in template's deck (its ids are still the template's own; use withFreshIds before saving). */
export function builtInTemplateDeck(id: string): Deck | null {
  const deck = BUILT_IN_DECKS.get(id)
  return deck ? (structuredClone(deck) as Deck) : null
}

/** A deck from a built-in template, ready for createImportedDeck or the Yjs binding (fresh ids, no brand). */
export function deckFromBuiltInTemplate(id: string, title?: string): Deck | null {
  const deck = builtInTemplateDeck(id)
  if (!deck) return null
  const { brand: _brand, ...rest } = withFreshIds(deck)
  return { ...rest, title: title ?? rest.title }
}

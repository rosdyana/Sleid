import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, type Deck, type Element, type Slide, type Theme } from '@sleid/model'
import { lintDeck } from './lint.ts'

const KOMPAST_PATH = new URL('../../../apps/web/src/lib/mcp/fixtures/kompast.sleid.json', import.meta.url)
const kompast = JSON.parse(readFileSync(KOMPAST_PATH, 'utf8')) as Deck
const PAPER = BUILT_IN_THEMES.find((t) => t.name === 'Paper Navy') as Theme

const SANS = 'Arial, sans-serif'
let seq = 0

function base(extra: Record<string, unknown>) {
  return { id: `e${seq++}`, z: seq, rotation: 0, locked: false, opacity: 1, ...extra }
}

function para(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function textEl(x: number, y: number, w: number, h: number, text: string, style: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Element {
  return base({
    type: 'text',
    x,
    y,
    w,
    h,
    content: para(text),
    style: { fontFamily: SANS, fontSize: 30, lineHeight: 1.2, align: 'left', valign: 'top', color: '#202124', ...style },
    ...extra,
  }) as unknown as Element
}

function shape(x: number, y: number, w: number, h: number, fill: string, extra: Record<string, unknown> = {}): Element {
  return base({ type: 'shape', shape: 'rect', x, y, w, h, fill, stroke: 'transparent', strokeWidth: 0, ...extra }) as unknown as Element
}

function slide(id: string, elements: Element[], extra: Partial<Slide> = {}): Slide {
  return { id, layout: 'blank', notes: '', transition: 'none', autoAnimate: false, hidden: false, elements, ...extra }
}

function deck(slides: Slide[], extra: Partial<Deck> = {}): Deck {
  return { id: 'd', title: 't', size: { w: 1920, h: 1080 }, theme: structuredClone(PAPER), sections: [], slides, version: 1, ...extra }
}

describe('overflow', () => {
  it('reports text whose measured height is more than its box', () => {
    const d = deck([slide('s', [textEl(100, 100, 300, 20, 'A line of text that will not fit in twenty pixels')])])
    const issues = lintDeck(d)
    expect(issues.some((i) => i.kind === 'overflow' && i.severity === 'error')).toBe(true)
  })

  it('does not report text that fits its box', () => {
    const d = deck([slide('s', [textEl(100, 100, 600, 60, 'Short')])])
    expect(lintDeck(d).filter((i) => i.kind === 'overflow')).toHaveLength(0)
  })
})

describe('overlap', () => {
  it('warns when two text boxes overlap by more than 4px on both axes', () => {
    const a = textEl(100, 100, 400, 60, 'First text')
    const b = textEl(120, 120, 400, 60, 'Second text')
    const issues = lintDeck(deck([slide('s', [a, b])])).filter((i) => i.kind === 'overlap')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('warning')
    expect(issues[0]!.otherElementId).toBe(b.id)
  })

  it('measures the text, not the box: an empty tall box does not overlap', () => {
    const a = textEl(100, 100, 400, 300, 'Top only')
    const b = textEl(100, 250, 400, 60, 'Below')
    expect(lintDeck(deck([slide('s', [a, b])])).filter((i) => i.kind === 'overlap')).toHaveLength(0)
  })

  it('exempts two elements of the same component instance', () => {
    const component = { kind: 'header', instance: 'same', part: 'x' }
    const a = textEl(100, 100, 400, 60, 'First', {}, { component })
    const b = textEl(120, 120, 400, 60, 'Second', {}, { component: { ...component, part: 'y' } })
    expect(lintDeck(deck([slide('s', [a, b])])).filter((i) => i.kind === 'overlap')).toHaveLength(0)
  })

  it('warns when text runs over a picture it is not inside', () => {
    const pic = base({ type: 'image', x: 0, y: 0, w: 800, h: 600, src: 'x', fit: 'cover', alt: 'pic' }) as unknown as Element
    const t = textEl(700, 500, 400, 60, 'Over the edge')
    const issues = lintDeck(deck([slide('s', [pic, t])])).filter((i) => i.kind === 'overlap')
    expect(issues).toHaveLength(1)
  })

  it('does not warn for text fully inside a picture', () => {
    const pic = base({ type: 'image', x: 0, y: 0, w: 800, h: 600, src: 'x', fit: 'cover', alt: 'pic' }) as unknown as Element
    const t = textEl(100, 100, 300, 60, 'Inside', { color: '#ffffff' })
    expect(lintDeck(deck([slide('s', [pic, t])])).filter((i) => i.kind === 'overlap')).toHaveLength(0)
  })
})

describe('off-slide', () => {
  it('errors when an element extends past the slide', () => {
    const d = deck([slide('s', [shape(1900, 0, 100, 50, '#ff0000')])])
    const issues = lintDeck(d).filter((i) => i.kind === 'off-slide')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('error')
  })

  it('ignores invisible elements and hidden slides', () => {
    const invisible = shape(1900, 0, 100, 50, '#ff0000', { opacity: 0 })
    expect(lintDeck(deck([slide('s', [invisible])])).filter((i) => i.kind === 'off-slide')).toHaveLength(0)
    const hidden = slide('h', [shape(1900, 0, 100, 50, '#ff0000')], { hidden: true })
    expect(lintDeck(deck([hidden])).filter((i) => i.kind === 'off-slide')).toHaveLength(0)
  })
})

describe('low-contrast', () => {
  it('errors for light grey text on the white theme background', () => {
    const t = textEl(100, 100, 600, 60, 'Faint', { color: '#cccccc' })
    const issues = lintDeck(deck([slide('s', [t])])).filter((i) => i.kind === 'low-contrast')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('error')
  })

  it('passes dark text on the light background', () => {
    const t = textEl(100, 100, 600, 60, 'Clear', { color: '#202124' })
    expect(lintDeck(deck([slide('s', [t])])).filter((i) => i.kind === 'low-contrast')).toHaveLength(0)
  })

  it('uses the topmost opaque shape under the text as the background', () => {
    const panel = shape(50, 50, 800, 300, '#101010')
    const t = textEl(100, 100, 600, 60, 'On a dark panel', { color: '#202124' })
    const issues = lintDeck(deck([slide('s', [panel, t])])).filter((i) => i.kind === 'low-contrast')
    expect(issues).toHaveLength(1)
  })

  it('skips transparent shapes and uses the slide background instead', () => {
    const clear = shape(50, 50, 800, 300, 'rgba(0,0,0,0.1)')
    const t = textEl(100, 100, 600, 60, 'Through glass', { color: '#ffffff' })
    const issues = lintDeck(deck([slide('s', [clear, t])])).filter((i) => i.kind === 'low-contrast')
    expect(issues).toHaveLength(1)
  })

  it('checks textStyle marks too', () => {
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'mark', marks: [{ type: 'textStyle', attrs: { color: '#dddddd' } }] }] }],
    }
    const t = base({ type: 'text', x: 100, y: 100, w: 600, h: 60, content, style: { fontSize: 30, align: 'left', valign: 'top' } }) as unknown as Element
    expect(lintDeck(deck([slide('s', [t])])).filter((i) => i.kind === 'low-contrast')).toHaveLength(1)
  })

  it('uses the dark variant text colour on dark slides by default', () => {
    const bg = { type: 'gradient' as const, value: 'radial-gradient(ellipse, #2a4170 0%, #1b2a47 60%, #16223b 100%)' }
    const t = textEl(100, 100, 600, 60, 'Default colour', { color: undefined })
    const issues = lintDeck(deck([slide('s', [t], { variant: 'dark', background: bg })])).filter((i) => i.kind === 'low-contrast')
    expect(issues).toHaveLength(0)
  })
})

describe('missing-alt', () => {
  it('warns for an image with a src and no alt', () => {
    const img = base({ type: 'image', x: 0, y: 0, w: 100, h: 100, src: 'x', fit: 'cover' }) as unknown as Element
    const issues = lintDeck(deck([slide('s', [img])])).filter((i) => i.kind === 'missing-alt')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('warning')
  })

  it('does not warn for an image with alt, or an empty image', () => {
    const ok = base({ type: 'image', x: 0, y: 0, w: 100, h: 100, src: 'x', fit: 'cover', alt: 'A picture' }) as unknown as Element
    const empty = base({ type: 'image', x: 200, y: 0, w: 100, h: 100, src: '', fit: 'cover' }) as unknown as Element
    expect(lintDeck(deck([slide('s', [ok, empty])])).filter((i) => i.kind === 'missing-alt')).toHaveLength(0)
  })
})

describe('missing-translation', () => {
  const component = { kind: 'card_grid', instance: 'g', part: 'card.0.title' }

  it('is info when a secondary language is set and a title has no secondary line', () => {
    const t = textEl(100, 100, 600, 60, 'Title', {}, { component })
    const issues = lintDeck(deck([slide('s', [t])], { secondaryLanguage: 'id' })).filter((i) => i.kind === 'missing-translation')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('info')
  })

  it('is silent when the item has its secondary line, or no secondary language is set', () => {
    const t = textEl(100, 100, 600, 60, 'Title', {}, { component })
    const s = textEl(100, 200, 600, 60, 'Kedua', {}, { component: { ...component, part: 'card.0.secondary' } })
    expect(lintDeck(deck([slide('s', [t, s])], { secondaryLanguage: 'id' })).filter((i) => i.kind === 'missing-translation')).toHaveLength(0)
    expect(lintDeck(deck([slide('s', [t])])).filter((i) => i.kind === 'missing-translation')).toHaveLength(0)
  })
})

describe('options and ordering', () => {
  it('lints only the slides given in slideIds', () => {
    const bad = slide('bad', [shape(1900, 0, 100, 50, '#ff0000')])
    const good = slide('good', [shape(0, 0, 10, 10, '#ff0000')])
    expect(lintDeck(deck([bad, good]), { slideIds: ['good'] })).toHaveLength(0)
    expect(lintDeck(deck([bad, good]), { slideIds: ['bad'] }).length).toBeGreaterThan(0)
  })

  it('lists errors first', () => {
    const d = deck([slide('s', [shape(1900, 0, 100, 50, '#ff0000'), textEl(100, 100, 300, 20, 'Too tall for this box at all here')])])
    const severities = lintDeck(d).map((i) => i.severity)
    expect(severities[0]).toBe('error')
  })
})

describe('Kompast fixture', () => {
  function issuesOn(index: number) {
    return lintDeck(kompast, { slideIds: [kompast.slides[index]!.id] })
  }

  it('slide 1: the heading measures too tall for its box (overflow)', () => {
    expect(issuesOn(1).some((i) => i.kind === 'overflow' && i.elementId === 'ke')).toBe(true)
  })

  it('slide 15 and 17: headings overflow their boxes', () => {
    expect(issuesOn(15).some((i) => i.kind === 'overflow' && i.elementId === 'ke6')).toBe(true)
    expect(issuesOn(17).some((i) => i.kind === 'overflow' && i.elementId === 'kg6')).toBe(true)
  })

  it('slide 15: the dash markers overlap the text boxes beside them (box overlap, not visible overlap)', () => {
    expect(issuesOn(15).filter((i) => i.kind === 'overlap').length).toBeGreaterThan(0)
  })
})

describe('empty slides', () => {
  it('reports a slide with no elements as a warning of kind empty-slide, with its slide id', () => {
    const emptyDeck = { id: 'd', title: 'x', size: { w: 1920, h: 1080 }, theme: BUILT_IN_THEMES[0] as Theme, sections: [], version: 1, slides: [{ id: 'empty-1', layout: 'blank', notes: '', transition: 'none', autoAnimate: false, hidden: false, elements: [] }] } as unknown as Deck
    const issues = lintDeck(emptyDeck)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'warning', kind: 'empty-slide', slideId: 'empty-1', slideIndex: 0 })
  })
})

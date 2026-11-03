import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Deck, TextElement } from '@sleid/model'
import { charWidth, fitText, fontClass, measureLines, measureRich, textHeight } from './measure.ts'

const KOMPAST_PATH = new URL('../../../apps/web/src/lib/mcp/fixtures/kompast.sleid.json', import.meta.url)
const kompast = JSON.parse(readFileSync(KOMPAST_PATH, 'utf8')) as Deck

const SANS = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif'
const HEADING_1 = "Our work is spread across tools we rent, but don't control."
const headingStyle = { fontSize: 64.8, fontWeight: 700, letterSpacing: -0.02, lineHeight: 1.12, fontFamily: SANS }

function doc(...paragraphs: string[]) {
  return { type: 'doc', content: paragraphs.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) } as never
}

describe('font classes and widths', () => {
  it('classifies families', () => {
    expect(fontClass('Georgia, serif')).toBe('serif')
    expect(fontClass('ui-monospace, "SF Mono", Menlo, Consolas, monospace')).toBe('mono')
    expect(fontClass('ui-sans-serif, Helvetica, sans-serif')).toBe('sans')
    expect(fontClass(undefined)).toBe('sans')
  })

  it('reads the Chrome table: a is 556/1000 at regular, 574 at bold', () => {
    expect(charWidth('a', { size: 1000, weight: 400 })).toBeCloseTo(556, 6)
    expect(charWidth('a', { size: 1000, weight: 700 })).toBeCloseTo(574, 6)
    expect(charWidth('a', { size: 1000, weight: 550 })).toBeGreaterThan(556)
    expect(charWidth('a', { size: 1000, weight: 550 })).toBeLessThan(574)
  })

  it('treats CJK as one em and unknown characters as the lowercase average', () => {
    expect(charWidth('中', { size: 40 })).toBe(40)
    expect(charWidth('ｱ', { size: 40 })).toBe(40)
    expect(charWidth('́', { size: 1000 })).toBeGreaterThan(0)
  })
})

describe('measureLines', () => {
  it('wraps the fixture heading at width 1000 into two lines', () => {
    expect(measureLines(HEADING_1, { fontSize: 64.8, fontWeight: 700, letterSpacing: -0.02, fontFamily: SANS }, 1000)).toHaveLength(2)
  })

  it('does not wrap the fixture heading in a wide box, and says how wide it is', () => {
    // The fixture box is 1693.5px wide, sized to the sentence in SF (macOS). The stack falls back to Helvetica or Arial
    // elsewhere (Liberation Sans on the Linux worker), which is about 4% wider, so the measurement (widest family in the
    // stack) wraps it, as the user saw it wrap. Widening the box to 1800px fits it on one line.
    expect(measureLines(HEADING_1, { fontSize: 64.8, fontWeight: 700, letterSpacing: -0.02, fontFamily: SANS }, 1693.5)).toHaveLength(2)
    expect(measureLines(HEADING_1, { fontSize: 64.8, fontWeight: 700, letterSpacing: -0.02, fontFamily: SANS }, 1800)).toHaveLength(1)
    const unwrapped = measureRich(doc(HEADING_1), headingStyle, 1e6).widest
    expect(unwrapped).toBeGreaterThan(1693.5)
    expect(unwrapped).toBeLessThan(1693.5 * 1.07)
  })

  it('wraps CJK between any two characters', () => {
    const lines = measureLines('中文字符测试中文字符测试', { fontSize: 40 }, 100)
    expect(lines).toEqual(['中文', '字符', '测试', '中文', '字符', '测试'])
  })

  it('breaks a word longer than the line between characters', () => {
    const lines = measureLines('abcdefghijklmnopqrstuvwxyz', { fontSize: 40 }, 100)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join('')).toBe('abcdefghijklmnopqrstuvwxyz')
  })

  it('applies uppercase before measuring', () => {
    const plain = measureLines('label text', { fontSize: 20 }, 1000)
    const upper = measureLines('label text', { fontSize: 20, textTransform: 'uppercase' }, 1000)
    expect(plain).toEqual(['label text'])
    expect(upper).toEqual(['LABEL TEXT'])
  })
})

describe('measureRich', () => {
  it('counts a paragraph gap between blocks and no gap after the last', () => {
    const one = measureRich(doc('Hello'), { fontSize: 20, lineHeight: 1 }, 500)
    const two = measureRich(doc('Hello', 'World'), { fontSize: 20, lineHeight: 1 }, 500)
    expect(one.lines).toBe(1)
    expect(one.height).toBeCloseTo(20, 6)
    expect(two.lines).toBe(2)
    expect(two.height).toBeCloseTo(20 + 0.4 * 20 + 20, 6)
  })

  it('indents list items by 1.2em, so a list wraps sooner than a paragraph', () => {
    const list = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'word '.repeat(12).trim() }] }] }] }] } as never
    const para = doc('word '.repeat(12).trim())
    const style = { fontSize: 30, lineHeight: 1 }
    expect(measureRich(list, style, 300).lines).toBeGreaterThanOrEqual(measureRich(para, style, 300).lines)
  })

  it('uses the mark font size for its own characters', () => {
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'big', marks: [{ type: 'textStyle', attrs: { fontSize: '80px' } }] }] }],
    } as never
    const big = measureRich(content, { fontSize: 20, lineHeight: 1 }, 1000)
    expect(big.height).toBeCloseTo(80, 6)
  })

  it('a hard break starts a new line inside the paragraph', () => {
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }] } as never
    expect(measureRich(content, { fontSize: 20, lineHeight: 1 }, 1000).lines).toBe(2)
  })
})

describe('fitText', () => {
  const base: TextElement = {
    type: 'text',
    id: 't',
    z: 0,
    x: 0,
    y: 0,
    w: 400,
    h: 45,
    rotation: 0,
    locked: false,
    opacity: 1,
    content: doc('Long heading here'),
    style: { fontSize: 60, lineHeight: 1, align: 'left', valign: 'top', autoFit: 'shrink' },
  }

  it('shrinks until the text fits the box height', () => {
    expect(textHeight(base)).toBeGreaterThan(45)
    const fitted = fitText(base)
    expect(fitted.style.fontSize!).toBeLessThan(60)
    expect(fitted.style.fontSize!).toBeGreaterThanOrEqual(36)
    expect(textHeight(fitted)).toBeLessThanOrEqual(45 + 0.01)
  })

  it('keeps the 60% floor when the text cannot fit, and the linter reports the overflow', () => {
    const long = { ...base, h: 10, content: doc('A much longer heading that will never fit a ten pixel box at any size') }
    const fitted = fitText(long)
    expect(fitted.style.fontSize).toBeCloseTo(36, 6)
    expect(textHeight(fitted)).toBeGreaterThan(10)
  })

  it('grow-box sets the height to the measured height, rounded up', () => {
    const grown = fitText({ ...base, style: { ...base.style, autoFit: 'grow-box' } })
    expect(grown.h).toBe(Math.ceil(textHeight({ ...base, style: { ...base.style, autoFit: 'grow-box' } })))
    expect(grown.style.fontSize).toBe(60)
  })

  it('none leaves the element as it is', () => {
    const el = { ...base, style: { ...base.style, autoFit: 'none' as const } }
    expect(fitText(el)).toBe(el)
  })
})

describe('Kompast fixture headings (slides 1, 15, 17)', () => {
  /** The heading: the role 'title' text, or else the largest text between 100px and 400px from the top. */
  function headingOf(index: number): TextElement {
    const els = kompast.slides[index]!.elements.filter((e): e is TextElement => e.type === 'text')
    const titled = els.find((e) => e.role === 'title')
    if (titled) return titled
    return els.filter((e) => e.y >= 100 && e.y <= 400).sort((a, b) => (b.style.fontSize ?? 0) - (a.style.fontSize ?? 0))[0]!
  }

  it('slide 1 heading measures 2 lines in its 1693.5px box (the spec expected 1; see the note above)', () => {
    const el = headingOf(1)
    expect(el.w).toBeCloseTo(1693.5, 1)
    expect(el.h).toBeCloseTo(80.4, 1)
    expect(measureRich(el.content, el.style, el.w).lines).toBe(2)
  })

  it('slide 15 and 17 headings: measured lines are at least the lines the box height implies', () => {
    for (const index of [15, 17]) {
      const el = headingOf(index)
      const lineH = el.style.fontSize! * el.style.lineHeight!
      const implied = Math.max(1, Math.round(el.h / lineH))
      const measured = measureRich(el.content, el.style, el.w)
      expect(measured.lines).toBeGreaterThanOrEqual(implied)
    }
  })
})

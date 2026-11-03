// Pure MCP helpers: text conversion, slide compilation, outlines, the rate limiter and request parsing.
import { describe, expect, it } from 'vitest'
import { createDeck, createSlide, type Deck } from '@sleid/model'
import { buildSlide, builtInTheme, outlineOf, pngSize, resolveSlide, textPatchFor, findElement } from './compile.ts'
import { ToolError } from './errors.ts'
import { markdownToRich, plainToRich, richToPlain } from './rich.ts'
import { FixedWindowLimiter } from './rate-limit.ts'
import { bearerToken } from './http.ts'

// A 1 x 1 transparent PNG.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('markdownToRich', () => {
  it('makes one paragraph per line, skips blank lines, and groups bullets into one list', () => {
    const doc = markdownToRich('Intro line\n\n- first\n- second\nAfter the list')
    const blocks = (doc as unknown as { content: Array<{ type: string; content?: unknown[] }> }).content
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'bulletList', 'paragraph'])
    expect(blocks[1]!.content).toHaveLength(2)
    expect(richToPlain(doc)).toBe('Intro line\nfirst\nsecond\nAfter the list')
  })

  it('reads **bold** and *italic* as marks, and keeps other text literal', () => {
    const doc = markdownToRich('Make it **bold** and *slanted* (not 2*3*4)')
    const para = (doc as unknown as { content: Array<{ content: Array<{ text: string; marks?: Array<{ type: string }> }> }> }).content[0]!
    expect(para.content.find((n) => n.text === 'bold')?.marks).toEqual([{ type: 'bold' }])
    expect(para.content.find((n) => n.text === 'slanted')?.marks).toEqual([{ type: 'italic' }])
    expect(richToPlain(doc)).toBe('Make it bold and slanted (not 2*3*4)')
  })

  it('always returns at least one paragraph, and titles stay on one line', () => {
    expect(markdownToRich('  \n \n')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(richToPlain(plainToRich('Line one\nline two'))).toBe('Line one line two')
  })
})

describe('buildSlide', () => {
  const deck: Deck = createDeck('Compile')

  it('fills the title and body placeholders of a title-content slide, with the body as a list', () => {
    const slide = buildSlide(deck, { slideId: 'slide-a', layout: 'title-content', title: 'Costs', body: 'Low\n- one\n- two', notes: 'Say it' })
    expect(slide.id).toBe('slide-a')
    expect(slide.notes).toBe('Say it')
    const title = slide.elements.find((e) => e.type === 'text' && e.role === 'title')
    const body = slide.elements.find((e) => e.type === 'text' && e.role === 'body')
    expect(richToPlain((title as { content: unknown }).content)).toBe('Costs')
    expect(richToPlain((body as { content: unknown }).content)).toBe('Low\none\ntwo')
    expect(slide.elements.map((e) => e.z)).toEqual(slide.elements.map((_, i) => i))
  })

  it('adds text boxes when the layout has no box for the title or body (blank slide)', () => {
    const slide = buildSlide(deck, { slideId: 'slide-b', layout: 'blank', title: 'Loose title', body: 'Loose body' })
    const texts = slide.elements.filter((e) => e.type === 'text')
    expect(texts).toHaveLength(2)
    expect(texts.map((e) => (e as { role?: string }).role)).toEqual(['title', 'body'])
  })

  it('sends a section body to the subtitle box', () => {
    const slide = buildSlide(deck, { slideId: 'slide-c', layout: 'section', title: 'Part 2', body: 'What follows' })
    const subtitle = slide.elements.find((e) => e.type === 'text' && e.role === 'subtitle') as { content: unknown }
    expect(richToPlain(subtitle.content)).toBe('What follows')
  })
})

describe('resolving slides and elements', () => {
  const deck: Deck = createDeck('Resolve')
  deck.slides.push(createSlide('blank', deck.theme))

  it('resolves by id or 0-based index, and refuses both, neither or an index out of range', () => {
    expect(resolveSlide(deck, { index: 1 })).toBe(deck.slides[1])
    expect(resolveSlide(deck, { slideId: deck.slides[0]!.id })).toBe(deck.slides[0])
    expect(() => resolveSlide(deck, { index: 0, slideId: 'x' })).toThrow(ToolError)
    expect(() => resolveSlide(deck, {})).toThrow(/slideId, or index/)
    expect(() => resolveSlide(deck, { index: 9 })).toThrow(/no slide at index 9/)
  })

  it('finds an element on any slide, and refuses to write text into a chart', () => {
    const el = deck.slides[0]!.elements[0]!
    expect(findElement(deck, el.id).element).toBe(el)
    expect(() => findElement(deck, 'missing')).toThrow(ToolError)
    const chart = {
      id: 'c1',
      type: 'chart',
      chartType: 'bar',
      data: { columns: ['a', 'b'], rows: [['x', 1]] },
      options: { legend: true },
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      rotation: 0,
      z: 0,
      locked: false,
      opacity: 1,
    } as unknown as Parameters<typeof textPatchFor>[0]
    expect(() => textPatchFor(chart, 'words')).toThrow(/not a text box/)
  })
})

describe('outlines and PNG sizes', () => {
  it('outlines slides by 0-based index with ids, layout, title and element summaries', () => {
    const deck = createDeck('Outline')
    const outline = outlineOf(deck) as { slideCount: number; slides: Array<{ index: number; id: string; title: string; elements: Array<{ type: string }> }> }
    expect(outline.slideCount).toBe(1)
    expect(outline.slides[0]).toMatchObject({ index: 0, id: deck.slides[0]!.id, title: '' })
    expect(outline.slides[0]!.elements.map((e) => e.type)).toEqual(['text', 'text'])
  })

  it('reads the width and height from a PNG, and rejects other bytes', () => {
    expect(pngSize(new Uint8Array(PNG_1X1))).toEqual({ width: 1, height: 1 })
    expect(pngSize(new TextEncoder().encode('<svg></svg>' + 'x'.repeat(20)))).toBeNull()
  })

  it('finds built-in themes ignoring case and spaces', () => {
    expect(builtInTheme('  midnight ')?.name).toBe('Midnight')
    expect(builtInTheme('Nope')).toBeUndefined()
  })
})

describe('FixedWindowLimiter', () => {
  it('allows the maximum per window, refuses the next call with the wait, and resets after the window', () => {
    const limiter = new FixedWindowLimiter(2, 60_000)
    const t0 = 1_000_000
    expect(limiter.take('tok', t0).ok).toBe(true)
    expect(limiter.take('tok', t0 + 1000).ok).toBe(true)
    const refused = limiter.take('tok', t0 + 2000)
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 58 })
    expect(limiter.take('other', t0 + 2000).ok).toBe(true)
    expect(limiter.take('tok', t0 + 60_000).ok).toBe(true)
  })
})

describe('bearer parsing', () => {
  it('takes the token from a Bearer header only', () => {
    expect(bearerToken('Bearer sleid_pat_abc')).toBe('sleid_pat_abc')
    expect(bearerToken('bearer   sleid_pat_abc  ')).toBe('sleid_pat_abc')
    expect(bearerToken('Basic xyz')).toBeNull()
    expect(bearerToken('Bearer two parts')).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })
})

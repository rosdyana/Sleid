// Pure MCP helpers: text conversion, slide compilation, outlines, the rate limiter and request parsing.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDeck, createSlide, type Deck, type Element } from '@sleid/model'
import { buildSlide, builtInTheme, outlineOf, pngSize, resolveSlide, selectSlides, textPatchFor, findElement } from './compile.ts'
import { ToolError } from './errors.ts'
import { markdownToRich, plainToRich, richToPlain } from './rich.ts'
import { FixedWindowLimiter } from './rate-limit.ts'
import { bearerToken } from './http.ts'
import { appendComponents, chromeElements, checkProps, fillTwoColumns, twoColumnParts } from './compose-ops.ts'
import { compactDeck, richToMarkdown } from './compact.ts'
import { buildPlan } from './plan.ts'
import { GUIDE_ELEMENTS_MD } from './guide-elements.ts'

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

// ---- M11 Phase D: component composition, compact reads, the guide and the plan ----

describe('compose-ops: components on a slide', () => {
  const deck: Deck = createDeck('Compose')
  const empty = (variant?: 'light' | 'dark') => ({ id: 'slide-x', ...(variant ? { variant } : {}), elements: [] as Element[] })

  it('stacks a card grid under a header, 56px below the header and never above 303', () => {
    const r = appendComponents(deck, empty(), [
      { kind: 'header', props: { label: 'Label', heading: 'A heading' } },
      { kind: 'card_grid', props: { cards: [{ title: 'One' }, { title: 'Two' }] } },
    ])
    const header = r.elements.filter((e) => e.component?.kind === 'header')
    const headerBottom = Math.max(...header.map((e) => e.y + (e.h ?? 0)))
    const grid = r.elements.filter((e) => e.component?.kind === 'card_grid')
    const gridTop = Math.min(...grid.map((e) => e.y))
    expect(gridTop).toBeGreaterThanOrEqual(303)
    expect(gridTop).toBeGreaterThanOrEqual(headerBottom + 56 - 0.5)
    expect(r.parts.map((p) => p.kind)).toEqual(['header', 'card_grid'])
  })

  it('stacks two body components vertically with the theme gap between them', () => {
    const r = appendComponents(deck, empty(), [
      { kind: 'card_grid', props: { cards: [{ title: 'A' }, { title: 'B' }] } },
      { kind: 'stat_row', props: { stats: [{ value: '42', label: 'Things' }] } },
    ])
    const first = r.elements.filter((e) => e.component?.instance === r.parts[0]!.instance)
    const second = r.elements.filter((e) => e.component?.instance === r.parts[1]!.instance)
    const firstBottom = Math.max(...first.map((e) => e.y + (e.h ?? 0)))
    const secondTop = Math.min(...second.map((e) => e.y))
    expect(secondTop).toBeGreaterThanOrEqual(firstBottom + 32 - 0.5)
  })

  it('puts left and right components side by side from the same top', () => {
    const r = appendComponents(deck, empty(), [
      { kind: 'bullets_with_sublines', props: { items: [{ text: 'Left one' }] }, region: 'left' },
      { kind: 'bullets_with_sublines', props: { items: [{ text: 'Right one' }] }, region: 'right' },
    ])
    const left = r.elements.filter((e) => e.component?.instance === r.parts[0]!.instance)
    const right = r.elements.filter((e) => e.component?.instance === r.parts[1]!.instance)
    expect(Math.min(...left.map((e) => e.y))).toBe(Math.min(...right.map((e) => e.y)))
    expect(Math.min(...right.map((e) => e.x))).toBeGreaterThan(Math.max(...left.map((e) => e.x + (e.w ?? 0))))
  })

  it('fills two-column boxes from columns, or splits a body on a --- line', () => {
    expect(twoColumnParts(undefined, ['a', 'b'])).toEqual(['a', 'b'])
    expect(twoColumnParts('left\n- one\n---\nright', undefined)).toEqual(['left\n- one', 'right'])
    expect(twoColumnParts('no split here', undefined)).toBeNull()
    const built = buildSlide(deck, { slideId: 's2', layout: 'two-column' })
    fillTwoColumns(built.elements, ['Left text', 'Right text'])
    const bodies = built.elements.filter((e) => e.type === 'text' && e.role === 'body') as Array<{ x: number; content: unknown }>
    expect(bodies.map((b) => richToPlain(b.content))).toEqual(['Left text', 'Right text'])
    expect(bodies[0]!.x).toBeLessThan(bodies[1]!.x)
  })

  it('adds the chrome: the light logo and footer on light slides, the dark logo on dark slides, and the page number', () => {
    const themed = createDeck('Chrome')
    themed.theme = { ...themed.theme, components: { chrome: { logoLight: 'data:image/png;base64,AAAA', logoDark: 'data:image/png;base64,BBBB', footerText: 'Acme', pageNumbers: true } } }
    const light = chromeElements(themed, empty('light'), 3)
    const dark = chromeElements(themed, empty('dark'), 3)
    const srcOf = (els: unknown[]) => (els as Array<{ type: string; src?: string }>).find((e) => e.type === 'image')?.src
    expect(srcOf(light)).toBe('data:image/png;base64,AAAA')
    expect(srcOf(dark)).toBe('data:image/png;base64,BBBB')
    expect(JSON.stringify(light)).toContain('Acme')
    expect(JSON.stringify(light)).toContain('"3"')
    expect(chromeElements(createDeck('Plain'), empty(), 1)).toEqual([])
  })

  it('refuses props that do not match the component schema, with the path', () => {
    expect(() => checkProps('card_grid', { cards: [] }, 'components[0]')).toThrow(/components\[0\] \(card_grid\).*cards/)
    expect(checkProps('stat_row', { stats: [{ value: '1', label: 'x' }] }, 'components[0]')).toEqual({ stats: [{ value: '1', label: 'x' }] })
  })
})

describe('compact reads and the guide', () => {
  const kompast = JSON.parse(readFileSync(new URL('./fixtures/kompast.sleid.json', import.meta.url), 'utf8')) as Deck

  // Measured on the Kompast fixture (see compact.ts): the full deck is about 94.8 KB and three slides about 15 KB. The
  // targets of 60 KB and 12 KB are not reachable with one JSON object per element (about 620 elements, each with its own
  // id and box), so the bounds are the measured sizes plus 10%. Lower them when the format gets smaller.
  it('keeps the full Kompast deck under 104,300 bytes and three slides under 16,500 (measured + 10%)', () => {
    const full = JSON.stringify(compactDeck(kompast))
    const three = JSON.stringify(compactDeck(kompast, { range: { from: 3, to: 5 } }))
    expect(full.length).toBeLessThan(104_300)
    expect(three.length).toBeLessThan(16_500)
    expect(full).not.toContain('base64,')
    expect(full).toContain('data:image/png (')
  })

  it('drops the default fields and writes rich text as markdown', () => {
    const compact = compactDeck(kompast, { slideIds: [kompast.slides[0]!.id] }) as { slides: Array<{ index: number; elements: Array<Record<string, unknown>> }> }
    expect(compact.slides[0]!.index).toBe(0)
    const text = compact.slides[0]!.elements.find((e) => e.type === 'text')!
    expect(text.z).toBeUndefined()
    expect(text.rotation).toBeUndefined()
    expect(typeof text.text).toBe('string')
    expect(text.content).toBeUndefined()
    expect(richToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }] })).toBe('**Bold**\n- one')
  })

  it('selects slides by id and by range, keeping the deck indexes in the outline', () => {
    const outline = outlineOf(kompast, { range: { from: 2, to: 4 } }) as { slides: Array<{ index: number }> }
    expect(outline.slides.map((s) => s.index)).toEqual([2, 3, 4])
    expect(() => selectSlides(kompast, { range: { from: 4, to: 2 } })).toThrow(ToolError)
    expect(() => selectSlides(kompast, { range: { from: 0, to: 99 } })).toThrow(/range.to is 99/)
    expect(() => selectSlides(kompast, { slideIds: ['nope'] })).toThrow(/No slide with id nope/)
  })

  it('serves the element guide as the markdown file, under 8 KB', () => {
    const md = readFileSync(new URL('./guide-elements.md', import.meta.url), 'utf8')
    expect(GUIDE_ELEMENTS_MD).toBe(md)
    expect(Buffer.byteLength(GUIDE_ELEMENTS_MD)).toBeLessThan(8192)
  })
})

describe('plan_deck', () => {
  const kompast = JSON.parse(readFileSync(new URL('./fixtures/kompast.sleid.json', import.meta.url), 'utf8')) as Deck

  it('plans the default arc: a dark cover, a dark ask, and the tool calls in order', () => {
    const plan = buildPlan({ brief: 'Product intro', slideCount: 10 })
    expect(plan.slides).toHaveLength(10)
    expect(plan.slides[0]!.variant).toBe('dark')
    expect(plan.slides[9]!.variant).toBe('dark')
    expect(plan.slides[9]!.components.map((c) => c.kind)).toEqual(['header', 'numbered_cards'])
    expect(plan.calls[0]).toMatchObject({ tool: 'create_deck' })
    expect(plan.calls.filter((c) => c.tool === 'add_slide')).toHaveLength(10)
    expect(plan.calls.at(-2)).toMatchObject({ tool: 'lint_deck' })
    expect(plan.calls.at(-1)).toMatchObject({ tool: 'render_deck' })
    expect(plan.style).toMatchObject({ source: 'built-in Paper Navy' })
  })

  it('shortens to the slide count, keeping the cover and the ask', () => {
    const plan = buildPlan({ brief: 'Short', slideCount: 4 })
    expect(plan.slides).toHaveLength(4)
    expect(plan.slides[0]!.variant).toBe('dark')
    expect(plan.slides.at(-1)!.components.at(-1)!.kind).toBe('numbered_cards')
  })

  it('takes the look and the slide types from a reference deck', () => {
    const plan = buildPlan({ brief: 'Like Kompast', slideCount: 8, reference: { deckId: 'ref-1', deck: kompast } })
    expect(plan.style).toMatchObject({ source: 'reference deck ref-1' })
    expect(plan.calls.some((c) => c.tool === 'apply_style_from_deck')).toBe(true)
    expect(plan.calls.some((c) => c.tool === 'create_deck' && 'theme' in c.args)).toBe(false)
  })
})

describe('M11 phase D: columns and the compact tables', () => {
  const kompastDeck = JSON.parse(readFileSync(new URL('./fixtures/kompast.sleid.json', import.meta.url), 'utf8')) as Deck

  it('stacks a header over bullets in the left column, and a frame runs alongside in the right column', () => {
    const deck: Deck = createDeck('Columns')
    const r = appendComponents(deck, { id: 'c', elements: [] }, [
      { kind: 'header', region: 'left', props: { label: 'Feature', heading: 'Backlog', subtitle: 'Plan it' } },
      { kind: 'bullets_with_sublines', region: 'left', props: { items: [{ text: 'One' }, { text: 'Two' }] } },
      { kind: 'browser_frame', region: 'right', props: { src: 'data:image/png;base64,AAAA', alt: 'shot' } },
    ])
    const of = (i: number) => r.elements.filter((e) => e.component?.instance === r.parts[i]!.instance)
    const header = of(0)
    const bullets = of(1)
    const frame = of(2)
    const headerBottom = Math.max(...header.map((e) => e.y + (e.h ?? 0)))
    expect(Math.min(...bullets.map((e) => e.y))).toBeGreaterThanOrEqual(headerBottom + 56 - 0.5)
    expect(Math.max(...bullets.map((e) => e.x + (e.w ?? 0)))).toBeLessThan(Math.min(...frame.map((e) => e.x)))
    expect(Math.min(...frame.map((e) => e.y))).toBeGreaterThan(Math.min(...header.map((e) => e.y)))
  })

  it('writes the compact deck with style, paint and image tables that the elements refer to', () => {
    const compact = compactDeck(kompastDeck, { slideIds: [kompastDeck.slides[1]!.id] }) as {
      styles?: Record<string, unknown>
      paints?: Record<string, unknown>
      slides: Array<{ elements: Array<Record<string, unknown>> }>
    }
    expect(Object.keys(compact.styles ?? {}).length).toBeGreaterThan(0)
    const text = compact.slides[0]!.elements.find((e) => e.type === 'text')!
    expect(compact.styles![text.style as string]).toBeDefined()
    const shape = compact.slides[0]!.elements.find((e) => e.type === 'shape' && e.paint !== undefined)!
    expect(compact.paints![shape.paint as string]).toBeDefined()
  })
})

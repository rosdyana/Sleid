import { describe, expect, it } from 'vitest'
import { createDeck, createSlide, DEFAULT_THEME, type Deck, type Slide } from '@sleid/model'
import { deckToMarkdown, markdownToDeck, parseInline } from './markdown.ts'

function titled(title: string, bullets: string[], notes = ''): Slide {
  const slide = createSlide('title-content', DEFAULT_THEME)
  const [titleEl, bodyEl] = slide.elements as [
    Extract<Slide['elements'][number], { type: 'text' }>,
    Extract<Slide['elements'][number], { type: 'text' }>,
  ]
  titleEl.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] }
  bodyEl.content = {
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: bullets.map((b) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: b }] }] })),
      },
    ],
  }
  return { ...slide, notes }
}

function deckOf(slides: Slide[]): Deck {
  return { ...createDeck('MD'), slides }
}

function slideTitle(slide: Slide): string {
  const el = slide.elements.find((e) => e.type === 'text' && e.role === 'title')
  if (!el || el.type !== 'text') return ''
  return (el.content.content ?? []).map((p) => (p.content ?? []).map((n) => n.text ?? '').join('')).join('')
}

function bullets(slide: Slide): string[] {
  const el = slide.elements.find((e) => e.type === 'text' && e.role === 'body')
  if (!el || el.type !== 'text') return []
  const list = (el.content.content ?? []).find((n) => n.type === 'bulletList')
  return (list?.content ?? []).map((item) => (item.content?.[0]?.content ?? []).map((n) => n.text ?? '').join(''))
}

describe('deckToMarkdown and markdownToDeck', () => {
  const deck = deckOf([
    titled('Intro', ['First point', 'Second point'], 'Open with a joke'),
    titled('Results', ['Revenue up', 'Costs down'], 'Line one\nLine two'),
    titled('Thanks', [], ''),
  ])

  it('writes --- between slides and Note: for speaker notes', () => {
    const md = deckToMarkdown(deck)
    expect(md.split(/^---$/m)).toHaveLength(3)
    expect(md).toContain('# Intro')
    expect(md).toContain('- First point')
    expect(md).toContain('Note: Open with a joke')
  })

  it('round-trips slide count, titles, bullets and notes', () => {
    const back = markdownToDeck(deckToMarkdown(deck))
    expect(back.slides).toHaveLength(deck.slides.length)
    expect(back.slides.map(slideTitle)).toEqual(['Intro', 'Results', 'Thanks'])
    expect(back.slides.map(bullets)).toEqual([['First point', 'Second point'], ['Revenue up', 'Costs down'], []])
    expect(back.slides.map((s) => s.notes)).toEqual(['Open with a joke', 'Line one\nLine two', ''])
  })

  it('round-trips again to identical markdown', () => {
    const md = deckToMarkdown(deck)
    expect(deckToMarkdown(markdownToDeck(md))).toBe(md)
  })

  it('keeps empty slides so the slide count survives', () => {
    const empty = deckOf([titled('A', []), { ...createSlide('blank', DEFAULT_THEME), elements: [] }, titled('B', [])])
    const back = markdownToDeck(deckToMarkdown(empty))
    expect(back.slides).toHaveLength(3)
  })

  it('imports hand-written reveal markdown with inline marks, ordered lists and notes', () => {
    const md = [
      '# Plan',
      '',
      'Some **bold** and *italic* text with `code` and [docs](https://example.com).',
      '',
      '1. Step one',
      '2. Step two',
      '',
      'Note: remember the demo',
      '',
      '---',
      '',
      '## Second',
      '',
      '- a',
      '- b',
    ].join('\n')
    const deck2 = markdownToDeck(md)
    expect(deck2.slides).toHaveLength(2)
    expect(deck2.title).toBe('Plan')
    expect(slideTitle(deck2.slides[0]!)).toBe('Plan')
    expect(deck2.slides[0]!.notes).toBe('remember the demo')
    expect(bullets(deck2.slides[1]!)).toEqual(['a', 'b'])
    expect(JSON.stringify(deck2.slides[1]!.elements)).toContain('"type":"heading"')
    const body = deck2.slides[0]!.elements.find((e) => e.type === 'text' && e.role === 'body')
    expect(JSON.stringify(body)).toContain('"bold"')
    expect(JSON.stringify(body)).toContain('"href":"https://example.com/"') // normalised by URL
    expect(JSON.stringify(body)).toContain('"orderedList"')
  })

  it('exports and imports a table', () => {
    const slide = createSlide('blank', DEFAULT_THEME)
    slide.elements = [
      {
        id: 't',
        type: 'table',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        rotation: 0,
        locked: false,
        opacity: 1,
        z: 0,
        rows: [
          ['Name', 'Score'],
          ['Ada | Lovelace', '10'],
        ],
        header: true,
      },
    ]
    const md = deckToMarkdown(deckOf([slide]))
    expect(md).toContain('| Ada \\| Lovelace | 10 |')
    const back = markdownToDeck(md)
    const table = back.slides[0]!.elements.find((e) => e.type === 'table')
    expect(table).toMatchObject({ type: 'table', rows: [['Name', 'Score'], ['Ada | Lovelace', '10']] })
  })

  it('drops unsafe links on export', () => {
    expect(parseInline('plain')).toEqual([{ type: 'text', text: 'plain' }])
    const slide = createSlide('title-content', DEFAULT_THEME)
    const body = slide.elements.find((e) => e.type === 'text' && e.role === 'body')
    if (body?.type === 'text') {
      body.content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
          },
        ],
      }
    }
    const md = deckToMarkdown(deckOf([slide]))
    expect(md).not.toContain('javascript:')
    expect(md).toContain('bad')
  })

  it('uses the first slide title as the deck title unless one is given', () => {
    expect(markdownToDeck(deckToMarkdown(deck)).title).toBe('Intro')
    expect(markdownToDeck(deckToMarkdown(deck), { title: 'Given' }).title).toBe('Given')
  })
})

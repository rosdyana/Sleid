import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, deriveDarkVariant, ElementSchema, resolveTokens, type Theme } from '@sleid/model'
import { z } from 'zod'
import { buildComponent, COMPONENT_KINDS, ComponentPropsSchemas, type ComponentContext, type ComponentKind, type Variant } from './index.ts'
import { regionBox } from '../regions.ts'

const PAPER = BUILT_IN_THEMES.find((t) => t.name === 'Paper Navy') as Theme

const SAMPLES: Record<ComponentKind, unknown> = {
  header: { label: 'Label', heading: 'A heading for the header', subtitle: 'A subtitle line' },
  card_grid: {
    cards: [
      { icon: 'lock', title: 'One', body: 'Body text for the first card.', tint: 'accent' },
      { icon: 'link', title: 'Two', body: 'Body text for the second card.', tint: 'accent2' },
      { title: 'Three without icon', body: 'Plain.' },
    ],
  },
  browser_frame: { src: 'data:image/png;base64,AAAA', alt: 'A screenshot', caption: 'Caption', url: 'x.local' },
  timeline: { steps: [{ title: 'Start', bullets: ['One', 'Two'], outcome: 'Done' }, { title: 'Next', subtitle: 'Later' }] },
  comparison: { beforeLabel: 'Before', afterLabel: 'After', rows: [{ before: 'Old way', after: 'New way' }, { before: 'Slow', after: 'Fast' }] },
  numbered_cards: { items: [{ title: 'Plan', body: 'A plan' }, { title: 'Build', body: 'A build' }] },
  bullets_with_sublines: { items: [{ text: 'First point', sub: 'Detail' }, { text: 'Second point' }] },
  stat_row: { stats: [{ value: '42', label: 'Things', sub: 'More' }, { value: '3x', label: 'Faster' }] },
  footer_and_logo: { footerText: 'Footer', pageNumber: 4 },
}

function ctx(variant: Variant, overrides: Partial<ComponentContext> = {}): ComponentContext {
  const theme = structuredClone(PAPER)
  return {
    theme,
    tokens: resolveTokens(theme),
    variant,
    region: regionBox('body', resolveTokens(theme)),
    instance: 'inst',
    idFor: (part) => `el-${part}`,
    animationStart: 0,
    images: { 'data:image/png;base64,AAAA': { width: 1600, height: 1000 } },
    ...overrides,
  }
}

describe('component kinds and schemas', () => {
  it('lists nine kinds, each with a schema', () => {
    expect(COMPONENT_KINDS).toHaveLength(9)
    for (const k of COMPONENT_KINDS) expect(ComponentPropsSchemas[k]).toBeDefined()
  })

  it.each(COMPONENT_KINDS)('%s builds elements that are valid, tagged and uniquely identified', (kind) => {
    const result = buildComponent(kind, SAMPLES[kind], ctx('light'))
    expect(result.elements.length).toBeGreaterThan(0)
    const ids = new Set<string>()
    const zs = new Set<number>()
    for (const el of result.elements) {
      const parsed = ElementSchema.safeParse(el)
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2))).toBe(true)
      expect(el.component).toEqual({ kind, instance: 'inst', part: expect.any(String) })
      ids.add(el.id!)
      zs.add(el.z!)
    }
    expect(ids.size).toBe(result.elements.length)
    expect(zs.size).toBe(result.elements.length)
    expect(result.bottom).toBeGreaterThanOrEqual(result.box.y)
  })

  it('rejects invalid props with a zod error', () => {
    expect(() => buildComponent('card_grid', { cards: [] }, ctx('light'))).toThrow(z.ZodError)
    expect(() => buildComponent('timeline', { steps: [{ title: 'Only one' }] }, ctx('light'))).toThrow(z.ZodError)
    expect(() => buildComponent('stat_row', { stats: [] }, ctx('light'))).toThrow(z.ZodError)
  })
})

describe('header', () => {
  it('puts the subtitle 8px under the measured heading', () => {
    const result = buildComponent('header', { heading: 'One line heading', subtitle: 'Sub' }, ctx('light'))
    const heading = result.elements.find((e) => e.component?.part === 'heading')!
    const subtitle = result.elements.find((e) => e.component?.part === 'subtitle')!
    expect(subtitle.y).toBeCloseTo(heading.y + heading.h! + 8, 6)
    expect(result.bottom).toBeCloseTo(subtitle.y + subtitle.h!, 6)
  })

  it('animates nothing in the header', () => {
    const result = buildComponent('header', { label: 'L', heading: 'H', subtitle: 'S' }, ctx('light'))
    for (const el of result.elements) expect(el.animation).toBeUndefined()
  })

  it('shows the secondary line in the subtitle slot when there is no subtitle', () => {
    const result = buildComponent('header', { heading: 'H', secondary: 'Kedua' }, ctx('light', { secondaryLanguage: 'id' }))
    expect(result.elements.some((e) => e.component?.part === 'secondary')).toBe(true)
    const none = buildComponent('header', { heading: 'H', secondary: 'Kedua' }, ctx('light'))
    expect(none.elements.some((e) => e.component?.part === 'secondary')).toBe(false)
  })
})

describe('card grid', () => {
  it('gives every card in a row the same height', () => {
    const result = buildComponent('card_grid', SAMPLES.card_grid, ctx('light'))
    const bgs = result.elements.filter((e) => e.component?.part.endsWith('.bg') && e.type === 'shape')
    expect(bgs).toHaveLength(3)
    const heights = new Set(bgs.map((b) => b.h))
    expect(heights.size).toBe(1)
  })

  it('animates card i with order animationStart + i, and all parts of a card together', () => {
    const result = buildComponent('card_grid', SAMPLES.card_grid, ctx('light', { animationStart: 5 }))
    for (const el of result.elements) {
      const card = /^card\.(\d+)\./.exec(el.component!.part)
      if (!card) continue
      expect(el.animation).toEqual({ effect: 'fade-up', order: 5 + Number(card[1]) })
    }
  })

  it('uses the accent tints named by the card', () => {
    const result = buildComponent('card_grid', { cards: [{ icon: 'lock', title: 'T', tint: 'accent3' }] }, ctx('light'))
    const icon = result.elements.find((e) => e.component?.part === 'card.0.icon')! as unknown as { paths: Array<{ stroke: string }> }
    expect(icon.paths[0]!.stroke).toBe(PAPER.colors.accent3)
  })

  it('wraps the secondary line when the deck has a secondary language', () => {
    const plain = buildComponent('card_grid', { cards: [{ title: 'T', secondary: 'Kedua' }] }, ctx('light'))
    const bilingual = buildComponent('card_grid', { cards: [{ title: 'T', secondary: 'Kedua' }] }, ctx('light', { secondaryLanguage: 'id' }))
    expect(plain.elements.some((e) => e.component?.part === 'card.0.secondary')).toBe(false)
    expect(bilingual.elements.some((e) => e.component?.part === 'card.0.secondary')).toBe(true)
  })

  it('uses autoColumns: 4 cards get four columns on a wide region', () => {
    const cards = Array.from({ length: 4 }, (_, i) => ({ title: `T${i}`, body: 'b' }))
    const wide = buildComponent('card_grid', { cards }, ctx('light', { region: { x: 106, y: 303, w: 1708, h: 600 } }))
    const xs = new Set(wide.elements.filter((e) => e.component?.part.endsWith('.bg')).map((e) => e.y))
    expect(xs.size).toBe(1)
    const bgs = wide.elements.filter((e) => e.component?.part.endsWith('.bg'))
    expect(new Set(bgs.map((b) => b.x)).size).toBe(4)
  })
})

describe('dark variant', () => {
  it('draws text, muted text and labels in the dark variant colours', () => {
    const dv = deriveDarkVariant(PAPER)
    const result = buildComponent('header', { label: 'L', heading: 'H', subtitle: 'S' }, ctx('dark', { region: regionBox('center', resolveTokens(PAPER)) }))
    const heading = result.elements.find((e) => e.component?.part === 'heading')!
    expect((heading as unknown as { style: { color: string } }).style.color).toBe(dv.text)
    const label = result.elements.find((e) => e.component?.part === 'label')!
    expect((label as unknown as { style: { color: string } }).style.color).toBe(dv.accent)
  })

  it('uses the dark surface for cards', () => {
    const dv = deriveDarkVariant(PAPER)
    const result = buildComponent('numbered_cards', SAMPLES.numbered_cards, ctx('dark'))
    const bg = result.elements.find((e) => e.component?.part === 'card.0.bg')!
    expect((bg as unknown as { fill: string }).fill).toBe(dv.surface)
    expect((bg as unknown as { stroke: string }).stroke).toBe(dv.stroke)
  })
})

describe('browser frame', () => {
  it('fits the frame in the region and keeps the image aspect ratio', () => {
    const region = { x: 100, y: 300, w: 1000, h: 600 }
    const result = buildComponent('browser_frame', { src: 'data:image/png;base64,AAAA', alt: 'Shot' }, ctx('light', { region }))
    const bg = result.elements.find((e) => e.component?.part === 'frame.bg')!
    expect(bg.x).toBeGreaterThanOrEqual(region.x - 0.01)
    expect(bg.x + bg.w!).toBeLessThanOrEqual(region.x + region.w + 0.01)
    expect(bg.y + bg.h!).toBeLessThanOrEqual(region.y + region.h + 0.01)
    const image = result.elements.find((e) => e.component?.part === 'frame.image')!
    expect(image.w / image.h).toBeCloseTo(1600 / 1000, 1)
    expect(image.alt).toBe('Shot')
  })

  it('uses 16:10 when the image size is unknown', () => {
    const result = buildComponent('browser_frame', { src: 'unknown', alt: 'Shot' }, ctx('light', { images: {} }))
    const image = result.elements.find((e) => e.component?.part === 'frame.image')!
    // The image starts 13.2px under the bar; its visible height is image.h minus that overlap.
    expect(image.w / (image.h - 13.2)).toBeCloseTo(1.6, 1)
  })

  it('draws the three window dots, and an empty URL pill when no url is given', () => {
    const result = buildComponent('browser_frame', { src: 'x', alt: 'a' }, ctx('light'))
    const dots = result.elements.filter((e) => e.component?.part.startsWith('frame.dot.'))
    expect(dots.map((d) => (d as unknown as { fill: string }).fill)).toEqual(['#ff5f57', '#febc2e', '#28c840'])
    expect(result.elements.some((e) => e.component?.part === 'frame.url-pill')).toBe(true)
    expect(result.elements.some((e) => e.component?.part === 'frame.url')).toBe(false)
    const withUrl = buildComponent('browser_frame', { src: 'x', alt: 'a', url: 'app.example/board' }, ctx('light'))
    const url = withUrl.elements.find((e) => e.component?.part === 'frame.url') as unknown as { content: { content: Array<{ content: Array<{ text: string }> }> } }
    expect(url.content.content[0]!.content[0]!.text).toBe('app.example/board')
  })
})

describe('timeline', () => {
  it('numbers the circles 01, 02 and so on, and puts the outcome after an arrow', () => {
    const result = buildComponent('timeline', SAMPLES.timeline, ctx('light'))
    const numbers = result.elements.filter((e) => e.component?.part.endsWith('.number')) as unknown as Array<{ content: { content: Array<{ content: Array<{ text: string }> }> } }>
    expect(numbers.map((n) => n.content.content[0]!.content[0]!.text)).toEqual(['01', '02'])
    const outcome = result.elements.find((e) => e.component?.part === 'step.0.outcome') as unknown as { content: { content: Array<{ content: Array<{ text: string }> }> } }
    expect(outcome.content.content[0]!.content[0]!.text).toBe('→ Done')
  })
})

describe('comparison', () => {
  it('uses a cross for before and a tick for after', () => {
    const result = buildComponent('comparison', SAMPLES.comparison, ctx('light'))
    expect(result.elements.some((e) => e.component?.part === 'row.0.cross')).toBe(true)
    expect(result.elements.some((e) => e.component?.part === 'row.0.tick')).toBe(true)
  })
})

describe('footer and logo', () => {
  it('uses the dark logo on dark slides when given', () => {
    const props = { logoSrc: 'data:image/png;base64,LIGHT', logoSrcDark: 'data:image/png;base64,DARK' }
    const light = buildComponent('footer_and_logo', props, ctx('light'))
    const dark = buildComponent('footer_and_logo', props, ctx('dark'))
    expect((light.elements[0] as unknown as { src: string }).src).toContain('LIGHT')
    expect((dark.elements[0] as unknown as { src: string }).src).toContain('DARK')
    expect((light.elements[0] as unknown as { alt: string }).alt).toBe('Logo')
  })
})

describe('tokens', () => {
  it('resolves tokens from the theme when none are passed', () => {
    const { tokens: _ignored, ...rest } = ctx('light')
    const result = buildComponent('header', { heading: 'H' }, rest as ComponentContext)
    expect(result.elements.length).toBe(1)
  })
})

describe('Kompast ratios (M11 phase D)', () => {
  it('draws a cover header (centre region) at the theme title size, with a larger subtitle', () => {
    const c = ctx('dark', { regionName: 'center' })
    const result = buildComponent('header', { heading: 'Sleid', subtitle: 'Slides for teams' }, c)
    const heading = result.elements.find((e) => e.component?.part === 'heading') as unknown as { style: { fontSize: number } }
    const subtitle = result.elements.find((e) => e.component?.part === 'subtitle') as unknown as { style: { fontSize: number } }
    expect(heading.style.fontSize).toBe(PAPER.sizes.title)
    expect(subtitle.style.fontSize).toBeCloseTo(resolveTokens(PAPER).body.size * 1.7, 0)
  })

  it('keeps the ask heading at 1.222 of the heading size when size is ask', () => {
    const result = buildComponent('header', { heading: 'Ask', size: 'ask' }, ctx('light'))
    const heading = result.elements.find((e) => e.component?.part === 'heading') as unknown as { style: { fontSize: number } }
    expect(heading.style.fontSize).toBeCloseTo(resolveTokens(PAPER).heading.size * 1.222, 0)
  })

  it('pins a card secondary line to the bottom of a taller card, under the body', () => {
    const c = ctx('light', { secondaryLanguage: 'zh-TW' })
    const result = buildComponent('card_grid', { cards: [{ title: 'Private', body: 'Only members.', secondary: '僅限成員' }] }, c)
    const sec = result.elements.find((e) => e.component?.part === 'card.0.secondary')!
    const bg = result.elements.find((e) => e.component?.part === 'card.0.bg')!
    expect(sec.y + sec.h!).toBeCloseTo(bg.y + bg.h! - 36, 0)
    expect(result.box.h).toBeGreaterThan(300)
    expect(result.box.h).toBeLessThanOrEqual(460 + 1)
  })
})

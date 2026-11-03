// A ten-slide demo deck on the Paper Navy theme. Every component kind appears at least once, and the cover and the closing ask
// use the dark variant. Used by the lint test and for render checks.
import { BUILT_IN_THEMES, deriveDarkVariant, type Deck, type Element, resolveTokens, type Slide, type Theme } from '@sleid/model'
import { buildComponent, type ComponentKind, type ComponentResult, type Variant } from './components/index.ts'
import { regionBox, bodyTopAfter, type Box, type RegionName } from './regions.ts'

/** A 1x1 transparent PNG, for screenshot placeholders. */
export const DEMO_IMAGE_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const PAPER_NAVY: Theme = (() => {
  const t = BUILT_IN_THEMES.find((th) => th.name === 'Paper Navy')
  if (!t) throw new Error('Paper Navy theme missing from the model')
  return t
})()

class SlideBuilder {
  readonly elements: Element[] = []
  private nextOrder = 0
  private count = 0

  constructor(
    readonly id: string,
    readonly variant: Variant,
    readonly theme: Theme,
    readonly images: Record<string, { width: number; height: number }> = {},
  ) {}

  /** Adds a component in a region. Its animation orders start after the slide's existing ones. */
  add(kind: ComponentKind, props: unknown, region: Box | RegionName, opts: { bodyTop?: number } = {}): ComponentResult {
    const tokens = resolveTokens(this.theme)
    const box = typeof region === 'string' ? regionBox(region, tokens, opts) : region
    const instance = `${kind}-${this.count++}`
    const result = buildComponent(kind, props, {
      theme: this.theme,
      tokens,
      variant: this.variant,
      region: box,
      instance,
      idFor: (part) => `${this.id}-${instance}-${part}`,
      animationStart: this.nextOrder,
      zBase: this.elements.length,
      images: this.images,
    })
    for (const el of result.elements) {
      this.elements.push(el as Element)
      const order = el.animation?.order
      if (order !== undefined) this.nextOrder = Math.max(this.nextOrder, order + 1)
    }
    return result
  }

  /** Header, then the body under it: the header's bottom sets the body's top. */
  header(props: { label?: string; heading: string; subtitle?: string }): number {
    const h = this.add('header', props, 'full')
    return bodyTopAfter(h.bottom)
  }

  body(kind: ComponentKind, props: unknown, bodyTop: number): ComponentResult {
    return this.add(kind, props, 'body', { bodyTop })
  }

  footer(pageNumber: number, text = 'Sleid · demo deck'): void {
    this.add('footer_and_logo', { footerText: text, pageNumber }, 'full')
  }

  build(background?: Slide['background']): Slide {
    return {
      id: this.id,
      layout: 'blank',
      notes: '',
      transition: 'none',
      autoAnimate: false,
      hidden: false,
      ...(this.variant === 'dark' ? { variant: 'dark' as const } : {}),
      ...(background ? { background } : {}),
      elements: this.elements,
    }
  }
}

/** The demo deck. Each call returns a fresh object. */
export function demoDeck(): Deck {
  const theme = structuredClone(PAPER_NAVY)
  const dark = deriveDarkVariant(theme)
  const darkBackground: Slide['background'] = { type: dark.background.type, value: dark.background.value }
  const images = { [DEMO_IMAGE_SRC]: { width: 1600, height: 1000 } }
  const slides: Slide[] = []

  // 1. Dark cover.
  {
    const s = new SlideBuilder('demo-1', 'dark', theme, images)
    s.add('header', { label: 'Demo · Sleid components', heading: 'Sleid components on Paper Navy', subtitle: 'Every component kind, with the dark variant on the cover and the ask.' }, 'center')
    s.footer(1)
    slides.push(s.build(darkBackground))
  }

  // 2. Three cards.
  {
    const s = new SlideBuilder('demo-2', 'light', theme, images)
    const top = s.header({ label: 'Cards · three', heading: 'Three cards, equal height', subtitle: 'Each row is as tall as its tallest card.' })
    s.body(
      'card_grid',
      {
        cards: [
          { icon: 'lock', title: 'Private by default', body: 'Decks stay on your server, with access by team.', tint: 'accent' },
          { icon: 'link', title: 'Links that last', body: 'Share a link, and revoke it when the work ends.', tint: 'accent2' },
          { icon: 'eye-off', title: 'Less exposure', body: 'Only the people who need a slide see it.', tint: 'accent4' },
        ],
      },
      top,
    )
    s.footer(2)
    slides.push(s.build())
  }

  // 3. Four cards, four columns.
  {
    const s = new SlideBuilder('demo-3', 'light', theme, images)
    const top = s.header({ label: 'Cards · four', heading: 'Four cards on a wide slide', subtitle: 'Four columns when the region is wide enough.' })
    s.body(
      'card_grid',
      {
        cards: [
          { icon: 'copy', title: 'Reuse', body: 'Start from a template, not a blank page.', tint: 'accent' },
          { icon: 'key', title: 'Access', body: 'Per-team keys and roles.', tint: 'accent2' },
          { icon: 'check', title: 'Review', body: 'A checklist before a slide goes out.', tint: 'accent3' },
          { icon: 'x', title: 'Retire', body: 'Archive what no longer applies.', tint: 'accent4' },
        ],
      },
      top,
    )
    s.footer(3)
    slides.push(s.build())
  }

  // 4. Browser frame with a screenshot.
  {
    const s = new SlideBuilder('demo-4', 'light', theme, images)
    const top = s.header({ label: 'Demo · screenshot', heading: 'A screenshot in a browser window', subtitle: 'Fitted to the region, with its aspect ratio kept.' })
    s.body('browser_frame', { src: DEMO_IMAGE_SRC, url: 'sleid.local/deck', alt: 'Placeholder screenshot of the deck editor', caption: 'Figure: the editor on a 16:10 display.' }, top)
    s.footer(4)
    slides.push(s.build())
  }

  // 5. Timeline.
  {
    const s = new SlideBuilder('demo-5', 'light', theme, images)
    const top = s.header({ label: 'Plan · four phases', heading: 'Four phases, each with an exit', subtitle: 'Every phase ends with a check.' })
    s.body(
      'timeline',
      {
        steps: [
          { title: 'Prepare', subtitle: 'Week 1', bullets: ['Inventory the content', 'Pick the owners'], outcome: 'A list of what moves' },
          { title: 'Pilot', subtitle: 'Weeks 2 and 3', bullets: ['One team, one deck'], outcome: 'Feedback on the flow' },
          { title: 'Roll out', subtitle: 'Weeks 4 to 6', bullets: ['Teams in waves', 'Training sessions'], outcome: 'Every team is live' },
          { title: 'Review', bullets: ['Retire the old tools'], outcome: 'Done, and measured' },
        ],
      },
      top,
    )
    s.footer(5)
    slides.push(s.build())
  }

  // 6. Comparison.
  {
    const s = new SlideBuilder('demo-6', 'light', theme, images)
    const top = s.header({ label: 'Why change', heading: 'What changes for the team', subtitle: 'Before and after, row by row.' })
    s.body(
      'comparison',
      {
        beforeLabel: 'Today',
        afterLabel: 'With Sleid',
        rows: [
          { before: 'Decks are emailed around', after: 'One link, always current' },
          { before: 'Edits collide', after: 'Live co-editing with history' },
          { before: 'Logos drift between slides', after: 'Brand kit applied to every slide' },
        ],
      },
      top,
    )
    s.footer(6)
    slides.push(s.build())
  }

  // 7. Bullets with sub lines.
  {
    const s = new SlideBuilder('demo-7', 'light', theme, images)
    const top = s.header({ label: 'Notes · list', heading: 'Three points, with detail', subtitle: 'Each point has a short sub line.' })
    s.body(
      'bullets_with_sublines',
      {
        items: [
          { text: 'Templates keep the look', sub: 'Every new deck starts from the same type scale.' },
          { text: 'Components save time', sub: 'Cards, timelines and comparisons lay themselves out.' },
          { text: 'Lint catches the rest', sub: 'Overflow, overlap and contrast are checked before you present.' },
        ],
      },
      top,
    )
    s.footer(7)
    slides.push(s.build())
  }

  // 8. Stat row.
  {
    const s = new SlideBuilder('demo-8', 'light', theme, images)
    const top = s.header({ label: 'Results · pilot', heading: 'The pilot in three numbers', subtitle: 'Measured over the first six weeks.' })
    s.body(
      'stat_row',
      {
        stats: [
          { value: '42', label: 'Decks moved', sub: 'Across four teams' },
          { value: '3×', label: 'Faster reviews', sub: 'Median time to approve' },
          { value: '0', label: 'Broken links', sub: 'Since the cutover' },
        ],
      },
      top,
    )
    s.footer(8)
    slides.push(s.build())
  }

  // 9. Numbered cards, light.
  {
    const s = new SlideBuilder('demo-9', 'light', theme, images)
    const top = s.header({ label: 'Steps · numbered', heading: 'Three steps to start', subtitle: 'Numbered cards keep the order clear.' })
    s.body(
      'numbered_cards',
      {
        items: [
          { title: 'Pick a template', body: 'Start from a theme that fits the audience.' },
          { title: 'Add the content', body: 'Use cards, timelines and comparisons.' },
          { title: 'Check and share', body: 'Lint runs before the link goes out.' },
        ],
      },
      top,
    )
    s.footer(9)
    slides.push(s.build())
  }

  // 10. Dark ask.
  {
    const s = new SlideBuilder('demo-10', 'dark', theme, images)
    const top = s.header({ label: 'The ask · decisions', heading: 'Approve the pilot.', subtitle: 'Three decisions for this quarter.' })
    s.body(
      'numbered_cards',
      {
        items: [
          { title: 'Approve the plan', body: 'Six weeks, four teams, one owner.' },
          { title: 'Fund the setup', body: 'Hosting and two weeks of design time.' },
          { title: 'Name the champions', body: 'One migration champion per team.' },
        ],
      },
      top,
    )
    s.footer(10)
    slides.push(s.build(darkBackground))
  }

  return {
    id: 'demo-deck',
    title: 'Sleid components demo',
    size: { w: 1920, h: 1080 },
    theme,
    sections: [],
    slides,
    version: 1,
  }
}

// plan_deck: a deterministic plan for a deck, with no model call. It picks a slide sequence (from a reference deck's
// archetypes, or a default product-introduction arc), the components for each slide with placeholder text, and the exact
// tool sequence to build it. Pure: the caller reads the reference deck and passes its style in.
import { BUILT_IN_THEMES, deriveDarkVariant, type Deck, type Theme } from '@sleid/model'
import { deriveStyle, type Archetype, type DeckStyle } from '@sleid/compose'

export const PLAN_DEFAULT_SLIDES = 10
export const PLAN_MIN_SLIDES = 3
export const PLAN_MAX_SLIDES = 30
export const PLAN_THEME = 'Paper Navy'

type Beat = 'cover' | 'problem' | 'compare' | 'feature' | 'stats' | 'timeline' | 'bullets' | 'ask'

interface PlanComponent {
  kind: string
  props: Record<string, unknown>
  region?: string
}

interface BeatSpec {
  purpose: string
  variant: 'light' | 'dark'
  components: PlanComponent[]
}

const BEATS: Record<Beat, () => BeatSpec> = {
  cover: () => ({
    purpose: 'Cover: the product name and one line on what it does',
    variant: 'dark',
    components: [{ kind: 'header', region: 'center', props: { label: '<label, e.g. Product introduction>', heading: '<product name>', subtitle: '<one-line promise>' } }],
  }),
  problem: () => ({
    purpose: 'The problem: three pains, one card each',
    variant: 'light',
    components: [
      { kind: 'header', props: { label: 'The problem', heading: '<the problem in one line>' } },
      {
        kind: 'card_grid',
        props: {
          cards: [1, 2, 3].map((i) => ({ icon: '<lucide icon name>', title: `<pain ${i}>`, body: '<one sentence>' })),
        },
      },
    ],
  }),
  compare: () => ({
    purpose: 'Today versus after: four rows',
    variant: 'light',
    components: [
      { kind: 'header', props: { label: 'Before and after', heading: '<what changes>' } },
      {
        kind: 'comparison',
        props: { beforeLabel: 'Today', afterLabel: '<product>', rows: [1, 2, 3, 4].map(() => ({ before: '<today>', after: '<with the product>' })) },
      },
    ],
  }),
  feature: () => ({
    purpose: 'A feature, as Kompast slides 5 to 8: headline and bullets in the left column, a screenshot in a browser frame on the right',
    variant: 'light',
    components: [
      { kind: 'header', region: 'left', props: { label: 'Feature', heading: '<feature headline>', subtitle: '<what it gives the user>' } },
      { kind: 'bullets_with_sublines', region: 'left', props: { items: [1, 2, 3].map((i) => ({ text: `<point ${i}>`, sub: '<detail>' })) } },
      { kind: 'browser_frame', region: 'right', props: { assetId: '<asset id from upload_asset>', alt: '<what the screenshot shows>', caption: '<caption>' } },
    ],
  }),
  stats: () => ({
    purpose: 'Numbers: three figures from the brief (never invented)',
    variant: 'light',
    components: [
      { kind: 'header', props: { label: 'By the numbers', heading: '<the point the numbers make>' } },
      { kind: 'stat_row', props: { stats: [1, 2, 3].map(() => ({ value: '<number>', label: '<what it counts>', sub: '<source or period>' })) } },
    ],
  }),
  timeline: () => ({
    purpose: 'A process or roadmap: four steps',
    variant: 'light',
    components: [
      { kind: 'header', props: { label: 'How it works', heading: '<the process in one line>' } },
      { kind: 'timeline', props: { steps: [1, 2, 3, 4].map((i) => ({ title: `<step ${i}>`, subtitle: '<when>', outcome: '<result>' })) } },
    ],
  }),
  bullets: () => ({
    purpose: 'Supporting points: three to five bullets with a sub line',
    variant: 'light',
    components: [
      { kind: 'header', props: { label: 'Why it matters', heading: '<the claim>' } },
      { kind: 'bullets_with_sublines', props: { items: [1, 2, 3].map((i) => ({ text: `<point ${i}>`, sub: '<detail>' })) } },
    ],
  }),
  ask: () => ({
    purpose: 'The ask: three numbered next steps on a dark slide',
    variant: 'dark',
    components: [
      { kind: 'header', props: { label: 'Next steps', heading: '<the decision you want>' } },
      { kind: 'numbered_cards', props: { items: [1, 2, 3].map((i) => ({ title: `<step ${i}>`, body: '<what happens>' })) } },
    ],
  }),
}

/** Reference archetypes (from deriveStyle) to the beat that draws them. */
const ARCHETYPE_BEAT: Record<Archetype, Beat> = {
  cover: 'cover',
  'header+cards': 'problem',
  'header+screenshot': 'feature',
  demo: 'feature',
  timeline: 'timeline',
  comparison: 'compare',
  ask: 'ask',
  other: 'bullets',
}

const DEFAULT_ARC: Beat[] = ['cover', 'problem', 'compare', 'feature', 'feature', 'feature', 'stats', 'timeline', 'bullets', 'ask']
/** What to drop first when the deck is shorter than the arc. The cover and the ask always stay. */
const DROP_ORDER: Beat[] = ['bullets', 'timeline', 'stats', 'feature', 'compare', 'problem']

function fitArc(arc: Beat[], count: number): Beat[] {
  const out = [...arc]
  for (const drop of DROP_ORDER) {
    while (out.length > count) {
      const at = out.lastIndexOf(drop)
      if (at < 0) break
      out.splice(at, 1)
    }
  }
  while (out.length < count) {
    const at = out.indexOf('stats')
    out.splice(at >= 0 ? at : out.length - 1, 0, 'feature')
  }
  return out.slice(0, count)
}

/** The beats for a reference deck's archetypes, in order, cycled to the slide count. */
function beatsFromReference(style: DeckStyle, count: number): Beat[] {
  const seq = style.archetypes.map((a) => ARCHETYPE_BEAT[a.archetype])
  if (seq.length === 0) return fitArc(DEFAULT_ARC, count)
  const out: Beat[] = []
  for (let i = 0; i < count; i++) out.push(seq[i % seq.length]!)
  return out
}

function themeSummary(theme: Theme): Record<string, unknown> {
  return { name: theme.name, colors: theme.colors, fonts: theme.fonts, sizes: theme.sizes, radius: theme.radius }
}

export interface PlanInput {
  brief: string
  audience?: string | undefined
  slideCount: number
  secondaryLanguage?: string | undefined
  /** The reference deck, when there is one. Its style and archetypes shape the plan. */
  reference?: { deckId: string; deck: Deck } | undefined
}

export interface PlanOutput {
  brief: string
  audience: string | null
  style: Record<string, unknown>
  slides: Array<{ index: number; purpose: string; variant: 'light' | 'dark'; components: PlanComponent[]; notes: string }>
  calls: Array<{ tool: string; args: Record<string, unknown> }>
}

/** The plan. Deterministic: the same input gives the same output. */
export function buildPlan(input: PlanInput): PlanOutput {
  let style: Record<string, unknown>
  let beats: Beat[]
  let theme: Theme
  if (input.reference) {
    const derived = deriveStyle(input.reference.deck)
    theme = derived.theme
    const dark = derived.darkVariant?.background ?? deriveDarkVariant(derived.theme).background
    style = {
      source: `reference deck ${input.reference.deckId}`,
      ...themeSummary(theme),
      typeScale: derived.typeScale,
      card: derived.card ?? null,
      darkBackground: dark,
      archetypes: derived.archetypes.map((a) => a.archetype),
    }
    beats = beatsFromReference(derived, input.slideCount)
  } else {
    theme = BUILT_IN_THEMES.find((t) => t.name === PLAN_THEME) ?? BUILT_IN_THEMES[0]!
    style = { source: `built-in ${PLAN_THEME}`, ...themeSummary(theme), darkBackground: deriveDarkVariant(theme).background }
    beats = fitArc(DEFAULT_ARC, input.slideCount)
  }

  const slides = beats.map((beat, index) => {
    const spec = BEATS[beat]()
    return { index, purpose: spec.purpose, variant: spec.variant, components: spec.components, notes: '<what the presenter says on this slide>' }
  })
  const deckRef = '<deckId from create_deck>'
  const features = slides.filter((s) => s.components.some((c) => c.kind === 'browser_frame')).length
  const calls: PlanOutput['calls'] = [
    { tool: 'create_deck', args: input.reference ? { title: input.brief.slice(0, 120) } : { title: input.brief.slice(0, 120), theme: PLAN_THEME } },
  ]
  if (input.reference) calls.push({ tool: 'apply_style_from_deck', args: { sourceDeckId: input.reference.deckId, targetDeckId: deckRef } })
  if (input.secondaryLanguage) calls.push({ tool: 'set_deck_options', args: { deckId: deckRef, secondaryLanguage: input.secondaryLanguage } })
  for (let i = 0; i < features; i++) calls.push({ tool: 'upload_asset', args: { deckId: deckRef, name: `screenshot-${i + 1}.png`, mime: 'png', base64: '<file, base64>' } })
  for (const slide of slides) {
    calls.push({ tool: 'add_slide', args: { deckId: deckRef, variant: slide.variant, components: slide.components } })
  }
  calls.push({ tool: 'lint_deck', args: { deckId: deckRef } })
  calls.push({ tool: 'render_deck', args: { deckId: deckRef, mode: 'sheet' } })

  return {
    brief: input.brief,
    audience: input.audience ?? null,
    style,
    slides,
    calls,
  }
}

export type { DeckStyle }

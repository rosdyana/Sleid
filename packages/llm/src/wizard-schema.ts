// Schemas for the prompt-to-deck wizard: the brief, the outline the model drafts, and the slide it writes.
// The outline is the user's contract before generation, so it is validated on every save.
import { z } from 'zod'
import { BUILT_IN_THEMES } from '@sleid/model'

export const WIZARD_GOALS = ['inform', 'persuade', 'teach', 'report', 'pitch'] as const
export const VISUALS = ['none', 'chart', 'diagram', 'image-placeholder'] as const
/** Layouts a wizard slide may use. Image layouts need a picture, which the wizard does not supply. */
export const WIZARD_LAYOUTS = ['title', 'title-content', 'two-column', 'section', 'quote', 'blank'] as const
export type WizardLayout = (typeof WIZARD_LAYOUTS)[number]

/** The theme choice that asks the model for colours. It cannot be combined with a brand kit (the kit's palette is the rule). */
export const AI_THEME = 'AI from brand colours'
export const THEME_CHOICES = [...BUILT_IN_THEMES.map((t) => t.name), AI_THEME] as const

/** A template a run starts from: a user template's id, or a built-in one's `builtin:<key>`. */
export const WizardTemplateRef = z.union([z.uuid(), z.string().regex(/^builtin:[a-z0-9-]+$/)])

export const WizardBrief = z.object({
  prompt: z.string().trim().min(1, 'Describe the deck').max(4000),
  audience: z.string().trim().max(200).optional().default(''),
  goal: z.enum(WIZARD_GOALS).default('inform'),
  slideCount: z.number().int().min(3).max(30).default(10),
  tone: z.string().trim().max(100).optional().default(''),
  /** BCP 47 tag, for example "id" or "en". The browser locale is the default. */
  language: z.string().trim().min(2).max(35).default('en'),
  theme: z.string().trim().min(1).max(60).default('Sheets Light'),
  brandColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(4).optional(),
  includeNotes: z.boolean().default(true),
  includeCharts: z.boolean().default(true),
  includeSources: z.boolean().default(true),
  research: z.boolean().default(false),
  /** A template to start from (its theme, and its layouts as the preferred layouts of the outline). Visibility is checked at run creation. */
  templateId: WizardTemplateRef.optional(),
  /** A brand kit to apply (its theme, its logo, and the constraint on the model's colours). Visibility is checked at run creation. */
  brandKitId: z.uuid().optional(),
})
export type WizardBrief = z.infer<typeof WizardBrief>

export const OutlineSlide = z.object({
  title: z.string().trim().min(1).max(120),
  layout: z.enum(WIZARD_LAYOUTS).default('title-content'),
  keyPoints: z.array(z.string().trim().min(1).max(200)).max(6),
  visual: z.enum(VISUALS).default('none'),
  /** Ids of the sources this slide draws on. Unknown ids are removed on save. */
  sourceIds: z.array(z.string().min(1).max(60)).max(10).default([]),
})
export type OutlineSlide = z.infer<typeof OutlineSlide>

export const Outline = z.object({
  title: z.string().trim().min(1).max(160),
  slides: z.array(OutlineSlide).min(1).max(30),
})
export type Outline = z.infer<typeof Outline>

/** Keeps only the source ids that exist. Called on every outline the model drafts and every edit the user saves. */
export function withKnownSources(outline: Outline, knownIds: ReadonlySet<string>): Outline {
  return {
    ...outline,
    slides: outline.slides.map((s) => ({ ...s, sourceIds: [...new Set(s.sourceIds.filter((id) => knownIds.has(id)))] })),
  }
}

// Pure outline edits, used by the editor and by the tests. Each returns a new outline and never mutates its input.
export function renameSlideAt(outline: Outline, index: number, title: string): Outline {
  return { ...outline, slides: outline.slides.map((s, i) => (i === index ? { ...s, title } : s)) }
}

export function reorderSlides(outline: Outline, from: number, to: number): Outline {
  if (from === to) return outline
  const slides = [...outline.slides]
  const [moved] = slides.splice(from, 1)
  if (!moved) return outline
  slides.splice(to, 0, moved)
  return { ...outline, slides }
}

export function deleteSlideAt(outline: Outline, index: number): Outline {
  if (outline.slides.length <= 1) throw new Error('An outline needs at least one slide.')
  return { ...outline, slides: outline.slides.filter((_, i) => i !== index) }
}

export function addSlideAfter(outline: Outline, index: number): Outline {
  const slide: OutlineSlide = { title: 'New slide', layout: 'title-content', keyPoints: [], visual: 'none', sourceIds: [] }
  const slides = [...outline.slides]
  slides.splice(index + 1, 0, slide)
  if (slides.length > 30) throw new Error('A deck has at most 30 slides.')
  return { ...outline, slides }
}

export function setKeyPointsAt(outline: Outline, index: number, keyPoints: string[]): Outline {
  return { ...outline, slides: outline.slides.map((s, i) => (i === index ? { ...s, keyPoints } : s)) }
}

/** The wizard layouts a deck's slides use, in first-use order, without duplicates. Used as a template's preferred layouts. */
export function wizardLayoutsOf(layouts: readonly string[]): WizardLayout[] {
  const out: WizardLayout[] = []
  for (const layout of layouts) {
    if ((WIZARD_LAYOUTS as readonly string[]).includes(layout) && !out.includes(layout as WizardLayout)) out.push(layout as WizardLayout)
  }
  return out
}

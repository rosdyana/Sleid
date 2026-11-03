// The ability registry: names, the op allowlist of each one, and the dispatcher.
// The allowlists are part of the safety model (see docs/DESIGN.md, M4). Changing one is a
// review item, and the tests in abilities.test.ts pin them.
import type { OpName } from '@sleid/model'
import { LlmError } from '../errors.ts'
import { ALL_OP_NAMES, type AbilityEnv, type AbilityOutcome } from './common.ts'
import { rewriteText, RewriteTextInput } from './rewrite-text.ts'
import { generateSlide, GenerateSlideInput } from './generate-slide.ts'
import { generateChart, GenerateChartInput } from './generate-chart.ts'
import { generateDiagram, GenerateDiagramInput } from './generate-diagram.ts'
import { generateTheme, GenerateThemeInput } from './generate-theme.ts'
import { suggestEffects, SuggestEffectsInput } from './suggest-effects.ts'
import { speakerNotes, SpeakerNotesInput } from './speaker-notes.ts'
import { altText, AltTextInput } from './alt-text.ts'
import { translate, TranslateInput } from './translate.ts'
import { explain, ExplainInput } from './explain.ts'
import { brandConstraintFor, constrainOpsToBrand } from '../brand-constraint.ts'

export const ABILITY_OPS: Record<string, readonly OpName[]> = {
  rewriteText: ['updateElement'],
  generateSlide: ['addSlide', 'addElement'],
  // addSlide: the new slide when there is no room on the target. deleteElement: only empty placeholder text boxes
  // that a new element covers (see place-element.ts). Neither can delete or change a non-empty element.
  generateChart: ['addElement', 'updateElement', 'addSlide', 'deleteElement'],
  generateDiagram: ['addElement', 'updateElement', 'addSlide', 'deleteElement'],
  generateTheme: ['setTheme'],
  suggestEffects: ['updateSlide', 'updateElement'],
  speakerNotes: ['setNotes'],
  altText: ['updateElement'],
  translate: ['updateElement'],
  explain: [],
  chat: ALL_OP_NAMES,
}

export const ABILITY_NAMES = Object.keys(ABILITY_OPS) as Array<keyof typeof ABILITY_OPS>

export type AbilityName = (typeof ABILITY_NAMES)[number]

const INPUTS = {
  rewriteText: RewriteTextInput,
  generateSlide: GenerateSlideInput,
  generateChart: GenerateChartInput,
  generateDiagram: GenerateDiagramInput,
  generateTheme: GenerateThemeInput,
  suggestEffects: SuggestEffectsInput,
  speakerNotes: SpeakerNotesInput,
  altText: AltTextInput,
  translate: TranslateInput,
  explain: ExplainInput,
} as const

export type AbilityInputs = {
  rewriteText: RewriteTextInput
  generateSlide: GenerateSlideInput
  generateChart: GenerateChartInput
  generateDiagram: GenerateDiagramInput
  generateTheme: GenerateThemeInput
  suggestEffects: SuggestEffectsInput
  speakerNotes: SpeakerNotesInput
  altText: AltTextInput
  translate: TranslateInput
  explain: ExplainInput
}

/**
 * Runs a single-purpose ability. The input is checked against its schema first. When the deck has a brand
 * kit, the outcome's ops are snapped to the kit's palette and fonts, and each change is added to the warnings.
 */
export async function runAbility<N extends keyof AbilityInputs>(name: N, env: AbilityEnv, input: unknown): Promise<AbilityOutcome> {
  const outcome = await runAbilityUnconstrained(name, env, input)
  const constraint = brandConstraintFor(env.deck)
  if (!constraint || outcome.ops.length === 0) return outcome
  const constrained = constrainOpsToBrand(outcome.ops, constraint)
  return { ...outcome, ops: constrained.ops, warnings: [...outcome.warnings, ...constrained.warnings] }
}

async function runAbilityUnconstrained<N extends keyof AbilityInputs>(name: N, env: AbilityEnv, input: unknown): Promise<AbilityOutcome> {
  const schema = INPUTS[name]
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new LlmError('bad-request', `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  switch (name) {
    case 'rewriteText':
      return rewriteText(env, parsed.data as RewriteTextInput)
    case 'generateSlide':
      return generateSlide(env, parsed.data as GenerateSlideInput)
    case 'generateChart':
      return generateChart(env, parsed.data as GenerateChartInput)
    case 'generateDiagram':
      return generateDiagram(env, parsed.data as GenerateDiagramInput)
    case 'generateTheme':
      return generateTheme(env, parsed.data as GenerateThemeInput)
    case 'suggestEffects':
      return suggestEffects(env, parsed.data as SuggestEffectsInput)
    case 'speakerNotes':
      return speakerNotes(env, parsed.data as SpeakerNotesInput)
    case 'altText':
      return altText(env, parsed.data as AltTextInput)
    case 'translate':
      return translate(env, parsed.data as TranslateInput)
    case 'explain':
      return explain(env, parsed.data as ExplainInput)
  }
}

// generateTheme: a setTheme op from a prompt or brand colours. The model proposes colours and fonts;
// the contrast rules are then enforced in code (text and muted text 4.5:1, accents 3:1 against the
// background), and every adjustment is reported to the user.
import { z } from 'zod'
import { enforceThemeContrast } from '@sleid/model'
import { LlmError } from '../errors.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, untrustedBlock, type AbilityEnv, type AbilityOutcome } from './common.ts'
import { describeDeck } from '../context.ts'

export const FONT_STACKS = [
  'Inter',
  'Helvetica, Arial, sans-serif',
  'Arial, sans-serif',
  'Verdana, sans-serif',
  'Georgia, serif',
  'Times New Roman, serif',
  'Courier New, monospace',
] as const

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #1a73e8')

export const GenerateThemeInput = z
  .object({
    prompt: z.string().min(1).max(1000).optional(),
    brandColors: z.array(hex).min(1).max(8).optional(),
  })
  .refine((v) => v.prompt !== undefined || v.brandColors !== undefined, { message: 'Give a prompt or brand colours' })
export type GenerateThemeInput = z.infer<typeof GenerateThemeInput>

const Output = z.object({
  name: z.string().min(1).max(60),
  background: hex,
  surface: hex,
  text: hex,
  muted: hex,
  accent: hex,
  accent2: hex,
  accent3: hex,
  accent4: hex,
  headingFont: z.enum(FONT_STACKS),
  bodyFont: z.enum(FONT_STACKS),
})

export async function generateTheme(env: AbilityEnv, rawInput: GenerateThemeInput): Promise<AbilityOutcome> {
  // M9 decision: a deck with a brand kit keeps the kit's theme. Generating a new one would replace the kit's
  // palette, so it is refused. Varying the kit is not offered (the kit is the constraint, not a starting point).
  if (env.deck.brand) {
    throw new LlmError('bad-request', 'This deck has a brand kit, so its theme comes from the kit. Remove the kit to generate a theme.')
  }
  const input = GenerateThemeInput.parse(rawInput)
  const brand = input.brandColors?.length ? `Brand colours (use them as the accents, in this order): ${input.brandColors.join(', ')}.` : ''
  const request = input.prompt ? `Request:\n${untrustedBlock('request', input.prompt)}` : 'Use the brand colours only.'
  const result = await structured(env.provider, Output, {
    system: systemPrompt(
      'Task: design a slide theme. Pick a light or a dark palette that suits the request. Background and surface should be close in lightness. Text must be clearly readable on the background. Accent colours should be distinct from each other.',
    ),
    user: `${describeDeck(env.deck, { maxChars: 1500 }).text}\n\n${brand}\n${request}`,
    maxTokens: 800,
    temperature: 0.6,
    name: 'theme',
    ...(env.compact !== undefined ? { compact: env.compact } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
  })
  const v = result.value
  const { colors, adjusted } = enforceThemeContrast({
    background: v.background,
    surface: v.surface,
    text: v.text,
    muted: v.muted,
    accent: v.accent,
    accent2: v.accent2,
    accent3: v.accent3,
    accent4: v.accent4,
  })
  const theme = { name: v.name, colors, fonts: { heading: v.headingFont, body: v.bodyFont } }
  const ops = checkOps(env.deck, [{ op: 'setTheme', theme }], allowlist('setTheme'), 'generateTheme')
  if (ops.length === 0) throw new LlmError('invalid-output', 'The theme was empty.')
  return {
    ability: 'generateTheme',
    summary: `Change theme to "${v.name.slice(0, 40)}"`,
    ops,
    warnings: adjusted.length > 0 ? [`Adjusted for contrast: ${adjusted.join('; ')}`] : [],
    usage: result.usage,
    model: result.model,
  }
}

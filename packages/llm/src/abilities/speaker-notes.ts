// speakerNotes: notes for the given slides (setNotes). Length and tone are chosen by the user.
import { z } from 'zod'
import { plainText, describeDeck } from '../context.ts'
import { structured } from '../structured.ts'
import { allowlist, checkOps } from '../ops-check.ts'
import { systemPrompt, MAX_IDS, slideOf, type AbilityEnv, type AbilityOutcome } from './common.ts'

export const NOTE_TONES = ['neutral', 'friendly', 'formal', 'energetic'] as const
export const NOTE_LENGTHS = ['short', 'medium', 'long'] as const

const WORDS: Record<(typeof NOTE_LENGTHS)[number], string> = {
  short: 'about 30 to 50 words',
  medium: 'about 80 to 110 words',
  long: 'about 150 to 200 words',
}

export const SpeakerNotesInput = z.object({
  slideIds: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  tone: z.enum(NOTE_TONES).default('neutral'),
  length: z.enum(NOTE_LENGTHS).default('medium'),
})
export type SpeakerNotesInput = z.infer<typeof SpeakerNotesInput>

const Output = z.object({
  notes: z.array(z.object({ slideId: z.string().min(1), text: z.string().min(1).max(2000) })).min(1),
})

export async function speakerNotes(env: AbilityEnv, rawInput: SpeakerNotesInput): Promise<AbilityOutcome> {
  const input = SpeakerNotesInput.parse(rawInput)
  const slides = input.slideIds.map((id) => slideOf(env.deck, id))
  const material = slides
    .map((s) => `slide ${s.id}:\n${s.elements.filter((e) => e.type === 'text').map((e) => `  ${plainText(e.type === 'text' ? e.content : undefined)}`).join('\n')}`)
    .join('\n')
  const result = await structured(env.provider, Output, {
    system: systemPrompt(
      `Task: write the speaker notes for each listed slide. Tone: ${input.tone}. Length: ${WORDS[input.length]} per slide. The notes are spoken by the presenter, so write in full sentences. Do not repeat the slide text word for word. Return one entry per slide id.`,
    ),
    user: `${describeDeck(env.deck, { maxChars: 4000, selectionIds: input.slideIds }).text}\n\nSlide text to speak to:\n${material}`,
    maxTokens: Math.min(4000, 400 * slides.length + 400),
    temperature: 0.6,
    name: 'notes',
    ...(env.compact !== undefined ? { compact: env.compact } : {}),
    ...(env.signal ? { signal: env.signal } : {}),
  })

  const wanted = new Set(input.slideIds)
  const warnings: string[] = []
  const raw: unknown[] = []
  for (const note of result.value.notes) {
    if (!wanted.has(note.slideId)) {
      warnings.push(`Ignored notes for slide ${note.slideId}, which was not requested.`)
      continue
    }
    raw.push({ op: 'setNotes', slideId: note.slideId, notes: note.text })
  }
  const ops = checkOps(env.deck, raw, allowlist('setNotes'), 'speakerNotes')
  return {
    ability: 'speakerNotes',
    summary: `Write speaker notes for ${ops.length} slide${ops.length === 1 ? '' : 's'} (${input.tone}, ${input.length})`,
    ops,
    warnings,
    usage: result.usage,
    model: result.model,
  }
}

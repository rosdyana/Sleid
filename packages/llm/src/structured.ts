// Structured output: ask for JSON, repair it if needed, validate it with zod, and make one
// corrective request that includes the validation errors. Everything in abilities goes through here.
import { z } from 'zod'
import { LlmError } from './errors.ts'
import { parseJsonCandidates } from './json.ts'
import type { GenerateResult, ImagePart, LlmProvider, Message, Usage } from './types.ts'
import { addUsage, ZERO_USAGE } from './types.ts'

const DROPPED_KEYS = new Set(['$schema', 'description', 'title', 'examples', 'default'])

/** JSON Schema for a zod type. Compact mode drops descriptions and other prose, which small local models do not need. */
export function jsonSchemaOf(schema: z.ZodType, compact = false): Record<string, unknown> {
  const { $schema: _dialect, ...raw } = z.toJSONSchema(schema) as Record<string, unknown>
  return compact ? stripKeys(raw) : raw
}

function stripKeys(value: unknown): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v !== 'object' || v === null) return v
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
      if (DROPPED_KEYS.has(key)) continue
      out[key] = walk(child)
    }
    return out
  }
  return walk(value) as Record<string, unknown>
}

export type ParseOutcome<T> = { ok: true; value: T; repaired: boolean } | { ok: false; error: string }

/** Parses and validates a model reply. Tries the repair candidates in order. */
export function parseStructured<S extends z.ZodType>(text: string, schema: S): ParseOutcome<z.output<S>> {
  let lastError = 'the reply was empty'
  const candidates = parseJsonCandidates(text)
  for (let i = 0; i < candidates.length; i++) {
    let json: unknown
    try {
      json = JSON.parse(candidates[i]!)
    } catch (err) {
      lastError = `the reply is not valid JSON (${err instanceof Error ? err.message : String(err)})`
      continue
    }
    const checked = schema.safeParse(json)
    if (checked.success) return { ok: true, value: checked.data as z.output<S>, repaired: i > 0 }
    lastError = checked.error.issues
      .slice(0, 12)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
  }
  return { ok: false, error: lastError }
}

export interface StructuredOptions {
  system: string
  /** The user turn. Deck content must already be wrapped as untrusted data by the caller. */
  user: string
  images?: ImagePart[]
  maxTokens: number
  temperature?: number
  signal?: AbortSignal
  /** Schema name sent to the provider. */
  name?: string
  /** Strip descriptions from the JSON Schema (for small local models). */
  compact?: boolean
}

export interface StructuredResult<T> {
  value: T
  usage: Usage
  model: string
  /** The reply needed JSON repair. */
  repaired: boolean
  /** A corrective request was made. */
  retried: boolean
}

/**
 * One structured call. Parses (with repair). On failure makes one corrective request that
 * includes the validation errors. A second failure throws LlmError('invalid-output').
 */
export async function structured<S extends z.ZodType>(
  provider: LlmProvider,
  schema: S,
  options: StructuredOptions,
): Promise<StructuredResult<z.output<S>>> {
  const jsonSchema = jsonSchemaOf(schema, options.compact ?? false)
  const name = options.name ?? 'result'
  const first: Message = { role: 'user', content: options.user, ...(options.images?.length ? { images: options.images } : {}) }
  let messages: Message[] = [first]
  let usage = ZERO_USAGE
  let model = provider.model

  const call = async (): Promise<GenerateResult> => {
    const result = await provider.generate({
      system: options.system,
      messages,
      jsonSchema: { name, schema: jsonSchema },
      maxTokens: options.maxTokens,
      temperature: options.temperature ?? 0.4,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    usage = addUsage(usage, result.usage)
    model = result.model
    return result
  }

  const reply = await call()
  const parsed = parseStructured(reply.text, schema)
  if (parsed.ok) return { value: parsed.value, usage, model, repaired: parsed.repaired, retried: false }

  messages = [
    first,
    { role: 'assistant', content: reply.text.slice(0, 4000) },
    {
      role: 'user',
      content: `Your previous reply was not usable: ${parsed.error}. Reply again with only one JSON object that matches the schema. No prose, no code fences.`,
    },
  ]
  const retry = await call()
  const second = parseStructured(retry.text, schema)
  if (second.ok) return { value: second.value, usage, model, repaired: second.repaired, retried: true }
  throw new LlmError('invalid-output', 'The model did not return the expected format. Try again, or rephrase the request.', {
    issues: [second.error],
  })
}

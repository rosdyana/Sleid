import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonSchemaOf, parseStructured, structured } from './structured.ts'
import { scriptedProvider } from './testing.ts'
import { LlmError } from './errors.ts'

const Item = z.object({
  title: z.string().min(1).describe('A short title'),
  count: z.number().int(),
})

describe('parseStructured', () => {
  it('repairs fences, trailing commas and surrounding prose', () => {
    const out = parseStructured('Here it is:\n```json\n{"title":"Hi","count":2,}\n```\nThanks', Item)
    expect(out).toEqual({ ok: true, value: { title: 'Hi', count: 2 }, repaired: true })
  })

  it('reports the validation issues when the shape is wrong', () => {
    const out = parseStructured('{"title":"","count":"two"}', Item)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/title|count/)
  })
})

describe('jsonSchemaOf', () => {
  it('drops descriptions in compact mode and keeps them otherwise', () => {
    expect(JSON.stringify(jsonSchemaOf(Item))).toContain('A short title')
    expect(JSON.stringify(jsonSchemaOf(Item, true))).not.toContain('A short title')
    expect(jsonSchemaOf(Item)).not.toHaveProperty('$schema')
  })
})

describe('structured()', () => {
  it('returns the first valid reply without a second request', async () => {
    const provider = scriptedProvider(['{"title":"A","count":1}'])
    const result = await structured(provider, Item, { system: 's', user: 'u', maxTokens: 100 })
    expect(result.value).toEqual({ title: 'A', count: 1 })
    expect(result.retried).toBe(false)
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]!.jsonSchema?.name).toBe('result')
  })

  it('repairs a messy reply without retrying', async () => {
    const provider = scriptedProvider(['```json\n{"title":"B","count":2,}\n```'])
    const result = await structured(provider, Item, { system: 's', user: 'u', maxTokens: 100 })
    expect(result.repaired).toBe(true)
    expect(result.retried).toBe(false)
  })

  it('makes one corrective request that names the validation errors, then succeeds', async () => {
    const provider = scriptedProvider(['{"title":"C","count":"three"}', '{"title":"C","count":3}'])
    const result = await structured(provider, Item, { system: 's', user: 'u', maxTokens: 100, name: 'item' })
    expect(result.value).toEqual({ title: 'C', count: 3 })
    expect(result.retried).toBe(true)
    expect(provider.requests).toHaveLength(2)
    const corrective = provider.requests[1]!.messages.at(-1)!
    expect(corrective.role).toBe('user')
    expect(corrective.content).toMatch(/not usable: .*count/)
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 })
  })

  it('throws a typed invalid-output error when the corrected reply is still wrong', async () => {
    const provider = scriptedProvider(['not json at all', 'still not json'])
    const err = await structured(provider, Item, { system: 's', user: 'u', maxTokens: 100 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('invalid-output')
    expect(provider.requests).toHaveLength(2)
  })

  it('does not swallow provider errors', async () => {
    const provider = scriptedProvider([{ error: new LlmError('auth', 'bad key', { status: 401 }) }])
    await expect(structured(provider, Item, { system: 's', user: 'u', maxTokens: 100 })).rejects.toMatchObject({ kind: 'auth' })
    expect(provider.requests).toHaveLength(1)
  })
})

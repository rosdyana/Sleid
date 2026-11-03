import { describe, expect, it } from 'vitest'
import { extractFirstObject, parseJsonCandidates, removeTrailingCommas, stripFences } from './json.ts'

describe('JSON repair', () => {
  it('strips code fences', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripFences('{"a":1}')).toBe('{"a":1}')
  })

  it('removes trailing commas but not commas inside strings', () => {
    expect(removeTrailingCommas('{"a":[1,2,],"b":"x,}",}')).toBe('{"a":[1,2],"b":"x,}"}')
  })

  it('extracts the first balanced object, honouring strings and nesting', () => {
    expect(extractFirstObject('Sure: {"a":{"b":"}"}} thanks {"c":1}')).toBe('{"a":{"b":"}"}}')
    expect(extractFirstObject('no json here')).toBeUndefined()
  })

  it('offers the literal reply first, then repaired candidates', () => {
    const candidates = parseJsonCandidates('```json\n{"a":1,}\n```')
    expect(JSON.parse(candidates.find((c) => { try { JSON.parse(c); return true } catch { return false } })!)).toEqual({ a: 1 })
    expect(candidates[0]).toBe('{"a":1,}')
  })
})

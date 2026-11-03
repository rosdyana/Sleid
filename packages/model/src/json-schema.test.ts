import { describe, expect, it } from 'vitest'
import { deckJsonSchema } from './index.ts'

describe('deckJsonSchema', () => {
  it('emits JSON Schema for the deck and for the op union', () => {
    const { deck, op } = deckJsonSchema()
    expect(deck).toHaveProperty('properties.slides')
    expect(deck).toHaveProperty('properties.theme')
    expect(JSON.stringify(op)).toContain('deleteElement')
    expect(JSON.stringify(op)).toContain('reorderElement')
    // Must be serialisable for the MCP server.
    expect(() => JSON.stringify({ deck, op })).not.toThrow()
  })
})

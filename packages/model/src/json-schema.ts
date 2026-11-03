// JSON Schema for the deck and for deck-ops. The MCP server serves this.
import { z } from 'zod'
import { DeckSchema } from './schema.ts'
import { OpSchema } from './ops.ts'

export function deckJsonSchema(): { deck: Record<string, unknown>; op: Record<string, unknown> } {
  return {
    deck: z.toJSONSchema(DeckSchema) as Record<string, unknown>,
    op: z.toJSONSchema(OpSchema) as Record<string, unknown>,
  }
}

// Server functions for the assistant's single-shot abilities (fx bar, Tools menu, context menu).
// Chat uses the streaming route (routes/api/decks/$deckId/ai/chat.ts) instead.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { liveDeckSourceFromEnv } from '~/lib/collab-client.server'
import { getAssetStorage } from '~/lib/storage.server'
import { requireUser } from '~/lib/session.server'
import { runAbilityForDeck } from '~/lib/ai.server'

const RunInput = z.object({
  deckId: z.uuid(),
  providerId: z.string().max(64).nullable().optional(),
  ability: z.string().min(1).max(40),
  input: z.record(z.string(), z.unknown()),
})

/**
 * Runs one ability and returns its proposal. Editors and owners only. The editor previews and applies
 * the ops itself, through the live document, so Undo works.
 */
export const runAbilityFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => RunInput.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const result = await runAbilityForDeck(
      { db, env: process.env, live: liveDeckSourceFromEnv(), storage: getAssetStorage() },
      { id: user.id, email: user.email },
      { deckId: data.deckId, providerId: data.providerId ?? null, ability: data.ability, input: data.input },
    )
    // The ops go across as a JSON string. Their rich-text values hold free-form records, which the
    // server-function serialisation types do not accept. The editor parses them back.
    const { ops, ...proposal } = result.proposal
    return { proposal: { ...proposal, opsJson: JSON.stringify(ops) }, provider: result.provider }
  })

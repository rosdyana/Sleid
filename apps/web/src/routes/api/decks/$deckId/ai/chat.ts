import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db/client'
import { liveDeckSourceFromEnv } from '~/lib/collab-client.server'
import { handleAiChat } from '~/lib/ai-chat.server'
import { getAssetStorage } from '~/lib/storage.server'
import { sessionUserFromRequest } from '~/lib/session.server'

export const Route = createFileRoute('/api/decks/$deckId/ai/chat')({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleAiChat(request, params.deckId, {
          db,
          env: process.env,
          user: await sessionUserFromRequest(request),
          live: liveDeckSourceFromEnv(),
          storage: getAssetStorage(),
          signal: request.signal,
        }),
    },
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db/client'
import { handleAssetUpload } from '~/lib/http-handlers.server'
import { getAssetStorage } from '~/lib/storage.server'
import { sessionUserIdFromRequest } from '~/lib/session.server'

export const Route = createFileRoute('/api/decks/$deckId/assets')({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleAssetUpload(request, params.deckId, {
          db,
          storage: getAssetStorage(),
          userId: await sessionUserIdFromRequest(request),
        }),
    },
  },
})

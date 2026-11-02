import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db/client'
import { handleAssetRead } from '~/lib/http-handlers.server'
import { getAssetStorage } from '~/lib/storage.server'
import { sessionUserIdFromRequest } from '~/lib/session.server'

export const Route = createFileRoute('/api/assets/$assetId')({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleAssetRead(params.assetId, {
          db,
          storage: getAssetStorage(),
          userId: await sessionUserIdFromRequest(request),
        }),
    },
  },
})

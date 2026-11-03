import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db/client'
import { handleBrandLogo } from '~/lib/brand-kits.server'
import { getAssetStorage } from '~/lib/storage.server'
import { sessionUserIdFromRequest } from '~/lib/session.server'

export const Route = createFileRoute('/api/brand-kits/$kitId/logo')({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleBrandLogo(params.kitId, {
          db,
          storage: getAssetStorage(),
          userId: await sessionUserIdFromRequest(request),
        }),
    },
  },
})

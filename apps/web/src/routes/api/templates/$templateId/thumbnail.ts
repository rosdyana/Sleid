import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db/client'
import { handleTemplateThumbnail } from '~/lib/templates.server'
import { getAssetStorage } from '~/lib/storage.server'
import { sessionUserIdFromRequest } from '~/lib/session.server'

export const Route = createFileRoute('/api/templates/$templateId/thumbnail')({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleTemplateThumbnail(params.templateId, {
          db,
          storage: getAssetStorage(),
          userId: await sessionUserIdFromRequest(request),
        }),
    },
  },
})

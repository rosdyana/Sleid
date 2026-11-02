import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db/client'
import { handleExportDownload } from '~/lib/http-handlers.server'
import { getAssetStorage, getExportStorage } from '~/lib/storage.server'
import { sessionUserIdFromRequest } from '~/lib/session.server'

export const Route = createFileRoute('/api/exports/$exportId/file')({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleExportDownload(
          params.exportId,
          { db, storage: getAssetStorage(), userId: await sessionUserIdFromRequest(request) },
          getExportStorage(),
        ),
    },
  },
})

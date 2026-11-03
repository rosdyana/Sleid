import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db/client'
import { handleBrandLogo, logoVariantFrom } from '~/lib/brand-kits.server'
import { getAssetStorage } from '~/lib/storage.server'
import { sessionUserIdFromRequest } from '~/lib/session.server'

export const Route = createFileRoute('/api/brand-kits/$kitId/logo')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        // ?variant=dark reads the logo for dark slides. Without it (or with light) the light logo is read.
        const variant = logoVariantFrom(new URL(request.url).searchParams.get('variant'))
        if (!variant) return new Response(JSON.stringify({ error: 'variant must be light or dark' }), { status: 400, headers: { 'content-type': 'application/json' } })
        return handleBrandLogo(
          params.kitId,
          {
            db,
            storage: getAssetStorage(),
            userId: await sessionUserIdFromRequest(request),
          },
          variant,
        )
      },
    },
  },
})

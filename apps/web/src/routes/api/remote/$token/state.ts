import { createFileRoute } from '@tanstack/react-router'
import { handleRemoteState } from '~/lib/remote.server'
import { productionRemoteDeps } from '~/lib/remote.deps.server'

/** The phone polls this for the presenter's current slide and notes. The token in the path is the only credential. */
export const Route = createFileRoute('/api/remote/$token/state')({
  server: {
    handlers: {
      GET: async ({ params }) => handleRemoteState(productionRemoteDeps(), params.token),
    },
  },
})

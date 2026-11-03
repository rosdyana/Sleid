import { createFileRoute } from '@tanstack/react-router'
import { handleRemoteCommand } from '~/lib/remote.server'
import { productionRemoteDeps } from '~/lib/remote.deps.server'

/** The phone sends Next and Prev here. The command is rate limited and forwarded to the presenter window. */
export const Route = createFileRoute('/api/remote/$token/command')({
  server: {
    handlers: {
      POST: async ({ request, params }) => handleRemoteCommand(productionRemoteDeps(), params.token, request),
    },
  },
})

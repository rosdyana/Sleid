import { createFileRoute } from '@tanstack/react-router'
import { handleMcpRequest } from '~/lib/mcp/http'
import { mcpDepsFromEnv } from '~/lib/mcp/deps.server'

// The MCP endpoint (Streamable HTTP). Authenticated with a personal access token, never a browser session.
const handle = ({ request }: { request: Request }) => handleMcpRequest(request, mcpDepsFromEnv(request))

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: handle,
      GET: handle,
      DELETE: handle,
    },
  },
})

// Production wiring for the phone remote: the app database, COLLAB_TOKEN_SECRET, the collab client, and one
// command limiter shared by every request in this web process.
import { db } from '~/db/client'
import { FixedWindowLimiter } from '~/lib/mcp/rate-limit'
import { getCollabInternalClient } from '~/lib/collab-client.server'
import { COMMAND_LIMIT, type RemoteDeps } from '~/lib/remote.server'

export const commandLimiter = new FixedWindowLimiter(COMMAND_LIMIT.max, COMMAND_LIMIT.windowMs)

export function productionRemoteDeps(): RemoteDeps {
  return {
    db,
    secret: process.env.COLLAB_TOKEN_SECRET,
    collab: getCollabInternalClient(),
    limiter: commandLimiter,
  }
}

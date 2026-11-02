// Collab service entry point: Hocuspocus WebSocket server plus the internal API.
import { createDb } from '@sleid/db'
import { loadConfig } from './config.ts'
import { createCollabServer } from './server.ts'

const config = loadConfig()
const db = createDb(config.databaseUrl, { max: 10 })

const collab = await createCollabServer({
  db,
  tokenSecret: config.tokenSecret,
  internalSecret: config.internalSecret,
  host: config.host,
  port: config.port,
  internalHost: config.internalHost,
  internalPort: config.internalPort,
})
console.info(`[collab] websocket ${collab.wsUrl}`)
console.info(`[collab] internal API ${collab.internalUrl} (localhost only unless COLLAB_INTERNAL_HOST changes it)`)

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await collab.close()
  await db.$client.end({ timeout: 2 })
  process.exit(0)
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

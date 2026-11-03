// Starts the Hocuspocus WebSocket server and the internal API. Used by index.ts and
// by the integration tests, which run it in-process on random ports.
import { createServer, type Server as HttpServer } from 'node:http'
import { Server, type Hocuspocus } from '@hocuspocus/server'
import { writeSnapshot, type Db } from '@sleid/db'
import { createHooks, type Logger } from './hooks.ts'
import { createInternalHandler, snapshotState } from './internal-api.ts'
import { createCheckpointScheduler, type CheckpointScheduler } from './checkpoints.ts'
import { RemoteStateStore } from './remote-state.ts'

export interface CollabServerOptions {
  db: Db
  tokenSecret: string
  internalSecret: string
  host?: string
  port?: number
  internalHost?: string
  internalPort?: number
  /** Store debounce, ms. Production default 2000. */
  debounceMs?: number
  /** Longest a store may be postponed by constant typing, ms. Production default 10000. */
  maxDebounceMs?: number
  /** Automatic checkpoint timing (see checkpoints.ts). Production defaults: 2 minutes idle, 10 minutes at most. */
  checkpointIdleMs?: number
  checkpointMaxIntervalMs?: number
  logger?: Logger
}

export interface CollabServer {
  hocuspocus: Hocuspocus
  /** ws:// URL clients connect to. */
  wsUrl: string
  /** http:// URL of the internal API. */
  internalUrl: string
  /** Automatic checkpoints still waiting for their timer (for tests). */
  checkpoints: CheckpointScheduler
  close(): Promise<void>
}

const consoleLogger: Logger = {
  info: (m) => console.info(m),
  warn: (m, d) => console.warn(m, d ?? ''),
  error: (m, d) => console.error(m, d ?? ''),
}

/** Largest WebSocket frame accepted. Matches the 2 MB update cap with room for framing. */
const MAX_FRAME_BYTES = 3 * 1024 * 1024

export async function createCollabServer(options: CollabServerOptions): Promise<CollabServer> {
  const logger = options.logger ?? consoleLogger
  const remoteStates = new RemoteStateStore()
  let hocuspocus: Hocuspocus | undefined
  const checkpoints = createCheckpointScheduler({
    idleMs: options.checkpointIdleMs,
    maxIntervalMs: options.checkpointMaxIntervalMs,
    onCheckpoint: async (deckId, editors) => {
      if (!hocuspocus) return
      const state = await snapshotState(hocuspocus, options.db, deckId)
      await writeSnapshot(options.db, deckId, state, { kind: 'auto', createdBy: editors[0] ?? null, editors })
    },
    onError: (deckId, err) => logger.error(`[collab] automatic checkpoint for deck ${deckId} failed`, err),
  })
  const hooks = createHooks({
    db: options.db,
    tokenSecret: options.tokenSecret,
    logger,
    remoteStates,
    onEdit: (deckId, userId) => checkpoints.noteEdit(deckId, userId),
  })

  const server = new Server({
    port: options.port ?? 3001,
    address: options.host ?? '127.0.0.1',
    quiet: true,
    debounce: options.debounceMs ?? 2000,
    maxDebounce: options.maxDebounceMs ?? 10000,
    // Store before unloading when the last client leaves, so no edit waits in a debounce window.
    unloadImmediately: true,
    websocketOptions: { maxPayload: MAX_FRAME_BYTES },
    ...hooks,
  })
  hocuspocus = await server.listen()

  const internal: HttpServer = createServer(
    createInternalHandler({ hocuspocus, db: options.db, internalSecret: options.internalSecret, logger, remoteStates }),
  )
  await new Promise<void>((resolve, reject) => {
    internal.once('error', reject)
    internal.listen(options.internalPort ?? 3002, options.internalHost ?? '127.0.0.1', () => resolve())
  })

  const wsAddress = server.address
  const internalAddress = internal.address()
  if (!internalAddress || typeof internalAddress === 'string') throw new Error('internal listener has no address')
  return {
    hocuspocus,
    wsUrl: `ws://${displayHost(options.host)}:${wsAddress.port}`,
    internalUrl: `http://${displayHost(options.internalHost)}:${internalAddress.port}`,
    checkpoints,
    async close() {
      checkpoints.dispose()
      await new Promise<void>((resolve) => internal.close(() => resolve()))
      await server.destroy()
    },
  }
}

function displayHost(host: string | undefined): string {
  return !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

// What the MCP layer needs from the outside world. The route builds it from the environment (deps.server.ts);
// the integration test builds it from in-process services. Nothing here is a global.
import type { Db, LiveDeckSource } from '@sleid/db'
import type { JobQueue } from '@sleid/jobs'
import type { StorageDriver } from '@sleid/storage'
import type { CollabInternalClient } from '~/lib/collab-client.server'
import type { FixedWindowLimiter } from './rate-limit.ts'

export interface McpLogger {
  warn(message: string): void
  error(message: string, err?: unknown): void
}

export interface McpDeps {
  db: Db
  env: NodeJS.ProcessEnv
  /** Origin for links in tool results, for example https://sleid.example. No trailing slash. */
  publicUrl: string
  /** The collab service's live document, for reads. */
  live?: LiveDeckSource | undefined
  /** Writes go through the collab service. Null when COLLAB_INTERNAL_SECRET is not set. */
  collab: CollabInternalClient | null
  getQueue: () => Promise<JobQueue>
  exportStorage: StorageDriver
  assetStorage: StorageDriver
  limiter: FixedWindowLimiter
  /** Largest request body accepted on POST /mcp. */
  maxBodyBytes: number
  /** How long render_slide waits for the worker. */
  renderTimeoutMs: number
  logger: McpLogger
}

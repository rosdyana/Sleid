// The MCP route's dependencies, read from the environment. Server-only.
import { db } from '~/db/client'
import { getCollabInternalClient, liveDeckSourceFromEnv, type CollabInternalClient } from '~/lib/collab-client.server'
import { getAssetStorage, getExportStorage } from '~/lib/storage.server'
import { getJobQueue } from '~/lib/queue.server'
import { FixedWindowLimiter } from './rate-limit.ts'
import type { McpDeps } from './deps.ts'

const DEFAULT_RATE_PER_MINUTE = 120
/** The MCP body is buffered in memory, so this bounds memory per request. 16 MB lets a pptx of about 12 MB through import_deck (base64). */
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024
const RENDER_TIMEOUT_MS = 30_000

let limiter: FixedWindowLimiter | null = null

function numberFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function collabOrNull(): CollabInternalClient | null {
  try {
    return getCollabInternalClient()
  } catch {
    return null
  }
}

export function mcpDepsFromEnv(request: Request): McpDeps {
  const env = process.env
  limiter ??= new FixedWindowLimiter(numberFromEnv(env.MCP_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_PER_MINUTE), 60_000)
  return {
    db,
    env,
    publicUrl: (env.BETTER_AUTH_URL ?? new URL(request.url).origin).replace(/\/$/, ''),
    live: liveDeckSourceFromEnv(),
    collab: collabOrNull(),
    getQueue: getJobQueue,
    exportStorage: getExportStorage(),
    assetStorage: getAssetStorage(),
    limiter,
    maxBodyBytes: numberFromEnv(env.MCP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    renderTimeoutMs: RENDER_TIMEOUT_MS,
    logger: {
      warn: (message) => console.warn(`[mcp] ${message}`),
      error: (message, err) => console.error(`[mcp] ${message}`, err ?? ''),
    },
  }
}

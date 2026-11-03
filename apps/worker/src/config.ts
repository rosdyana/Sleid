import type { LiveDeckSource } from '@sleid/db'

export interface WorkerConfig {
  databaseUrl: string
  /** Chrome to drive (CHROME_PATH). Unset: Playwright's bundled Chromium, which must be installed. */
  chromePath?: string
  /** The collab service's internal API. Unset: decks are read from the database only. */
  live?: LiveDeckSource
  concurrency: number
  tmpRoot?: string
}

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error(`${name} must be an integer from 1 to 32`)
  return n
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required (see .env.example)')
  const secret = env.COLLAB_INTERNAL_SECRET
  const live: LiveDeckSource | undefined = secret
    ? {
        baseUrl: env.COLLAB_INTERNAL_URL || `http://127.0.0.1:${env.COLLAB_INTERNAL_PORT || '3002'}`,
        secret,
      }
    : undefined
  return {
    databaseUrl,
    chromePath: env.CHROME_PATH?.trim() || undefined,
    live,
    concurrency: positiveInt(env.EXPORT_CONCURRENCY, 'EXPORT_CONCURRENCY', 2),
    tmpRoot: env.EXPORT_TMP_DIR?.trim() || undefined,
  }
}

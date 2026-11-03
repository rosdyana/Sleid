// Environment settings for the assistant: admins, the key for stored secrets, an optional default
// provider from the environment, and the per-user rate limit. Read at call time, so tests can set them.
// Re-exports the pure env helpers from @sleid/llm (shared with the worker), and keeps the admin and rate limit rules here.
export {
  ENV_PROVIDER_ID,
  allowPrivateUserUrls,
  networkPolicyFor,
  llmSecretKey,
  envProvider,
  type EnvProvider,
} from '@sleid/llm'

/** Lower-cased emails from ADMIN_EMAILS (comma-separated). */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

export function isAdminEmail(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return adminEmails(env).includes(email.trim().toLowerCase())
}

export interface RateLimit {
  max: number
  windowMs: number
}

/** AI_RATE_LIMIT_MAX requests per AI_RATE_LIMIT_WINDOW_SECONDS per user. Defaults: 30 per 600 s. */
export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimit {
  const max = Number(env.AI_RATE_LIMIT_MAX ?? 30)
  const seconds = Number(env.AI_RATE_LIMIT_WINDOW_SECONDS ?? 600)
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 30,
    windowMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000,
  }
}

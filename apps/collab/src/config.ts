// Environment for the collab service. Everything is read once, at startup.
export interface CollabConfig {
  databaseUrl: string
  tokenSecret: string
  internalSecret: string
  host: string
  port: number
  internalHost: string
  internalPort: number
}

function required(env: NodeJS.ProcessEnv, name: string, minLength: number): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required (see .env.example)`)
  if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`)
  return value
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number`)
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollabConfig {
  return {
    databaseUrl: required(env, 'DATABASE_URL', 1),
    tokenSecret: required(env, 'COLLAB_TOKEN_SECRET', 32),
    internalSecret: required(env, 'COLLAB_INTERNAL_SECRET', 16),
    // Bound to localhost by default. Set COLLAB_HOST=0.0.0.0 only when browsers reach this host directly.
    host: env.COLLAB_HOST || '127.0.0.1',
    port: port(env, 'COLLAB_PORT', 3001),
    // The internal API (ops, json, revalidate) is never on the public WebSocket port.
    internalHost: env.COLLAB_INTERNAL_HOST || '127.0.0.1',
    internalPort: port(env, 'COLLAB_INTERNAL_PORT', 3002),
  }
}

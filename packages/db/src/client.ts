// Database client factory. apps/web and apps/collab each create one instance at startup.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.ts'

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} })
  return drizzle(client, { schema, casing: 'snake_case' })
}

export type Db = ReturnType<typeof createDb>

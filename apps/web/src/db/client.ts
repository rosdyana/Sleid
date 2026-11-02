import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required (see .env.example)')

const client = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 10) })

export const db = drizzle(client, { schema, casing: 'snake_case' })
export type Db = typeof db

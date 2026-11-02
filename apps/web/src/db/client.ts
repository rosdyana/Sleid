import { createDb } from '@sleid/db'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required (see .env.example)')

export const db = createDb(url, { max: Number(process.env.DB_POOL_MAX ?? 10) })
export type Db = typeof db

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const sql = postgres(url, { max: 1, onnotice: () => {} })
await migrate(drizzle(sql), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
console.log('migrations applied')
await sql.end()

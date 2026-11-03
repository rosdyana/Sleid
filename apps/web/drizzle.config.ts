import { defineConfig } from 'drizzle-kit'

// The schema lives in packages/db. Migrations stay here, in apps/web/drizzle, so that
// `pnpm db:generate` and `pnpm db:migrate` keep working from the repo root.
export default defineConfig({
  dialect: 'postgresql',
  schema: '../../packages/db/src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://sleid:sleid@127.0.0.1:5433/sleid' },
})

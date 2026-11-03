import { and, eq, gt, sql } from 'drizzle-orm'
import type { Db } from './client.ts'
import { importJobs, type ImportJobRow } from './schema/index.ts'

export type ImportFormat = 'pptx' | 'markdown' | 'json' | 'google-slides'

export interface NewImportJob {
  id: string
  userId: string
  format: ImportFormat
  fileName: string | null
  title: string | null
  bytes: number
  /** Storage key of the bytes the worker converts (the upload, or the export fetched for Google Slides). */
  sourceKey: string
  /** Google Slides only: the presentation id from the URL, or the Drive file id from the Picker. */
  googleFileId?: string | null
}

/** Inserts the row with the id the caller chose (the storage key is derived from it). */
export async function insertImportJob(db: Db, input: NewImportJob): Promise<void> {
  await db.insert(importJobs).values(input)
}

export async function getImportJob(db: Db, importId: string): Promise<ImportJobRow | null> {
  const [row] = await db.select().from(importJobs).where(eq(importJobs.id, importId)).limit(1)
  return row ?? null
}

/** An import is visible only to the user who started it. Other users get null, the same as a missing id. */
export async function getImportForUser(db: Db, userId: string, importId: string): Promise<ImportJobRow | null> {
  const [row] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, importId), eq(importJobs.userId, userId)))
    .limit(1)
  return row ?? null
}

/** How many imports the user started since `since`. Failed and finished imports both count. */
export async function countImportsSince(db: Db, userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(importJobs)
    .where(and(eq(importJobs.userId, userId), gt(importJobs.createdAt, since)))
  return row?.n ?? 0
}

export async function markImportRunning(db: Db, importId: string): Promise<void> {
  await db.update(importJobs).set({ status: 'running', startedAt: new Date(), error: null }).where(eq(importJobs.id, importId))
}

export async function markImportDone(db: Db, importId: string, result: { deckId: string; warnings: string[] }): Promise<void> {
  await db
    .update(importJobs)
    .set({ status: 'done', finishedAt: new Date(), deckId: result.deckId, warnings: result.warnings, error: null })
    .where(eq(importJobs.id, importId))
}

export async function markImportFailed(db: Db, importId: string, error: string): Promise<void> {
  await db
    .update(importJobs)
    .set({ status: 'failed', finishedAt: new Date(), error: error.slice(0, 2000) })
    .where(eq(importJobs.id, importId))
}

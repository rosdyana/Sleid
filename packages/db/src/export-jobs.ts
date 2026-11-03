import { and, eq } from 'drizzle-orm'
import type { Db } from './client.ts'
import { exportJobs } from './schema/index.ts'
import type { ExportFormat, ExportStatus } from './export-spec.ts'

export interface ExportRow {
  id: string
  deckId: string
  userId: string
  format: ExportFormat
  status: ExportStatus
  options: Record<string, unknown>
  error: string | null
  fileKey: string | null
  fileName: string | null
  contentType: string | null
  bytes: number | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export async function createExportJob(
  db: Db,
  input: { deckId: string; userId: string; format: ExportFormat; options: Record<string, unknown> },
): Promise<string> {
  const [row] = await db
    .insert(exportJobs)
    .values({ deckId: input.deckId, userId: input.userId, format: input.format, options: input.options })
    .returning({ id: exportJobs.id })
  if (!row) throw new Error('could not create export job')
  return row.id
}

export async function getExportJob(db: Db, exportId: string): Promise<ExportRow | null> {
  const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, exportId)).limit(1)
  return (row as ExportRow | undefined) ?? null
}

/** An export is visible only to the user who asked for it. Other users get null, the same as a missing id. */
export async function getExportForUser(db: Db, userId: string, exportId: string): Promise<ExportRow | null> {
  const [row] = await db
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.id, exportId), eq(exportJobs.userId, userId)))
    .limit(1)
  return (row as ExportRow | undefined) ?? null
}

export async function markExportRunning(db: Db, exportId: string): Promise<void> {
  await db.update(exportJobs).set({ status: 'running', startedAt: new Date(), error: null }).where(eq(exportJobs.id, exportId))
}

export async function markExportDone(
  db: Db,
  exportId: string,
  file: { fileKey: string; fileName: string; contentType: string; bytes: number },
): Promise<void> {
  await db
    .update(exportJobs)
    .set({ status: 'done', finishedAt: new Date(), ...file })
    .where(eq(exportJobs.id, exportId))
}

export async function markExportFailed(db: Db, exportId: string, error: string): Promise<void> {
  await db
    .update(exportJobs)
    .set({ status: 'failed', finishedAt: new Date(), error: error.slice(0, 2000) })
    .where(eq(exportJobs.id, exportId))
}

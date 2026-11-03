// Queries for wizard runs and their sources. Every read that a user can trigger filters by user_id in the caller.
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import type { Db } from './client.ts'
import { wizardRuns, wizardSources } from './schema/wizard.ts'

export type WizardRunRow = typeof wizardRuns.$inferSelect
export type WizardSourceRow = typeof wizardSources.$inferSelect
export type WizardStatus = WizardRunRow['status']

export async function insertWizardRun(db: Db, row: { userId: string; brief: Record<string, unknown>; providerId?: string | null }): Promise<WizardRunRow> {
  const [created] = await db
    .insert(wizardRuns)
    .values({ userId: row.userId, brief: row.brief, providerId: row.providerId ?? null })
    .returning()
  if (!created) throw new Error('wizard run was not created')
  return created
}

export async function getWizardRunFor(db: Db, userId: string, runId: string): Promise<WizardRunRow | null> {
  const [row] = await db
    .select()
    .from(wizardRuns)
    .where(and(eq(wizardRuns.id, runId), eq(wizardRuns.userId, userId)))
    .limit(1)
  return row ?? null
}

/** The run that generated a deck, for the editor banner. Null when the deck was not made by the wizard. */
export async function getWizardRunForDeck(db: Db, userId: string, deckId: string): Promise<WizardRunRow | null> {
  const [row] = await db
    .select()
    .from(wizardRuns)
    .where(and(eq(wizardRuns.deckId, deckId), eq(wizardRuns.userId, userId)))
    .limit(1)
  return row ?? null
}

/** Worker reads: no user check (the job already carries a run id that the web app created for this user). */
export async function getWizardRun(db: Db, runId: string): Promise<WizardRunRow | null> {
  const [row] = await db.select().from(wizardRuns).where(eq(wizardRuns.id, runId)).limit(1)
  return row ?? null
}

export async function updateWizardRun(db: Db, runId: string, patch: Partial<Omit<WizardRunRow, 'id' | 'userId' | 'createdAt'>>): Promise<void> {
  await db
    .update(wizardRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(wizardRuns.id, runId))
}

/** Moves a run to `status` unless it was cancelled meanwhile. Returns false when the run is cancelled (or gone). Every call is a heartbeat. */
export async function setWizardStatusUnlessCancelled(db: Db, runId: string, status: WizardStatus, patch: Partial<WizardRunRow> = {}): Promise<boolean> {
  const now = new Date()
  const rows = await db
    .update(wizardRuns)
    .set({ ...patch, status, updatedAt: now, heartbeatAt: now })
    .where(and(eq(wizardRuns.id, runId), sql`${wizardRuns.status} <> 'cancelled'`))
    .returning({ id: wizardRuns.id })
  return rows.length > 0
}

/** Records progress on a run that stays in its status (an ingest finished). Does nothing once the run is cancelled. */
export async function touchWizardRun(db: Db, runId: string): Promise<void> {
  await db
    .update(wizardRuns)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(wizardRuns.id, runId), sql`${wizardRuns.status} <> 'cancelled'`))
}

/**
 * Marks runs that lost their worker as failed: `generating` or `ingesting`, with no heartbeat (or no update) for longer
 * than `staleMs`. Returns the ids reaped. The slides already written stay in the deck.
 */
export async function reapStaleWizardRuns(db: Db, options: { staleMs: number; now?: Date; message: string }): Promise<string[]> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - options.staleMs)
  const rows = await db
    .update(wizardRuns)
    .set({ status: 'failed', error: options.message, updatedAt: now })
    .where(
      and(
        inArray(wizardRuns.status, ['generating', 'ingesting']),
        or(lt(wizardRuns.heartbeatAt, cutoff), and(sql`${wizardRuns.heartbeatAt} is null`, lt(wizardRuns.updatedAt, cutoff))),
      ),
    )
    .returning({ id: wizardRuns.id })
  return rows.map((r) => r.id)
}

export async function listWizardSources(db: Db, runId: string): Promise<WizardSourceRow[]> {
  return db.select().from(wizardSources).where(eq(wizardSources.runId, runId)).orderBy(asc(wizardSources.position), asc(wizardSources.createdAt))
}

export async function getWizardSource(db: Db, sourceId: string): Promise<WizardSourceRow | null> {
  const [row] = await db.select().from(wizardSources).where(eq(wizardSources.id, sourceId)).limit(1)
  return row ?? null
}

export async function insertWizardSource(db: Db, row: Omit<WizardSourceRow, 'id' | 'createdAt'>): Promise<WizardSourceRow> {
  const [created] = await db.insert(wizardSources).values(row).returning()
  if (!created) throw new Error('wizard source was not created')
  return created
}

export async function updateWizardSource(db: Db, sourceId: string, patch: Partial<Omit<WizardSourceRow, 'id' | 'runId' | 'createdAt'>>): Promise<void> {
  await db.update(wizardSources).set(patch).where(eq(wizardSources.id, sourceId))
}

export async function deleteWizardSource(db: Db, sourceId: string): Promise<void> {
  await db.delete(wizardSources).where(eq(wizardSources.id, sourceId))
}

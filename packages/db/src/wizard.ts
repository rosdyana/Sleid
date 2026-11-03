// Queries for wizard runs and their sources. Every read that a user can trigger filters by user_id in the caller.
import { and, asc, eq, sql } from 'drizzle-orm'
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

/** Moves a run to `status` unless it was cancelled meanwhile. Returns false when the run is cancelled (or gone). */
export async function setWizardStatusUnlessCancelled(db: Db, runId: string, status: WizardStatus, patch: Partial<WizardRunRow> = {}): Promise<boolean> {
  const rows = await db
    .update(wizardRuns)
    .set({ ...patch, status, updatedAt: new Date() })
    .where(and(eq(wizardRuns.id, runId), sql`${wizardRuns.status} <> 'cancelled'`))
    .returning({ id: wizardRuns.id })
  return rows.length > 0
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

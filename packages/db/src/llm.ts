// Persistence for model providers and usage. Secrets are passed in already encrypted; this module
// never sees a plaintext key.
import { and, count, desc, eq, gte, or } from 'drizzle-orm'
import type { Db } from './client.ts'
import { llmProviders, llmUsage } from './schema/index.ts'

export type LlmProviderKind = 'foundry-claude' | 'azure-openai' | 'openai-compatible'
export type LlmScope = 'user' | 'workspace'

export interface LlmProviderRow {
  id: string
  scope: LlmScope
  ownerId: string | null
  name: string
  kind: LlmProviderKind
  config: Record<string, unknown>
  secretCiphertext: string | null
  defaultModel: string
  isDefault: boolean
  createdAt: Date
}

/** Providers a user can see: their own, and the workspace ones. */
export async function listLlmProvidersFor(db: Db, userId: string): Promise<LlmProviderRow[]> {
  const rows = await db
    .select()
    .from(llmProviders)
    .where(or(and(eq(llmProviders.scope, 'user'), eq(llmProviders.ownerId, userId)), eq(llmProviders.scope, 'workspace')))
    .orderBy(desc(llmProviders.isDefault), llmProviders.name)
  return rows as LlmProviderRow[]
}

/** One provider, if the user can see it. Null otherwise, the same as a missing id. */
export async function getLlmProviderFor(db: Db, userId: string, providerId: string): Promise<LlmProviderRow | null> {
  const [row] = await db
    .select()
    .from(llmProviders)
    .where(
      and(
        eq(llmProviders.id, providerId),
        or(and(eq(llmProviders.scope, 'user'), eq(llmProviders.ownerId, userId)), eq(llmProviders.scope, 'workspace')),
      ),
    )
    .limit(1)
  return (row as LlmProviderRow | undefined) ?? null
}

export async function insertLlmProvider(
  db: Db,
  input: Omit<LlmProviderRow, 'id' | 'createdAt' | 'isDefault'> & { isDefault?: boolean },
): Promise<LlmProviderRow> {
  const [row] = await db
    .insert(llmProviders)
    .values({
      scope: input.scope,
      ownerId: input.ownerId,
      name: input.name,
      kind: input.kind,
      config: input.config,
      secretCiphertext: input.secretCiphertext,
      defaultModel: input.defaultModel,
      isDefault: input.isDefault ?? false,
    })
    .returning()
  if (!row) throw new Error('could not save the provider')
  return row as LlmProviderRow
}

/** Updates the given columns of one provider. `secretCiphertext: null` removes the key. */
export async function updateLlmProvider(
  db: Db,
  providerId: string,
  patch: Partial<Pick<LlmProviderRow, 'name' | 'kind' | 'config' | 'secretCiphertext' | 'defaultModel'>>,
): Promise<void> {
  await db.update(llmProviders).set(patch).where(eq(llmProviders.id, providerId))
}

export async function deleteLlmProvider(db: Db, providerId: string): Promise<void> {
  await db.delete(llmProviders).where(eq(llmProviders.id, providerId))
}

/** Makes one provider the default in its scope (and owner). The partial unique indexes enforce one default. */
export async function setDefaultLlmProvider(db: Db, row: Pick<LlmProviderRow, 'id' | 'scope' | 'ownerId'>): Promise<void> {
  await db.transaction(async (tx) => {
    if (row.scope === 'user') {
      await tx.update(llmProviders).set({ isDefault: false }).where(and(eq(llmProviders.scope, 'user'), eq(llmProviders.ownerId, row.ownerId!)))
    } else {
      await tx.update(llmProviders).set({ isDefault: false }).where(eq(llmProviders.scope, 'workspace'))
    }
    await tx.update(llmProviders).set({ isDefault: true }).where(eq(llmProviders.id, row.id))
  })
}

export async function recordLlmUsage(
  db: Db,
  row: { userId: string; deckId: string | null; providerId: string | null; ability: string; inputTokens: number; outputTokens: number; latencyMs: number; ok: boolean },
): Promise<void> {
  await db.insert(llmUsage).values(row)
}

/** Requests the user made since a time, for the rate limit. */
export async function countLlmRequestsSince(db: Db, userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(llmUsage)
    .where(and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, since)))
  return Number(row?.n ?? 0)
}


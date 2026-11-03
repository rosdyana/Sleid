// One-time download links for exports, used by MCP callers. The link carries its own random secret
// (never the personal access token). Only the secret's SHA-256 is stored. A link is valid for 15 minutes
// and is consumed by the first successful download of a finished export.
import { randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Db } from './client.ts'
import { exportJobs } from './schema/index.ts'
import { hashSecret } from './api-tokens.ts'
import type { ExportRow } from './export-jobs.ts'

export const EXPORT_LINK_TTL_SECONDS = 15 * 60
export const EXPORT_LINK_PREFIX = 'sleid_dl_'

/** Creates a fresh link for an export. Replaces any earlier link on the same export. */
export async function issueExportLink(db: Db, exportId: string, now = new Date()): Promise<{ secret: string; expiresAt: Date }> {
  const secret = EXPORT_LINK_PREFIX + randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + EXPORT_LINK_TTL_SECONDS * 1000)
  const rows = await db
    .update(exportJobs)
    .set({ linkTokenHash: hashSecret(secret), linkExpiresAt: expiresAt, linkUsedAt: null })
    .where(eq(exportJobs.id, exportId))
    .returning({ id: exportJobs.id })
  if (rows.length === 0) throw new Error('export not found')
  return { secret, expiresAt }
}

/** The export a link points at, when the link is valid and unused. Does not consume it. */
export async function findExportByLink(db: Db, exportId: string, secret: string, now = new Date()): Promise<ExportRow | null> {
  if (!secret.startsWith(EXPORT_LINK_PREFIX) || secret.length > 200) return null
  const [row] = await db
    .select()
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.id, exportId),
        eq(exportJobs.linkTokenHash, hashSecret(secret)),
        gt(exportJobs.linkExpiresAt, now),
        isNull(exportJobs.linkUsedAt),
      ),
    )
    .limit(1)
  return (row as ExportRow | undefined) ?? null
}

/**
 * Consumes a link on a finished export. Atomic: two requests cannot both consume it. Returns the export,
 * or null when the link is unknown, expired, used, or the export is not done yet (the link is then kept).
 */
export async function consumeExportLink(db: Db, exportId: string, secret: string, now = new Date()): Promise<ExportRow | null> {
  if (!secret.startsWith(EXPORT_LINK_PREFIX) || secret.length > 200) return null
  const [row] = await db
    .update(exportJobs)
    .set({ linkUsedAt: now })
    .where(
      and(
        eq(exportJobs.id, exportId),
        eq(exportJobs.linkTokenHash, hashSecret(secret)),
        gt(exportJobs.linkExpiresAt, now),
        isNull(exportJobs.linkUsedAt),
        eq(exportJobs.status, 'done'),
      ),
    )
    .returning()
  return (row as ExportRow | undefined) ?? null
}

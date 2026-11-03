// Google Slides, path B, server side: the live deps for the Drive server functions, and the import of a picked file.
// The account rules (scopes, Picker config, the access token) are in google-drive-account.ts.
import { auth } from './auth.server'
import { db as appDb } from '~/db/client'
import { getJobQueue } from './queue.server'
import { getAssetStorage } from './storage.server'
import { createDriveExporter, type DriveExporter } from './drive.server'
import { driveAccessToken, type DriveTokenSource } from './google-drive-account'
import { startImport, type ImportDeps, type ImportUser, type StartImportResult } from './import.server'

export * from './google-drive-account'

export interface DriveImportDeps extends ImportDeps {
  tokens: DriveTokenSource
  exporter: DriveExporter
}

/** Exports a picked Drive file and starts the import, the same as a public link. */
export async function importDriveFile(deps: DriveImportDeps, user: ImportUser, fileId: string): Promise<StartImportResult> {
  const token = await driveAccessToken(deps.db, deps.tokens, user.id)
  const bytes = await deps.exporter.exportPptx(fileId, token)
  return startImport(deps, user, { format: 'pptx', fileName: `${fileId}.pptx`, bytes, google: { fileId } })
}

/** Better Auth's token source: the stored Google tokens, refreshed by Better Auth when needed. */
export const betterAuthTokens: DriveTokenSource = {
  getAccessToken: (input) => auth.api.getAccessToken({ body: input }) as Promise<{ accessToken?: string | null }>,
}

/** The live deps for the Drive server functions. */
export function driveImportDeps(): DriveImportDeps {
  return {
    db: appDb,
    storage: getAssetStorage(),
    queue: { enqueueImport: async (payload) => (await getJobQueue()).enqueueImport(payload) },
    tokens: betterAuthTokens,
    exporter: createDriveExporter(),
  }
}

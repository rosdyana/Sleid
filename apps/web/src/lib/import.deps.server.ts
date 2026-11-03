// The import's dependencies in the web process: the database, the asset storage (uploads and kept images) and the job queue.
// The queue is reached lazily, so a missing queue is reported on the import row, like an export.
import { db } from '~/db/client'
import { getJobQueue } from '~/lib/queue.server'
import { getAssetStorage } from '~/lib/storage.server'
import type { ImportDeps } from './import.server'

export function importDeps(): ImportDeps {
  return {
    db,
    storage: getAssetStorage(),
    queue: { enqueueImport: async (payload) => (await getJobQueue()).enqueueImport(payload) },
  }
}

// The wizard's dependencies in the web process: the database, the assets storage (uploads), the job queue,
// and the same provider resolution as the assistant. Server-only.
import { db } from '~/db/client'
import { getAssetStorage } from './storage.server'
import { getJobQueue } from './queue.server'
import { resolveProvider } from './llm-settings.server'
import type { WizardDeps } from './wizard.server'

export async function wizardDeps(): Promise<WizardDeps> {
  const queue = await getJobQueue()
  return {
    db,
    uploads: getAssetStorage(),
    queue: { enqueueWizard: (kind, payload) => queue.enqueueWizard(kind, payload) },
    env: process.env,
    resolveProvider: (userId, providerId) => resolveProvider({ db, env: process.env }, { id: userId, email: '' }, providerId),
  }
}

// Dependencies for the template and brand kit functions, read from the environment. Server-only.
import { db } from '~/db/client'
import { readDeck } from '@sleid/db'
import type { Deck } from '@sleid/model'
import { getCollabInternalClient, liveDeckSourceFromEnv } from '~/lib/collab-client.server'
import { getAssetStorage } from '~/lib/storage.server'
import { getJobQueue } from '~/lib/queue.server'
import type { BrandDeps } from './brand-kits.server'
import type { TemplateDeps } from './templates.server'

function collabOrNull() {
  try {
    return getCollabInternalClient()
  } catch {
    return null
  }
}

async function readLiveOrSaved(deckId: string): Promise<Deck> {
  return (await readDeck(db, deckId, { live: liveDeckSourceFromEnv() })).deck
}

export function templateDeps(): TemplateDeps {
  return {
    db,
    storage: getAssetStorage(),
    readDeck: readLiveOrSaved,
    enqueueThumbnail: async (templateId) => {
      const queue = await getJobQueue()
      await queue.enqueueTemplateThumbnail({ templateId })
    },
    logger: { warn: (message, err) => console.warn(`[templates] ${message}`, err ?? '') },
  }
}

export function brandDeps(): BrandDeps {
  return {
    db,
    storage: getAssetStorage(),
    collab: collabOrNull(),
    readDeck: readLiveOrSaved,
    logger: { warn: (message, err) => console.warn(`[brand-kits] ${message}`, err ?? '') },
  }
}

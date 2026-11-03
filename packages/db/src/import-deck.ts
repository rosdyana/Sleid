// Creates a deck from an imported Deck: the row, the owner membership, the images (as assets) and
// the first Yjs snapshot, so the collab service loads it like any other deck.
import { createHash, randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { deckToYDoc, type Deck } from '@sleid/model'
import type { Db } from './client.ts'
import { insertAsset } from './assets.ts'
import { decks, deckMembers, deckSnapshots } from './schema/index.ts'

/** Largest image kept from an import, the same as the editor's image upload. */
export const IMPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/

export interface CreateImportedDeckInput {
  userId: string
  deck: Deck
  /** Stores one image's bytes under its asset id. Called before the rows are written. */
  storeAsset: (id: string, bytes: Uint8Array, mime: string) => Promise<void>
  /** Removes one stored image again. Used when the deck cannot be created, so no file is left without a row. */
  deleteAsset: (id: string) => Promise<void>
}

export interface CreatedImportedDeck {
  id: string
  /** Images that could not be kept (invalid data or over the size cap), by slide number. */
  droppedImages: number
}

/** Moves each data-URL image into the asset store and points the deck at the asset. */
async function moveImages(deck: Deck, deckId: string, userId: string, storeAsset: CreateImportedDeckInput['storeAsset']) {
  const rows: Array<{ id: string; deckId: string; ownerId: string; mime: string; bytes: number; sha256: string }> = []
  let dropped = 0
  const keep = async (src: string): Promise<string | null> => {
    const m = DATA_URL.exec(src)
    if (!m) return null
    const bytes = Buffer.from(m[2]!, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > IMPORT_IMAGE_MAX_BYTES) return null
    const id = randomUUID()
    await storeAsset(id, bytes, m[1]!)
    rows.push({ id, deckId, ownerId: userId, mime: m[1]!, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    return `/api/assets/${id}`
  }
  const slides = []
  for (const slide of deck.slides) {
    let background = slide.background
    if (background?.type === 'image') {
      const src = await keep(background.value)
      if (src) background = { ...background, value: src }
      else {
        dropped++
        background = undefined
      }
    }
    const elements = []
    for (const el of slide.elements) {
      if (el.type === 'image' && el.src.startsWith('data:')) {
        const src = await keep(el.src)
        if (src) elements.push({ ...el, src })
        else dropped++
      } else elements.push(el)
    }
    slides.push({ ...slide, ...(background ? { background } : { background: undefined }), elements })
  }
  return { slides, rows, dropped }
}

/**
 * Creates the deck. Images are stored first; the rows and the snapshot are written in one transaction.
 * If anything fails, every image stored so far is deleted again, so no file is left without a row.
 */
export async function createImportedDeck(db: Db, input: CreateImportedDeckInput): Promise<CreatedImportedDeck> {
  const deckId = randomUUID()
  const title = input.deck.title.slice(0, 200) || 'Imported deck'
  const stored: string[] = []
  const storeTracked: CreateImportedDeckInput['storeAsset'] = async (id, bytes, mime) => {
    await input.storeAsset(id, bytes, mime)
    stored.push(id)
  }
  try {
    const moved = await moveImages(input.deck, deckId, input.userId, storeTracked)
    const deck: Deck = { ...input.deck, id: deckId, title, slides: moved.slides as Deck['slides'] }
    const state = Y.encodeStateAsUpdate(deckToYDoc(deck))
    await db.transaction(async (tx) => {
      await tx.insert(decks).values({ id: deckId, ownerId: input.userId, title })
      await tx.insert(deckMembers).values({ deckId, userId: input.userId, role: 'owner', via: 'owner' })
      for (const row of moved.rows) await insertAsset(tx as unknown as Db, row)
      await tx.insert(deckSnapshots).values({ deckId, ydoc: Buffer.from(state), createdBy: input.userId })
    })
    return { id: deckId, droppedImages: moved.dropped }
  } catch (err) {
    for (const id of stored) await input.deleteAsset(id).catch(() => undefined)
    throw err
  }
}

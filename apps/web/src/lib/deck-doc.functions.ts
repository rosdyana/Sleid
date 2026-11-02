import { createServerFn } from '@tanstack/react-start'
import * as Y from 'yjs'
import { yDocToDeck } from '@sleid/model'
import { z } from 'zod'
import { base64ToBytes, bytesToBase64 } from '~/lib/base64'
import { appendDeckUpdate, copyDeck, loadDeckState, MAX_UPDATE_BYTES } from '~/lib/deck-doc.server'
import { requireDeckRole } from '~/lib/deck-access.server'
import { requireUser } from '~/lib/session.server'

const deckIdSchema = z.object({ deckId: z.uuid() })
// base64 expands by 4/3, so the encoded cap is the byte cap in base64 characters.
const pushSchema = z.object({
  deckId: z.uuid(),
  update: z.string().min(1).max(Math.ceil(MAX_UPDATE_BYTES / 3) * 4),
})

/** Full Yjs state of a deck, base64 encoded. Viewers and up. */
export const getDeckStateFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    return { state: bytesToBase64(await loadDeckState(data.deckId)) }
  })

/**
 * Appends one base64 Yjs update. Editors and up. The update is applied to a copy
 * of the current state, and rejected unless the result still parses as a deck.
 */
export const pushDeckUpdateFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => pushSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'editor')

    let update: Uint8Array
    try {
      update = base64ToBytes(data.update)
    } catch {
      throw new Error('Update is not valid base64')
    }
    if (update.byteLength > MAX_UPDATE_BYTES) throw new Error('Update is too large')

    const doc = new Y.Doc()
    Y.applyUpdate(doc, await loadDeckState(data.deckId))
    let title: string
    try {
      Y.applyUpdate(doc, update)
      title = yDocToDeck(doc).title
    } catch {
      throw new Error('Rejected: the update does not produce a valid deck')
    }
    await appendDeckUpdate(data.deckId, update, title)
    return { ok: true as const }
  })

/** New deck with a copy of this deck's state. Viewers and up may copy. */
export const copyDeckFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => deckIdSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    return copyDeck(user.id, data.deckId)
  })

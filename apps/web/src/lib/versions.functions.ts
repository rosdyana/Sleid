import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { canEdit, listVersions, readVersion } from '@sleid/db'
import { compareDecks } from '@sleid/model'
import { getCollabInternalClient } from '~/lib/collab-client.server'
import { requireDeckRole } from '~/lib/deck-access.server'
import { currentDeck } from '~/lib/comments.server'
import { requireUser } from '~/lib/session.server'

const deckId = z.uuid()
const versionId = z.uuid()
const versionName = z.string().trim().min(1, 'Name the version.').max(100, 'A version name can be at most 100 characters.')

/** Named versions and automatic checkpoints, newest first. Viewers and up. */
export const listVersionsFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ deckId: deckId }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await requireDeckRole(user.id, data.deckId, 'viewer')
    return { versions: await listVersions(db, data.deckId), canEdit: canEdit(role), userId: user.id }
  })

/** Names the current version (the live state, including edits not yet saved). Editors and owners. */
export const nameVersionFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: deckId, name: versionName }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canEdit(role)) throw new Error('Only editors and owners can name versions.')
    const saved = await getCollabInternalClient().snapshot(data.deckId, { userId: user.id, name: data.name })
    return { id: saved.id, createdAt: saved.createdAt }
  })

/**
 * One version as a deck, for the read-only preview, with a summary of how it differs from the current deck.
 * Viewers and up may preview. Restoring is separate.
 */
export const previewVersionFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ deckId: deckId, versionId: versionId }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    const version = await readVersion(db, data.deckId, data.versionId)
    if (!version) throw new Error('Version not found.')
    const current = await currentDeck(data.deckId)
    return {
      version: { id: version.id, kind: version.kind, name: version.name, createdAt: version.createdAt.toISOString() },
      /** JSON, so the serialiser does not have to type the whole deck. The client parses it. */
      deckJson: JSON.stringify(version.deck),
      diff: compareDecks(current, version.deck),
    }
  })

/**
 * Restores a version: the deck's content becomes that version, live for everyone with it open. The state being
 * replaced is kept first as "Before restore", so the restore can itself be undone. Editors and owners.
 */
export const restoreVersionFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: deckId, versionId: versionId }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const role = await requireDeckRole(user.id, data.deckId, 'viewer')
    if (!canEdit(role)) throw new Error('Only editors and owners can restore versions.')
    const version = await readVersion(db, data.deckId, data.versionId)
    if (!version) throw new Error('Version not found.')
    const result = await getCollabInternalClient().restore(data.deckId, { userId: user.id, deck: version.deck })
    return { ok: true as const, beforeSnapshotId: result.beforeSnapshotId }
  })

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { createExportJob, getExportForUser, markExportFailed, StartExportSchema } from '@sleid/db'
import { requireDeckRole } from '~/lib/deck-access.server'
import { getJobQueue } from '~/lib/queue.server'
import { requireUser } from '~/lib/session.server'

/**
 * Queues an export. Viewers and up may export, since an export only reads the deck. The worker does the work;
 * the editor polls getExportFn for the result.
 */
export const startExportFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => StartExportSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await requireDeckRole(user.id, data.deckId, 'viewer')
    const id = await createExportJob(db, {
      deckId: data.deckId,
      userId: user.id,
      format: data.format,
      options: data.options as Record<string, unknown>,
    })
    try {
      const queue = await getJobQueue()
      await queue.enqueueExport({ exportId: id })
    } catch (err) {
      console.error('[export] could not queue the job', err)
      await markExportFailed(db, id, 'The export service is not running. Start the worker (pnpm dev runs it) and try again.')
    }
    return { id }
  })

/** Status of one of the caller's exports. Other users get "not found". */
export const getExportFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ exportId: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const row = await getExportForUser(db, user.id, data.exportId)
    if (!row) throw new Error('Export not found')
    return {
      id: row.id,
      deckId: row.deckId,
      format: row.format,
      status: row.status,
      error: row.error,
      fileName: row.fileName,
      downloadUrl: row.status === 'done' ? `/api/exports/${row.id}/file` : null,
    }
  })

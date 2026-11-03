// Server functions for the deck import. Each checks the session, then calls the plain functions in import.server.ts.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './session.server'
import { importDeps } from './import.deps.server'
import * as imports from './import.server'

/** Base64 of up to the pptx cap, which is about a third larger once encoded. */
const MAX_BASE64_CHARS = Math.ceil((imports.IMPORT_LIMITS.pptxBytes * 4) / 3) + 16

/** Starts an import of a file sent as base64. Large files should use POST /api/imports (raw bytes). */
export const startImportFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z
      .object({
        format: z.enum(['pptx', 'markdown', 'json']),
        fileName: z.string().min(1).max(300),
        contentBase64: z.string().min(1).max(MAX_BASE64_CHARS),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const bytes = imports.decodeBase64(data.contentBase64)
    return imports.startImport(importDeps(), user, { format: data.format, fileName: data.fileName, bytes })
  })

/** The status of one of the caller's imports. Other users get "not found". */
export const getImportFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ importId: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return imports.getImport(importDeps(), user, data.importId)
  })

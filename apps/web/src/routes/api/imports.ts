import { createFileRoute } from '@tanstack/react-router'
import { sessionUserIdFromRequest } from '~/lib/session.server'
import { importDeps } from '~/lib/import.deps.server'
import * as imports from '~/lib/import.server'

/**
 * Starts an import from raw bytes. The body is the file; `x-import-format` (pptx, markdown or json) and
 * `x-file-name` (URL-encoded) describe it. The format is checked against the content, not the file name.
 */
async function handle(request: Request): Promise<Response> {
  const userId = await sessionUserIdFromRequest(request)
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 })
  try {
    const format = imports.formatFromHeader(request.headers.get('x-import-format'))
    const fileName = imports.fileNameFromHeader(request.headers.get('x-file-name'))
    const bytes = await imports.readImportBody(request, imports.maxBytesFor(format))
    const result = await imports.startImport(importDeps(), { id: userId }, { format, fileName, bytes })
    return Response.json(result, { status: 202 })
  } catch (err) {
    if (err instanceof imports.ImportError) return Response.json({ error: err.message }, { status: err.status })
    throw err
  }
}

export const Route = createFileRoute('/api/imports')({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
    },
  },
})

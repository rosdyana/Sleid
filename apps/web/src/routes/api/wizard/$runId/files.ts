import { createFileRoute } from '@tanstack/react-router'
import { LIMITS } from '@sleid/ingest'
import { sessionUserIdFromRequest } from '~/lib/session.server'
import { wizardDeps } from '~/lib/wizard.deps.server'
import * as wizard from '~/lib/wizard.server'

/** Uploads one reference file. The body is the file; `x-file-name` (URL-encoded) names it. */
async function handle(request: Request, runId: string): Promise<Response> {
  const userId = await sessionUserIdFromRequest(request)
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 })
  try {
    const fileName = wizard.fileNameFromHeader(request.headers.get('x-file-name'))
    const bytes = await wizard.readUploadBody(request, LIMITS.maxFileBytes)
    const source = await wizard.addFile(await wizardDeps(), { id: userId }, runId, { fileName, bytes })
    return Response.json({ source }, { status: 201 })
  } catch (err) {
    if (err instanceof wizard.WizardError) return Response.json({ error: err.message }, { status: err.status })
    if (err instanceof Error && err.name === 'IngestError') return Response.json({ error: err.message }, { status: 415 })
    throw err
  }
}

export const Route = createFileRoute('/api/wizard/$runId/files')({
  server: {
    handlers: {
      POST: async ({ request, params }) => handle(request, params.runId),
    },
  },
})

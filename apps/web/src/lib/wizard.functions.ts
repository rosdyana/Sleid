// Server functions for the wizard. Each checks the session, then calls the plain functions in wizard.server.ts.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './session.server'
import { wizardDeps } from './wizard.deps.server'
import * as wizard from './wizard.server'
import { researchStatusLine } from '@sleid/research'

const runSchema = z.object({ runId: z.uuid() })

export const createWizardRunFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ brief: z.unknown(), providerId: z.uuid().nullable().optional() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.createRun(await wizardDeps(), user, data.brief, data.providerId ?? null)
  })

export const getWizardRunFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => runSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.getRun(await wizardDeps(), user, data.runId)
  })

export const addWizardUrlFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ runId: z.uuid(), url: z.string().min(1).max(2000) }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.addUrl(await wizardDeps(), user, data.runId, data.url)
  })

export const removeWizardSourceFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ runId: z.uuid(), sourceId: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await wizard.removeSource(await wizardDeps(), user, data.runId, data.sourceId)
    return { ok: true as const }
  })

export const startWizardResearchFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => runSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.startResearch(await wizardDeps(), user, data.runId)
  })

export const draftWizardOutlineFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => runSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.draftWizardOutline(await wizardDeps(), user, data.runId)
  })

export const saveWizardOutlineFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ runId: z.uuid(), outline: z.unknown() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.saveOutline(await wizardDeps(), user, data.runId, data.outline)
  })

export const startWizardGenerationFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => runSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.startGeneration(await wizardDeps(), user, data.runId)
  })

export const cancelWizardRunFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => runSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.cancelRun(await wizardDeps(), user, data.runId)
  })

export const getWizardForDeckFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ deckId: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return wizard.getRunForDeck(await wizardDeps(), user, data.deckId)
  })

/** The read-only research line for the AI settings page. Names the provider, never a credential. */
export const researchStatusFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireUser()
  return researchStatusLine(process.env)
})

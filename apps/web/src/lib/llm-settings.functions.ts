// Server functions for the provider settings page and the panel's provider list. Thin wrappers over
// llm-settings.server.ts, which holds the rules. None of them returns a key.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { requireUser } from '~/lib/session.server'
import { listProviderViews, makeDefaultProvider, ProviderInput, removeProvider, saveProvider, testProvider } from '~/lib/llm-settings.server'

const deps = () => ({ db, env: process.env })

export const listAiProvidersFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  return listProviderViews(deps(), { id: user.id, email: user.email })
})

export const saveAiProviderFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => ProviderInput.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return saveProvider(deps(), { id: user.id, email: user.email }, data)
  })

export const deleteAiProviderFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ id: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await removeProvider(deps(), { id: user.id, email: user.email }, data.id)
    return { ok: true as const }
  })

export const setDefaultAiProviderFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ id: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await makeDefaultProvider(deps(), { id: user.id, email: user.email }, data.id)
    return { ok: true as const }
  })

/** Sends one tiny request to a saved provider (or the environment default, id "env"). */
export const testAiProviderFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ id: z.string().min(1).max(64) }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return testProvider(deps(), { id: user.id, email: user.email }, data.id)
  })

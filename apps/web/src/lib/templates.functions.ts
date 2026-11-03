// Server functions for templates (M9). Each checks the session, then calls the plain functions in templates.server.ts.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './session.server'
import { templateDeps } from './library.deps.server'
import * as templates from './templates.server'

const Id = z.uuid()

export const listTemplatesFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  return templates.listTemplatesFor(templateDeps(), user.id)
})

export const getTemplateFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ templateId: z.string().min(1).max(80) }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    // The deck goes as JSON text: its rich text is not a shape the server-function serialiser accepts.
    const detail = await templates.getTemplateFor(templateDeps(), user.id, data.templateId)
    return { summary: detail.summary, deckJson: JSON.stringify(detail.deck) }
  })

export const saveTemplateFromDeckFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z
      .object({
        deckId: Id,
        name: z.string().min(1).max(120),
        description: z.string().max(1000).optional(),
        category: z.enum(['business', 'education', 'general']).optional(),
        visibility: z.enum(['private', 'instance']).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    return templates.saveTemplateFromDeck(templateDeps(), user.id, data)
  })

export const updateTemplateFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z
      .object({
        templateId: Id,
        patch: z.object({
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(1000).optional(),
          category: z.enum(['business', 'education', 'general']).optional(),
          visibility: z.enum(['private', 'instance']).optional(),
        }),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    await templates.updateTemplateMeta(templateDeps(), user.id, data.templateId, data.patch)
    return { ok: true as const }
  })

export const deleteTemplateFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ templateId: Id }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await templates.deleteTemplate(templateDeps(), user.id, data.templateId)
    return { ok: true as const }
  })

export const newDeckFromTemplateFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ templateId: z.string().min(1).max(80), title: z.string().max(200).optional() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return templates.newDeckFromTemplate(templateDeps(), user.id, data)
  })

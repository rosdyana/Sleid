// Server functions for brand kits (M9). Each checks the session, then calls the plain functions in brand-kits.server.ts.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { BrandTokensSchema, LogoPlacementSchema } from '@sleid/model'
import { requireUser } from './session.server'
import { brandDeps } from './library.deps.server'
import * as kits from './brand-kits.server'

const Id = z.uuid()

export const listBrandKitsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  return kits.listBrandKitsFor(brandDeps(), user.id)
})

export const createBrandKitFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => kits.BrandKitInputSchema.parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return kits.createBrandKit(brandDeps(), user.id, data)
  })

export const updateBrandKitFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z
      .object({
        kitId: Id,
        patch: z.object({
          name: z.string().min(1).max(120).optional(),
          visibility: z.enum(['private', 'instance']).optional(),
          tokens: BrandTokensSchema.optional(),
          logoPlacement: LogoPlacementSchema.optional(),
          defaultTemplateId: Id.nullable().optional(),
        }),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    await kits.updateBrandKit(brandDeps(), user.id, data.kitId, data.patch)
    return { ok: true as const }
  })

export const deleteBrandKitFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ kitId: Id }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await kits.deleteBrandKit(brandDeps(), user.id, data.kitId)
    return { ok: true as const }
  })

/** A logo sent as base64 (PNG, JPEG or SVG, at most 2 MB). */
export const uploadBrandLogoFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z
      .object({
        kitId: Id,
        mime: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']),
        contentBase64: z.string().min(1).max(Math.ceil((2 * 1024 * 1024 * 4) / 3) + 16),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const bytes = Uint8Array.from(Buffer.from(data.contentBase64, 'base64'))
    await kits.uploadBrandLogo(brandDeps(), user.id, data.kitId, { mime: data.mime, bytes })
    return { ok: true as const }
  })

export const removeBrandLogoFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ kitId: Id }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await kits.removeBrandLogo(brandDeps(), user.id, data.kitId)
    return { ok: true as const }
  })

export const applyBrandKitFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: Id, brandKitId: Id }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return kits.applyBrandKit(brandDeps(), user.id, data.deckId, data.brandKitId)
  })

export const removeBrandKitFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ deckId: Id }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await kits.removeBrandKit(brandDeps(), user.id, data.deckId)
    return { ok: true as const }
  })

// What a wizard run starts from: a brand kit (its theme, its logo copied into the deck, and the constraint on the
// model's colours) or a template (its theme). Null when the run uses only a built-in theme or the AI theme.
import { randomUUID } from 'node:crypto'
import { themeFromBrandTokens, type LogoPlacement, type Op, type Theme } from '@sleid/model'
import { brandConstraintFromRef, type BrandConstraint, type WizardBrief } from '@sleid/llm'
import { insertAsset, readableBrandKit, readableTemplateDeck, type Db } from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'

export interface StartPoint {
  theme: Theme
  /** The ops that set the deck's theme (and its brand reference and logo, for a kit). Applied before any slide. */
  ops: Op[]
  /** The colour constraint for slides written on this deck. Null when there is no kit. */
  constraint: BrandConstraint | null
}

/**
 * Resolves the run's kit or template. A kit wins over a template when both are set (the kit sets the theme).
 * The kit's logo is copied into the deck as its own asset, the same as the editor's applyBrandKit does.
 * Throws when the template or kit is no longer readable by the run's owner.
 */
export async function startPointFor(
  env: { db: Db; uploads: StorageDriver },
  run: { userId: string; deckId: string },
  brief: WizardBrief,
): Promise<StartPoint | null> {
  if (brief.brandKitId) {
    const kit = await readableBrandKit(env.db, run.userId, brief.brandKitId)
    if (!kit) throw new Error('The brand kit for this run is no longer available.')
    const theme = themeFromBrandTokens(kit.name, kit.tokens)
    let logo: { src: string; placement: LogoPlacement } | null = null
    if (kit.logoKey && kit.logoMime && kit.logoSha256 && kit.logoBytes !== null) {
      const bytes = await env.uploads.get(kit.logoKey)
      if (!bytes) throw new Error('The logo file of the brand kit is missing. Upload the logo again.')
      const assetId = randomUUID()
      await env.uploads.put(assetId, bytes)
      await insertAsset(env.db, { id: assetId, deckId: run.deckId, ownerId: run.userId, mime: kit.logoMime, bytes: bytes.byteLength, sha256: kit.logoSha256 })
      logo = { src: `/api/assets/${assetId}`, placement: kit.logoPlacement }
    }
    const op = { op: 'setBrandKit', brandKitId: kit.id, theme, ...(logo ? { logo } : {}) } as unknown as Op
    const constraint = brandConstraintFromRef({ brandKitId: kit.id, palette: { ...theme.colors } }, theme)
    return { theme, ops: [op], constraint: constraint ?? null }
  }
  if (brief.templateId) {
    const deck = await readableTemplateDeck(env.db, run.userId, brief.templateId)
    if (!deck) throw new Error('The template for this run is no longer available.')
    const theme = structuredClone(deck.theme) as Theme
    return { theme, ops: [{ op: 'setTheme', theme } as unknown as Op], constraint: null }
  }
  return null
}

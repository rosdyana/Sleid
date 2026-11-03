// Style tools: the theme, the style a deck shows (read), a theme taken from a deck (and saved as a brand kit), and a
// deck's style applied to another deck.
import { z } from 'zod'
import { ThemeSchema, type ComponentTokens, type Deck, type Theme } from '@sleid/model'
import { deriveStyle, themeFromStyle } from '@sleid/compose'
import { copyAssetToDeck, getAssetWithDeck, getDeckRole, roleAtLeast, storeDeckAsset, tokenAllowsDeck, tokenHasScope, AssetError, USER_ASSET_MAX_BYTES } from '@sleid/db'
import { createBrandKit, uploadBrandLogo } from '~/lib/brand-kits.server'
import { ToolError } from '../errors.ts'
import { asText, Call, deckIdField, type ServerContext } from '../call.ts'
import { builtInTheme, builtInThemeNames } from '../compile.ts'
import { assetIdOfSrc } from '../images.ts'
import { chromeElements } from '../compose-ops.ts'
import { redactDataUrls } from '../compact.ts'
import type { McpDeps } from '../deps.ts'

const HEX = /^#[0-9a-fA-F]{6}$/
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]*)$/i

/** A colour as a six-digit hex, or the fallback when the theme's colour is not one (for example an rgba). */
function hexOr(value: string, fallback: string): string {
  return HEX.test(value) ? value.toLowerCase() : fallback
}

/** A CSS font stack that brand kits accept: plain names only, at most 160 characters, cut at a comma. */
function fontStack(value: string): string {
  const plain = value.replace(/[^A-Za-z0-9 ,-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (plain.length <= 160) return plain
  const cut = plain.slice(0, 160)
  return cut.slice(0, Math.max(cut.lastIndexOf(','), 1)).trim()
}

/** The chrome keys a theme can carry, so that a value the source does not have is cleared on the target too. */
const CHROME_KEYS = ['logoLight', 'logoDark', 'logoBox', 'footerText', 'footerBox', 'footerStyle', 'pageNumbers'] as const

export function registerStyleTools(ctx: ServerContext): void {
  const { tool, deps, principal } = ctx

  tool(
    'set_theme',
    {
      scope: 'decks:write',
      description:
        'Set the deck theme. Pass a built-in theme name (see sleid://themes), or a partial theme object such as {"colors":{"accent":"#0b57d0"}} to change some tokens only. Existing slides follow the new colours.',
      shape: {
        deckId: deckIdField,
        theme: z.union([z.string().min(1).max(60), z.record(z.string(), z.unknown())]),
      },
    },
    async (args, call) => {
      await call.edit(args.deckId)
      let patch: Record<string, unknown>
      if (typeof args.theme === 'string') {
        const theme = builtInTheme(args.theme)
        if (!theme) throw new ToolError(`Unknown theme "${args.theme}". Built-in themes: ${builtInThemeNames().join(', ')}.`)
        patch = structuredClone(theme) as unknown as Record<string, unknown>
      } else {
        patch = args.theme
      }
      await call.write(args.deckId, [{ op: 'setTheme', theme: patch }])
      return asText({ deckId: args.deckId, theme: typeof args.theme === 'string' ? args.theme : 'partial update' })
    },
  )

  tool(
    'get_deck_style',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'The style a deck shows: its theme (colours, fonts, sizes, radius), the type scale of its headings, labels and body text, the dark slide colours, the card look, the margins, the logos and footer it repeats, and the slide types it uses (archetypes). Images are summarised, not returned. Use it to match a new deck to this one.',
      shape: { deckId: deckIdField },
    },
    async (args, call) => {
      const deck = await call.read(args.deckId)
      return asText(redactDataUrls(deriveStyle(deck)))
    },
  )

  tool(
    'derive_theme_from_deck',
    {
      scope: 'decks:read',
      description:
        'The theme a deck\'s look gives (the theme as a full theme object, with its component tokens and chrome). With saveAsBrandKit {name}, it also saves a brand kit from it (needs decks:write): the palette, fonts, sizes and radius become the kit\'s tokens, the footer text is kept, and the logos (light and dark) are stored as the kit\'s logos. Then apply_brand_kit can use it on any deck.',
      shape: {
        deckId: deckIdField,
        saveAsBrandKit: z.object({ name: z.string().trim().min(1).max(120) }).optional(),
      },
    },
    async (args, call) => {
      const deck = await call.read(args.deckId)
      const style = deriveStyle(deck)
      const theme = themeFromStyle(style)
      if (!args.saveAsBrandKit) return asText({ theme: redactDataUrls(theme), archetypes: style.archetypes.map((a) => a.archetype) })
      if (!tokenHasScope(principal, 'decks:write')) throw new ToolError('This token does not have the decks:write scope, so a brand kit cannot be saved. Use a token with decks:write, or leave saveAsBrandKit out.')
      const chrome = theme.components?.chrome ?? {}
      const kit = await createBrandKit(ctx.brandDepsFor(), principal.userId, {
        name: args.saveAsBrandKit.name,
        visibility: 'private',
        tokens: {
          palette: {
            background: hexOr(theme.colors.background, '#ffffff'),
            surface: hexOr(theme.colors.surface, '#ffffff'),
            text: hexOr(theme.colors.text, '#000000'),
            muted: hexOr(theme.colors.muted, '#666666'),
            accent: hexOr(theme.colors.accent, '#2563eb'),
            accent2: hexOr(theme.colors.accent2, '#16a34a'),
            accent3: hexOr(theme.colors.accent3, '#d97706'),
            accent4: hexOr(theme.colors.accent4, '#7c3aed'),
          },
          fonts: { heading: fontStack(theme.fonts.heading), body: fontStack(theme.fonts.body) },
          sizes: { title: theme.sizes.title, heading: theme.sizes.heading, body: theme.sizes.body, small: theme.sizes.small },
          radius: theme.radius,
          ...(chrome.footerText ? { footerText: chrome.footerText.slice(0, 200) } : {}),
        },
      })
      const light = await importBrandLogo(deps, chrome.logoLight, args.deckId)
      const dark = await importBrandLogo(deps, chrome.logoDark, args.deckId)
      if (light) await uploadBrandLogo(ctx.brandDepsFor(), principal.userId, kit.id, { mime: light.mime, bytes: light.bytes, variant: 'light' })
      if (dark) await uploadBrandLogo(ctx.brandDepsFor(), principal.userId, kit.id, { mime: dark.mime, bytes: dark.bytes, variant: 'dark' })
      return asText({ brandKitId: kit.id, name: args.saveAsBrandKit.name, logos: { light: Boolean(light), dark: Boolean(dark) } })
    },
  )

  tool(
    'apply_style_from_deck',
    {
      scope: 'decks:write',
      description:
        'Give a deck the look of another deck you can read: its theme (colours, fonts, sizes, card, dark colours), its logos and footer. Existing slides take the new colours, and their footer, logo and page number are rebuilt from the new theme. Components already on the slides keep their sizes and positions. Images the logos need are copied into the target. Use it right after create_deck, before adding slides, so new slides are drawn in the new style. Needs viewer access on the source and editor access on the target.',
      shape: {
        sourceDeckId: deckIdField,
        targetDeckId: deckIdField,
        footerText: z.string().max(200).nullable().optional().describe('The footer line for the target. Omit to keep the source footer; null drops the footer.'),
      },
    },
    async (args, call) => {
      const target = await call.edit(args.targetDeckId)
      const source = await call.read(args.sourceDeckId)
      const style = deriveStyle(source)
      const theme = themeFromStyle(style)
      const chrome = theme.components?.chrome ?? {}
      const footer = args.footerText === undefined ? chrome.footerText : (args.footerText ?? undefined)

      const light = await copyLogoIntoTarget(deps, call, args.sourceDeckId, args.targetDeckId, chrome.logoLight)
      const dark = await copyLogoIntoTarget(deps, call, args.sourceDeckId, args.targetDeckId, chrome.logoDark)

      // The chrome of the new theme: a logo that could not be copied is cleared, and so is every other chrome key the source lacks.
      const chromeForTheme: NonNullable<ComponentTokens['chrome']> = {}
      if (light) chromeForTheme.logoLight = light
      if (dark) chromeForTheme.logoDark = dark
      for (const key of CHROME_KEYS) {
        if (key === 'logoLight' || key === 'logoDark') continue
        const value = key === 'footerText' ? footer : chrome[key]
        if (value !== undefined) (chromeForTheme as Record<string, unknown>)[key] = value
      }
      const chromePatch: Record<string, unknown> = {}
      for (const key of CHROME_KEYS) chromePatch[key] = (chromeForTheme as Record<string, unknown>)[key] ?? null
      chromePatch.logoLight = light ?? null
      chromePatch.logoDark = dark ?? null
      const fullTheme: Theme = { ...theme, components: { ...(theme.components ?? {}), chrome: chromeForTheme } }
      const themePatch = { ...fullTheme, components: { ...(theme.components ?? {}), chrome: chromePatch } }
      ThemeSchema.parse(fullTheme)

      const ops: unknown[] = [{ op: 'setTheme', theme: themePatch }]
      const newDeck: Deck = { ...target, theme: fullTheme }
      target.slides.forEach((slide, index) => {
        for (const el of slide.elements) {
          if (el.component?.kind === 'footer_and_logo') ops.push({ op: 'deleteElement', slideId: slide.id, elementId: el.id })
        }
        const added = chromeElements(newDeck, { id: slide.id, variant: slide.variant, elements: slide.elements.filter((el) => el.component?.kind !== 'footer_and_logo') }, index + 1)
        for (const element of added) ops.push({ op: 'addElement', slideId: slide.id, element })
      })
      call.deckId = args.targetDeckId
      await call.write(args.targetDeckId, ops)
      return asText({
        theme: theme.name,
        chrome: { logoLight: Boolean(light), logoDark: Boolean(dark), footerText: footer ?? null, pageNumbers: Boolean(chrome.pageNumbers) },
        slidesUpdated: target.slides.length,
      })
    },
  )
}

/**
 * The image behind one of a source deck's logos, as bytes for a brand kit. Returns null when there is no logo, the logo is
 * not a PNG, JPEG or SVG, or the source's image cannot be read.
 */
async function importBrandLogo(deps: McpDeps, src: string | undefined, sourceDeckId: string): Promise<{ mime: 'image/png' | 'image/jpeg' | 'image/svg+xml'; bytes: Uint8Array } | null> {
  if (!src) return null
  const data = DATA_IMAGE.exec(src)
  if (data) {
    const mime = data[1]!.toLowerCase()
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/svg+xml') return null
    return { mime, bytes: new Uint8Array(Buffer.from(data[2]!, 'base64')) }
  }
  const assetId = assetIdOfSrc(src)
  if (!assetId) return null
  const row = await getAssetWithDeck(deps.db, assetId)
  if (!row || row.deckId !== sourceDeckId) return null
  if (row.mime !== 'image/png' && row.mime !== 'image/jpeg' && row.mime !== 'image/svg+xml') return null
  const bytes = await deps.assetStorage.get(assetId)
  return bytes ? { mime: row.mime, bytes } : null
}

/**
 * Makes one logo of the source available in the target deck: a data URL is stored as a new asset, and a deck asset of the
 * source is copied. Returns the asset URL in the target, or null when the logo cannot be used.
 */
async function copyLogoIntoTarget(deps: McpDeps, call: Call, sourceDeckId: string, targetDeckId: string, src: string | undefined): Promise<string | null> {
  if (!src) return null
  const userId = call.principal.userId
  const data = DATA_IMAGE.exec(src)
  try {
    if (data) {
      const bytes = new Uint8Array(Buffer.from(data[2]!, 'base64'))
      const stored = await storeDeckAsset(deps.db, deps.assetStorage, { deckId: targetDeckId, ownerId: userId, mime: data[1]!.toLowerCase(), bytes, maxBytes: USER_ASSET_MAX_BYTES })
      return stored.url
    }
    const assetId = assetIdOfSrc(src)
    if (!assetId) return null
    const row = await getAssetWithDeck(deps.db, assetId)
    if (!row || row.deckId !== sourceDeckId || !tokenAllowsDeck(call.principal, sourceDeckId)) return null
    const role = await getDeckRole(deps.db, userId, sourceDeckId)
    if (!role || !roleAtLeast(role, 'viewer')) return null
    const copied = await copyAssetToDeck(deps.db, deps.assetStorage, { source: { kind: 'deck', assetId }, deckId: targetDeckId, ownerId: userId })
    return copied.url
  } catch (err) {
    if (err instanceof AssetError) throw new ToolError(err.message)
    throw err
  }
}

// Media tools: images (from a URL or an asset), uploaded assets (deck or library), and Lucide icons.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { deriveDarkVariant, resolveTokens } from '@sleid/model'
import { placeNewElement } from '@sleid/llm'
import { AssetError, copyAssetToDeck, createUserAsset, getAssetWithDeck, getDeckRole, getUserAsset, listDeckAssets, listUserAssets, roleAtLeast, storeDeckAsset, tokenAllowsDeck, USER_ASSET_MAX_BYTES } from '@sleid/db'
import { fetchPublicImage, MAX_IMAGE_URL_BYTES, PUBLIC_URL_POLICY } from '@sleid/ingest'
import { iconElement, listIcons, regionBox } from '@sleid/compose'
import { decodeBase64, ImportError } from '~/lib/import.server'
import { ToolError } from '../errors.ts'
import { asText, Call, deckIdField, placedElementId, slideRef, toolValue, type ServerContext } from '../call.ts'
import { resolveSlide } from '../compile.ts'
import { appendComponents, REGION_NAMES } from '../compose-ops.ts'
import type { McpDeps } from '../deps.ts'

const HEX_OR_RGBA = /^(#[0-9a-fA-F]{6}|rgba?\([^)]*\))$/
const ASSET_MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', 'svg+xml': 'image/svg+xml' } as const

/** Runs a store or copy, and turns the asset module's refusals into tool errors that name the problem. */
async function assetCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof AssetError) throw new ToolError(err.message)
    throw err
  }
}

/**
 * Finds an asset the caller may copy into a deck: a library image of the caller, or an image of another deck the caller
 * can read (viewer or better, and allowed by the token). Returns the copy's source, or null.
 */
async function copySourceFor(deps: McpDeps, call: Call, assetId: string): Promise<{ kind: 'library'; ownerId: string; id: string } | { kind: 'deck'; assetId: string } | null> {
  const userId = call.principal.userId
  const library = await getUserAsset(deps.db, userId, assetId)
  if (library) return { kind: 'library', ownerId: userId, id: assetId }
  const row = await getAssetWithDeck(deps.db, assetId)
  if (!row || !tokenAllowsDeck(call.principal, row.deckId)) return null
  const role = await getDeckRole(deps.db, userId, row.deckId)
  if (!role || !roleAtLeast(role, 'viewer')) return null
  return { kind: 'deck', assetId }
}

/** Keeps only the add operations of a placement, with the element's box set to `size` at the placed top-left. */
function resizeIcon(raw: unknown[], size: number): unknown[] {
  return raw.map((op) => {
    const o = op as { op: string; element?: Record<string, unknown> }
    if (o.op !== 'addElement' || !o.element) return op
    return { ...o, element: { ...o.element, w: size, h: size } }
  })
}

export function registerMediaTools(ctx: ServerContext): void {
  const { tool, deps, principal } = ctx

  tool(
    'insert_image',
    {
      scope: 'decks:write',
      description:
        'Put a picture on a slide. Give exactly one of: url, an http or https address (the server fetches it, checks that it is a PNG, JPEG, GIF, WebP or SVG image of up to 5 MB, and stores a copy in this deck, so exports include it); or assetId, an image uploaded to this deck, or one from your library, or from another deck you can read (it is copied into this deck). The picture goes in free space, sized to fit, unless asFrame is true: then it sits in a browser window frame. alt text is required.',
      shape: {
        deckId: deckIdField,
        ...slideRef,
        url: z.url().max(2000).optional(),
        assetId: z.uuid().optional(),
        alt: z.string().min(1).max(300),
        asFrame: z.boolean().optional().describe('Put the picture in a browser window frame (a browser_frame component).'),
      },
    },
    async (args, call) => {
      const deck = await call.edit(args.deckId)
      const slide = resolveSlide(deck, args)
      if (Number(args.url !== undefined) + Number(args.assetId !== undefined) !== 1) throw new ToolError('Give exactly one of url or assetId.')

      let src: string
      let size: { width: number; height: number } | null = null
      if (args.url !== undefined) {
        const protocol = new URL(args.url).protocol
        if (protocol !== 'https:' && protocol !== 'http:') throw new ToolError('The image URL must be http or https.')
        let fetched: Awaited<ReturnType<typeof fetchPublicImage>>
        try {
          fetched = await fetchPublicImage(args.url, { policy: deps.imageFetchPolicy ?? PUBLIC_URL_POLICY, maxBytes: MAX_IMAGE_URL_BYTES })
        } catch (err) {
          throw new ToolError(`The image could not be fetched. ${err instanceof Error ? err.message : 'Check the address.'}`)
        }
        const stored = await assetCall(() =>
          storeDeckAsset(deps.db, deps.assetStorage, { deckId: args.deckId, ownerId: principal.userId, mime: fetched.mime, bytes: fetched.body, maxBytes: USER_ASSET_MAX_BYTES }),
        )
        src = stored.url
        size = stored.width && stored.height ? { width: stored.width, height: stored.height } : null
      } else {
        const assetId = args.assetId!
        const own = await getAssetWithDeck(deps.db, assetId)
        if (own && own.deckId === args.deckId) {
          if (!own.mime.startsWith('image/')) throw new ToolError('That asset is not an image.')
          src = `/api/assets/${assetId}`
          size = own.width && own.height ? { width: own.width, height: own.height } : null
        } else {
          const source = await copySourceFor(deps, call, assetId)
          if (!source) throw new ToolError('That asset was not found.')
          const copied = await assetCall(() => copyAssetToDeck(deps.db, deps.assetStorage, { source, deckId: args.deckId, ownerId: principal.userId }))
          src = copied.url
          size = copied.width && copied.height ? { width: copied.width, height: copied.height } : null
        }
      }
      const aspect = size ? size.width / size.height : 16 / 9

      if (args.asFrame) {
        const placed = appendComponents(deck, slide, [{ kind: 'browser_frame', props: { src, alt: args.alt } }], {
          images: size ? { [src]: size } : undefined,
        })
        await call.write(args.deckId, placed.elements.map((element) => ({ op: 'addElement', slideId: slide.id, element })))
        return asText({ slideId: slide.id, src, instance: placed.parts[0]!.instance, elementIds: placed.elements.map((el) => el.id) })
      }
      const placed = placeNewElement(deck, slide.id, { type: 'image', src, fit: 'contain', rotation: 0, locked: false, opacity: 1, alt: args.alt }, aspect, args.alt)
      await call.write(args.deckId, placed.raw)
      return asText({ elementId: placedElementId(placed.raw), src, slideIndex: placed.slideNumber - 1, onNewSlide: placed.onNewSlide })
    },
  )

  tool(
    'upload_asset',
    {
      scope: 'decks:write',
      description:
        'Upload an image (PNG, JPEG, GIF, WebP or SVG, up to 5 MB, base64 encoded). Give exactly one of deckId (the image is stored on that deck; you need editor access; it returns assetId, url, width and height) or library: true (the image goes into your own library, for any deck you edit later; it returns assetId, width and height). Use the assetId with insert_image or with a browser_frame component. Both need decks:write.',
      shape: {
        name: z.string().min(1).max(200).describe('A name for the image.'),
        mime: z.enum(['png', 'jpeg', 'gif', 'webp', 'svg+xml']),
        base64: z.string().min(1).max(7 * 1024 * 1024).describe('The file, base64 encoded.'),
        deckId: deckIdField.optional(),
        library: z.literal(true).optional(),
      },
    },
    async (args, call) => {
      if ((args.deckId === undefined) === (args.library === undefined)) throw new ToolError('Give exactly one of deckId or library: true.')
      let bytes: Uint8Array
      try {
        bytes = decodeBase64(args.base64)
      } catch (err) {
        if (err instanceof ImportError) throw new ToolError(err.message)
        throw err
      }
      if (bytes.byteLength > USER_ASSET_MAX_BYTES) throw new ToolError('Images are limited to 5 MB.')
      const mime = ASSET_MIME[args.mime]
      if (args.deckId) {
        await call.edit(args.deckId)
        const stored = await assetCall(() => storeDeckAsset(deps.db, deps.assetStorage, { deckId: args.deckId!, ownerId: principal.userId, mime, bytes, maxBytes: USER_ASSET_MAX_BYTES }))
        return asText({ assetId: stored.id, url: stored.url, width: stored.width, height: stored.height, scope: 'deck', deckId: args.deckId })
      }
      const info = await assetCall(() => createUserAsset(deps.db, deps.assetStorage, { ownerId: principal.userId, name: args.name, mime, bytes }))
      return asText({
        assetId: info.id,
        url: null,
        width: info.width,
        height: info.height,
        scope: 'library',
        note: 'Library images have no URL. Use insert_image with this assetId to copy the image into a deck.',
      })
    },
  )

  tool(
    'list_assets',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'List the images of one deck (deckId, you need viewer access) or of your library (library: true). Each has its assetId, type, size in bytes and pixel size.',
      shape: {
        deckId: deckIdField.optional(),
        library: z.literal(true).optional(),
      },
    },
    async (args, call) => {
      if ((args.deckId === undefined) === (args.library === undefined)) throw new ToolError('Give exactly one of deckId or library: true.')
      if (args.deckId) {
        await call.role(args.deckId, 'viewer')
        const rows = await listDeckAssets(deps.db, args.deckId)
        return asText({
          scope: 'deck',
          assets: rows.map((r) => ({ assetId: r.id, url: `/api/assets/${r.id}`, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height })),
        })
      }
      const rows = await listUserAssets(deps.db, principal.userId)
      return asText({
        scope: 'library',
        assets: rows.map((r) => ({ assetId: r.id, name: r.name, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height })),
      })
    },
  )

  tool(
    'insert_icon',
    {
      scope: 'decks:write',
      description:
        'Add a Lucide icon to a slide, by name (for example lock, link, eye-off, copy, key, check, x, shield, chart-bar). Size is in pixels (8 to 400, default 48). color defaults to the theme accent (the dark variant\'s accent on a dark slide). Without x and y, the icon goes in free space; region puts it at the top-left of that region. Use list_icons to search the names.',
      shape: {
        deckId: deckIdField,
        slideId: z.string().min(1).max(100),
        name: z.string().min(1).max(80),
        size: z.number().min(8).max(400).optional(),
        color: z.string().max(60).regex(HEX_OR_RGBA, 'a hex colour such as #3a70dc, or rgba(...)').optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        region: z.enum(REGION_NAMES).optional(),
      },
    },
    async (args, call) => {
      const deck = await call.edit(args.deckId)
      const slide = resolveSlide(deck, { slideId: args.slideId })
      const size = args.size ?? 48
      const color = args.color ?? (slide.variant === 'dark' ? deriveDarkVariant(deck.theme).accent : deck.theme.colors.accent)
      const icon = { ...(toolValue(() => iconElement(args.name, { x: 0, y: 0, size }, color, 2)) as unknown as Record<string, unknown>), id: randomUUID() }
      if (args.x !== undefined && args.y !== undefined) {
        const element = { ...icon, x: args.x, y: args.y }
        await call.write(args.deckId, [{ op: 'addElement', slideId: slide.id, element }])
        return asText({ elementId: element.id, slideIndex: deck.slides.findIndex((s) => s.id === slide.id) })
      }
      if (args.region) {
        const box = regionBox(args.region, resolveTokens(deck.theme))
        const element = { ...icon, x: box.x, y: box.y }
        await call.write(args.deckId, [{ op: 'addElement', slideId: slide.id, element }])
        return asText({ slideIndex: deck.slides.findIndex((s) => s.id === slide.id), region: args.region })
      }
      const placed = placeNewElement(deck, slide.id, { ...icon }, 1, args.name)
      await call.write(args.deckId, resizeIcon(placed.raw, size))
      return asText({ elementId: placedElementId(placed.raw), slideIndex: placed.slideNumber - 1, onNewSlide: placed.onNewSlide })
    },
  )

  tool(
    'list_icons',
    {
      scope: 'decks:read',
      readOnly: true,
      description: 'Search the Lucide icon names that insert_icon accepts. Give a query to filter (substring, ignoring case and dashes). Returns up to 50 names.',
      shape: { query: z.string().max(60).optional() },
    },
    async (args) => {
      const all = listIcons(args.query)
      return asText({ total: all.length, icons: all.slice(0, 50) })
    },
  )
}

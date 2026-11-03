// Image sizes for placement. A browser frame keeps its picture's aspect ratio, so the tools need the pixel size of every
// image a component uses: from the asset row when it is known, otherwise from the bytes. Only this deck's assets count.
import { getAssetWithDeck, imageSize, type Db } from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'
import { ToolError } from './errors.ts'
import type { ImageSizes } from './compose-ops.ts'

export const ASSET_SRC = /^\/api\/assets\/([0-9a-f-]{36})$/i

/** The asset id an `/api/assets/<id>` src names, or null. */
export function assetIdOfSrc(src: string): string | null {
  const match = ASSET_SRC.exec(src)
  return match ? match[1]!.toLowerCase() : null
}

/**
 * The src of a browser_frame's props: `src` as given, or `/api/assets/<assetId>` when only the asset id is given. Other
 * props are returned unchanged.
 */
export function withFrameSrc<P>(kind: string, props: P): P {
  if (kind !== 'browser_frame' || typeof props !== 'object' || props === null) return props
  const p = props as Record<string, unknown>
  if (p.src !== undefined || typeof p.assetId !== 'string') return props
  return { ...p, src: `/api/assets/${p.assetId}` } as P
}

/** Every image src a list of component props uses (browser frames), for the size lookup. */
export function imageSrcsOf(specs: Array<{ kind: string; props: unknown }>): string[] {
  const out: string[] = []
  for (const spec of specs) {
    if (spec.kind !== 'browser_frame') continue
    const src = (withFrameSrc(spec.kind, spec.props) as { src?: unknown } | null)?.src
    if (typeof src === 'string') out.push(src)
  }
  return out
}

/**
 * Pixel sizes of the given srcs. A deck asset must belong to `deckId` (otherwise a readable error). A data URL is read from
 * its own bytes. Other srcs get no entry, so the component uses its default ratio.
 */
export async function imageSizesFor(deps: { db: Db; assetStorage: StorageDriver }, deckId: string, srcs: string[]): Promise<ImageSizes> {
  const out: ImageSizes = {}
  for (const src of [...new Set(srcs)]) {
    const assetId = assetIdOfSrc(src)
    if (assetId) {
      const row = await getAssetWithDeck(deps.db, assetId)
      if (!row || row.deckId !== deckId) {
        throw new ToolError(`The image ${src} is not in this deck. Upload it with upload_asset (deckId) first, then use its assetId.`)
      }
      if (row.width && row.height) {
        out[src] = { width: row.width, height: row.height }
        continue
      }
      const bytes = await deps.assetStorage.get(assetId)
      const size = bytes ? imageSize(row.mime, bytes) : null
      if (size) out[src] = size
      continue
    }
    const data = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(src)
    if (data) {
      const bytes = new Uint8Array(Buffer.from(data[2]!, 'base64'))
      const size = imageSize(data[1]!.toLowerCase(), bytes)
      if (size) out[src] = size
    }
  }
  return out
}

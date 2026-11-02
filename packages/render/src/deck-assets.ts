import type { Deck } from '@sleid/model'

/** The URL the web app serves an uploaded image at: /api/assets/<uuid>. */
export const ASSET_URL_RE = /^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * A copy of the deck with every string that is an asset URL replaced by `rewrite(assetId)`.
 * Used by the export worker to point images at files in the bundle it writes.
 */
export function rewriteAssetRefs(deck: Deck, rewrite: (assetId: string) => string): Deck {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const match = ASSET_URL_RE.exec(value)
      return match ? rewrite(match[1]!.toLowerCase()) : value
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
    }
    return value
  }
  return walk(deck) as Deck
}

/** Every asset id the deck refers to, each once. */
export function collectAssetIds(deck: Deck): string[] {
  const found = new Set<string>()
  rewriteAssetRefs(deck, (id) => {
    found.add(id)
    return `assets/${id}`
  })
  return [...found]
}

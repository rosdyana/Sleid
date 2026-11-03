// BM25 ranking of text chunks against a query. Pure TypeScript, no index; references are small.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'not', 'you', 'your', 'into', 'about',
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'itu', 'ini', 'atau', 'dalam', 'pada', 'akan', 'tidak', 'adalah', 'oleh',
])

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t))
}

export interface RankedChunk<T> {
  item: T
  score: number
}

/**
 * Ranks items by BM25 score against the query. Returns the best `limit` items with a positive score. When nothing
 * matches, the first `limit` items come back in their original order, so a prompt always has some context.
 */
export function rankBm25<T>(query: string, items: readonly T[], getText: (item: T) => string, limit: number, k1 = 1.2, b = 0.75): RankedChunk<T>[] {
  const terms = [...new Set(tokenize(query))]
  if (items.length === 0) return []
  const docs = items.map((item) => tokenize(getText(item)))
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length)
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)
  const n = docs.length
  const scored = items.map((item, i) => {
    const d = docs[i]!
    const tf = new Map<string, number>()
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const term of terms) {
      const f = tf.get(term) ?? 0
      if (f === 0) continue
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / Math.max(1, avgLen))))
    }
    return { item, score }
  })
  const positive = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
  if (positive.length > 0) return positive.slice(0, limit)
  return scored.slice(0, limit).map((s) => ({ item: s.item, score: 0 }))
}

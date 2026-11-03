// The stored form of one reference, and the helpers that turn it into prompt context.
import type { ExtractedTable, ImageRef } from './extract.ts'
import { chunkText, wordCount } from './chunk.ts'
import { rankBm25 } from './bm25.ts'
import { LIMITS } from './limits.ts'

export type SourceKind = 'file' | 'url' | 'search'

/** What a wizard source stores after extraction (wizard_sources.extracted). */
export interface IngestedSource {
  kind: SourceKind
  title: string
  url?: string
  fileName?: string
  text: string
  tables: ExtractedTable[]
  images: ImageRef[]
  wordCount: number
  /** True when the text was cut to the per-source limit. */
  truncated: boolean
  warnings: string[]
}

export interface SourceChunk {
  sourceId: string
  index: number
  text: string
}

export function buildIngested(input: {
  kind: SourceKind
  title: string
  url?: string
  fileName?: string
  text: string
  tables?: ExtractedTable[]
  images?: ImageRef[]
  warnings?: string[]
}): IngestedSource {
  const cut = input.text.length > LIMITS.maxSourceChars
  const text = cut ? input.text.slice(0, LIMITS.maxSourceChars) : input.text
  const warnings = [...(input.warnings ?? [])]
  if (cut) warnings.push(`The text was cut to ${LIMITS.maxSourceChars.toLocaleString('en-US')} characters.`)
  return {
    kind: input.kind,
    title: input.title.slice(0, 200) || 'Untitled source',
    ...(input.url ? { url: input.url } : {}),
    ...(input.fileName ? { fileName: input.fileName } : {}),
    text,
    tables: input.tables ?? [],
    images: input.images ?? [],
    wordCount: wordCount(text),
    truncated: cut,
    warnings,
  }
}

/** Chunks of every source, numbered per source. The chunk text is what the model reads. */
export function chunksOf(sources: ReadonlyArray<{ id: string; ingested: IngestedSource }>): Array<SourceChunk & { title: string }> {
  return sources.flatMap((s) =>
    chunkText(s.ingested.text).map((text, index) => ({ sourceId: s.id, index, text, title: s.ingested.title })),
  )
}

/** The chunks most relevant to a query, best first. Chunks with no match are used only when nothing matches. */
export function relevantChunks(query: string, chunks: ReadonlyArray<SourceChunk & { title: string }>, limit: number): SourceChunk[] {
  return rankBm25(query, chunks, (c) => `${c.title}\n${c.text}`, limit).map((r) => ({ sourceId: r.item.sourceId, index: r.item.index, text: r.item.text }))
}

/** Tables from the sources, with the source id, so a chart can name the table it uses. */
export function tablesOf(sources: ReadonlyArray<{ id: string; ingested: IngestedSource }>): Array<{ sourceId: string; tableIndex: number; table: ExtractedTable }> {
  return sources.flatMap((s) => s.ingested.tables.map((table, tableIndex) => ({ sourceId: s.id, tableIndex, table })))
}

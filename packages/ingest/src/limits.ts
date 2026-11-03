// Size limits for wizard references. Shared by the web app (upload checks) and the worker (extraction).
export const LIMITS = {
  maxFiles: 10,
  maxUrls: 10,
  /** Per file, before extraction. */
  maxFileBytes: 20 * 1024 * 1024,
  /** All files in one run. */
  maxTotalBytes: 50 * 1024 * 1024,
  /** Extracted text kept per source, in characters. */
  maxSourceChars: 60_000,
  /** Spreadsheets: first sheets and rows kept. */
  maxSheets: 5,
  maxRows: 200,
  /** URL bodies, before extraction. */
  maxUrlBytes: 5 * 1024 * 1024,
  urlTimeoutMs: 15_000,
  maxRedirects: 5,
  /** Chunk size for ranking, in characters (about 1.5k tokens). */
  chunkChars: 6_000,
} as const

export class IngestError extends Error {
  readonly code: 'unsupported' | 'too-large' | 'invalid' | 'blocked' | 'fetch-failed'
  constructor(code: IngestError['code'], message: string) {
    super(message)
    this.name = 'IngestError'
    this.code = code
  }
}

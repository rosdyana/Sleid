// Safe access to a PPTX package (a zip). Every read goes through here, so the size and
// name rules apply to the whole import. Limits are parameters so tests can use small ones.
import JSZip from 'jszip'

export interface ImportLimits {
  /** Size of the uploaded file. */
  maxZipBytes: number
  /** Total bytes inflated from the package, across every part read. */
  maxUncompressedBytes: number
  /** Number of file entries in the package. */
  maxEntries: number
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxZipBytes: 50 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxEntries: 5000,
}

/** An error whose message is safe to show to the user. */
export class PptxImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PptxImportError'
  }
}

export interface PackageFiles {
  /** Every file name in the package (directories excluded). */
  names: string[]
  /** The bytes of one part, or null when the package has no such part. */
  read(name: string): Promise<Uint8Array | null>
}

export function isZipBytes(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

/** Refuses absolute names, backslashes, NUL bytes and any `..` segment. */
export function assertSafeEntryName(name: string): void {
  if (name.length === 0 || name.length > 500 || name.includes('\0') || name.includes('\\') || name.startsWith('/')) {
    throw new PptxImportError(`The file contains an unsafe path: ${JSON.stringify(name.slice(0, 80))}`)
  }
  if (name.split('/').some((segment) => segment === '..')) {
    throw new PptxImportError(`The file contains a path that leaves the package: ${JSON.stringify(name.slice(0, 80))}`)
  }
}

interface ZipEntryInternal {
  _data?: { uncompressedSize?: number }
}

/**
 * Opens a PPTX zip. Checks the file size, the magic bytes, the entry count and the names,
 * and the declared uncompressed sizes. Declared sizes can lie, so each read also counts the
 * bytes it inflates, against the same total budget, and stops when the budget is spent.
 */
export async function openPackage(buf: Uint8Array, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): Promise<PackageFiles> {
  if (buf.byteLength > limits.maxZipBytes) {
    throw new PptxImportError(`The file is larger than ${formatMb(limits.maxZipBytes)} MB.`)
  }
  if (!isZipBytes(buf)) {
    throw new PptxImportError('This is not a PowerPoint file. It does not start like a zip archive.')
  }
  // JSZip resolves `..` in names when it loads them, so the raw names are read from the central
  // directory first and refused if they climb out of the package.
  for (const name of rawEntryNames(buf, limits.maxEntries)) assertSafeEntryName(name)

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    throw new PptxImportError('The PowerPoint file is damaged: the zip archive could not be read.')
  }

  const entries = Object.values(zip.files).filter((f) => !f.dir)
  if (entries.length > limits.maxEntries) {
    throw new PptxImportError(`The file has more than ${limits.maxEntries} entries.`)
  }
  let declared = 0
  for (const entry of entries) {
    assertSafeEntryName(entry.name)
    declared += (entry as unknown as ZipEntryInternal)._data?.uncompressedSize ?? 0
  }
  if (declared > limits.maxUncompressedBytes) {
    throw new PptxImportError(`The file expands to more than ${formatMb(limits.maxUncompressedBytes)} MB.`)
  }

  const budget = { remaining: limits.maxUncompressedBytes, cap: limits.maxUncompressedBytes }
  const cache = new Map<string, Promise<Uint8Array | null>>()
  const byName = new Map(entries.map((e) => [e.name, e]))

  return {
    names: entries.map((e) => e.name),
    read(name: string) {
      let pending = cache.get(name)
      if (!pending) {
        pending = readEntry(byName.get(name), budget)
        cache.set(name, pending)
      }
      return pending
    },
  }
}

interface Budget {
  remaining: number
  cap: number
}

/**
 * Inflates one entry through its stream, counting the bytes against the budget as they arrive.
 * JSZip's stream is an event stream (not async-iterable), so the events are used directly.
 */
function readEntry(entry: JSZip.JSZipObject | undefined, budget: Budget): Promise<Uint8Array | null> {
  if (!entry) return Promise.resolve(null)
  return new Promise<Uint8Array | null>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let finished = false
    const stream = entry.nodeStream('nodebuffer') as unknown as {
      on(event: 'data', fn: (chunk: Uint8Array) => void): unknown
      on(event: 'end', fn: () => void): unknown
      on(event: 'error', fn: () => void): unknown
      pause(): unknown
    }
    const fail = (err: PptxImportError) => {
      if (finished) return
      finished = true
      stream.pause()
      reject(err)
    }
    stream.on('data', (chunk: Uint8Array) => {
      if (finished) return
      budget.remaining -= chunk.byteLength
      if (budget.remaining < 0) {
        fail(new PptxImportError(`The file expands to more than ${formatMb(budget.cap)} MB.`))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => {
      if (finished) return
      finished = true
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let offset = 0
      for (const c of chunks) {
        out.set(c, offset)
        offset += c.byteLength
      }
      resolve(out)
    })
    stream.on('error', () => fail(new PptxImportError(`The PowerPoint file is damaged: ${entry.name} could not be read.`)))
  })
}

/**
 * File names as written in the central directory, before any library normalises them. A zip
 * without a plain (non-zip64) directory is left to the library's names.
 */
export function rawEntryNames(buf: Uint8Array, maxEntries: number): string[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const eocd = findEocd(view)
  if (eocd < 0) return []
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  if (count === 0xffff || at === 0xffffffff || count > maxEntries + 1) return []
  const names: string[] = []
  const decoder = new TextDecoder('utf-8')
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.byteLength || view.getUint32(at, true) !== 0x02014b50) break
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const start = at + 46
    if (start + nameLength > buf.byteLength) break
    names.push(decoder.decode(buf.subarray(start, start + nameLength)))
    at = start + nameLength + extraLength + commentLength
  }
  return names
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i
  }
  return -1
}

function formatMb(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)))
}

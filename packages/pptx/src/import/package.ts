// Parts and relationships of a PPTX package. External targets are recorded and never fetched.
import { childrenNamed, parseXml, type XNode } from './xml.ts'
import { PptxImportError, type PackageFiles } from './zip.ts'

export interface Relationship {
  id: string
  type: string
  /** The resolved part name inside the package, or the raw target for an external link. */
  target: string
  external: boolean
}

export type Relationships = Map<string, Relationship>

const decoder = new TextDecoder('utf-8')

export async function readPart(files: PackageFiles, name: string): Promise<XNode | null> {
  const bytes = await files.read(name)
  if (!bytes) return null
  return parseXml(decoder.decode(bytes), name)
}

export async function readText(files: PackageFiles, name: string): Promise<string | null> {
  const bytes = await files.read(name)
  return bytes ? decoder.decode(bytes) : null
}

/** The directory part of a name: `ppt/slides/slide1.xml` gives `ppt/slides`. */
function dirOf(name: string): string {
  const i = name.lastIndexOf('/')
  return i >= 0 ? name.slice(0, i) : ''
}

/**
 * Resolves a relationship target against the part that holds it. A `..` that climbs above the
 * package root is refused (null), so a target can never name a path outside the package.
 */
export function resolveTarget(partName: string, target: string): string | null {
  const segments = target.startsWith('/') ? [] : dirOf(partName).split('/').filter(Boolean)
  for (const part of target.replace(/^\//, '').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segments.length === 0) return null
      segments.pop()
    } else segments.push(part)
  }
  return segments.join('/')
}

function relsPathFor(partName: string): string {
  const dir = dirOf(partName)
  const base = partName.slice(dir.length + (dir ? 1 : 0))
  return `${dir ? `${dir}/` : ''}_rels/${base}.rels`
}

/** Relationships of one part. A missing .rels file gives an empty map. */
export async function relationshipsOf(files: PackageFiles, partName: string): Promise<Relationships> {
  const map: Relationships = new Map()
  const root = await readPart(files, relsPathFor(partName))
  if (!root) return map
  for (const rel of childrenNamed(root, 'Relationship')) {
    const id = rel.attrs.Id
    const rawTarget = rel.attrs.Target
    if (!id || rawTarget === undefined) continue
    const type = rel.attrs.Type ?? ''
    if (rel.attrs.TargetMode === 'External') {
      map.set(id, { id, type, target: rawTarget, external: true })
      continue
    }
    const resolved = resolveTarget(partName, rawTarget)
    if (resolved === null) continue
    map.set(id, { id, type, target: resolved, external: false })
  }
  return map
}

/** The first relationship whose Type ends with the given suffix (for example `/slideLayout`). */
export function relOfType(rels: Relationships, suffix: string): Relationship | undefined {
  for (const r of rels.values()) if (!r.external && r.type.endsWith(suffix)) return r
  return undefined
}

export function requirePart(name: string): never {
  throw new PptxImportError(`The PowerPoint file is incomplete: ${name} is missing.`)
}

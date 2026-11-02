import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Deck } from '@sleid/model'
import { collectAssetIds, rewriteAssetRefs, type MermaidScript } from '@sleid/render'
import { getAssetWithDeck, type Db } from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** Mermaid's classic browser build, from the worker's own dependency. Classic scripts also load from file://. */
export function mermaidBrowserFile(): string {
  const req = createRequire(import.meta.url)
  return join(dirname(req.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js')
}

/** Where a bundled page loads mermaid from, relative to the page. */
export const BUNDLE_MERMAID: MermaidScript = { src: 'mermaid/mermaid.min.js', module: false }

export function deckHasDiagrams(deck: Deck): boolean {
  return deck.slides.some((s) => s.elements.some((e) => e.type === 'diagram'))
}

/** The deck with only the slides to show. Hidden slides are dropped unless asked for. */
export function visibleDeck(deck: Deck, includeHidden: boolean): Deck {
  return { ...deck, slides: deck.slides.filter((s) => includeHidden || !s.hidden) }
}

export function createTempRoot(configured?: string): string {
  return configured ? resolve(configured) : join(tmpdir(), 'sleid-export')
}

export async function makeWorkDir(root: string): Promise<string> {
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, 'job-'))
}

/**
 * Writes the deck's images into <dir>/assets and returns asset id to bundle path. Only images that
 * belong to this deck are copied. Anything else becomes an empty src, so nothing is fetched.
 */
export async function writeAssets(dir: string, deck: Deck, db: Db, assets: StorageDriver): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const id of collectAssetIds(deck)) {
    const row = await getAssetWithDeck(db, id)
    if (!row || row.deckId !== deck.id) continue
    const ext = EXTENSIONS[row.mime]
    const bytes = ext ? await assets.get(id) : null
    if (!ext || !bytes) continue
    await mkdir(join(dir, 'assets'), { recursive: true })
    await writeFile(join(dir, 'assets', `${id}.${ext}`), bytes)
    found.set(id, `assets/${id}.${ext}`)
  }
  return found
}

export function rewriteForBundle(deck: Deck, paths: Map<string, string>): Deck {
  return rewriteAssetRefs(deck, (id) => paths.get(id) ?? '')
}

export async function writeMermaid(dir: string, mermaidFile: string): Promise<void> {
  await mkdir(join(dir, 'mermaid'), { recursive: true })
  await copyFile(mermaidFile, join(dir, 'mermaid', 'mermaid.min.js'))
}

/** Every file under `dir`, as a zip path relative to it. */
export async function listFiles(dir: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const out: Array<{ path: string; bytes: Uint8Array }> = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push({ path: relative(dir, full).split('\\').join('/'), bytes: new Uint8Array(await readFile(full)) })
    }
  }
  await walk(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function removeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

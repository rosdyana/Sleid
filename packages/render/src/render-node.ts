import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Deck } from '@sleid/model'
import { renderDeckHtml, type MermaidScript, type RevealAssets } from './render.ts'

const req = createRequire(import.meta.url)

export function loadRevealAssets(): RevealAssets {
  const root = dirname(req.resolve('reveal.js/package.json'))
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
  return {
    revealCss: read('dist/reveal.css'),
    revealJs: read('dist/reveal.js'),
    notesJs: read('plugin/notes/notes.js'),
  }
}

/** A self-contained deck page: reveal.js inlined. Pass `mermaid` to load diagrams from a local file instead of jsDelivr. */
export function renderStandaloneDeckHtml(deck: Deck, options: { mermaid?: MermaidScript } = {}): string {
  return renderDeckHtml(deck, { mode: 'standalone', assets: loadRevealAssets(), ...options })
}

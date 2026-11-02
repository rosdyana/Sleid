// Node-only renderers. These read reveal.js from node_modules, so they cannot
// run in the browser. The browser-safe renderers are in render.ts.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Deck } from '@sleid/model'
import { renderDeckHtml, type RevealAssets } from './render.ts'

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

// Fully offline deck HTML, with reveal.js inlined. Mermaid diagrams still
// load from a CDN, since they need a browser.
export function renderStandaloneDeckHtml(deck: Deck): string {
  return renderDeckHtml(deck, { mode: 'standalone', assets: loadRevealAssets() })
}

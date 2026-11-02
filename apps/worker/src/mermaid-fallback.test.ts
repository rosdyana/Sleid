// Renderer check in real Chrome: a diagram that Mermaid cannot draw becomes a placeholder in its own
// place, the other diagrams are still drawn, and the page reaches 'done'. Uses the bundled Mermaid
// build that the exports use. Needs CHROME_PATH, and is skipped without it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { applyOps, createDeck, deckToYDoc, yDocToDeck, type Deck } from '@sleid/model'
import { renderStandaloneDeckHtml } from '@sleid/render/node'
import { BUNDLE_MERMAID, mermaidBrowserFile, writeMermaid } from './bundle.ts'

const GOOD = { id: 'good', source: 'flowchart LR\n  A[Sun panels] -->|surplus| B[Battery]' }
// The live-run sample: a bare multi-word node name, which the Mermaid parser rejects.
const BAD = { id: 'bad', source: 'flowchart LR\n  Sunlight --> Panels --> Inverter --> Shop appliances\n  Inverter -->|surplus| Battery' }

function deckWithDiagrams(): Deck {
  const deck = createDeck('Mermaid fallback')
  const slideId = deck.slides[0]!.id
  const doc = deckToYDoc(deck)
  applyOps(
    doc,
    [GOOD, BAD].map((d, i) => ({
      op: 'addElement' as const,
      slideId,
      element: { id: d.id, type: 'diagram' as const, x: 100 + i * 900, y: 300, w: 800, h: 500, rotation: 0, locked: false, opacity: 1, source: d.source },
    })),
  )
  return yDocToDeck(doc)
}

const hasChrome = Boolean(process.env.CHROME_PATH)

describe.skipIf(!hasChrome)('mermaid placeholder in Chrome', () => {
  let dir = ''
  let browser: Browser | null = null

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sleid-mermaid-fallback-'))
    await writeMermaid(dir, mermaidBrowserFile())
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('draws the good diagram, puts a muted placeholder where the bad one was, and never shows its source', async () => {
    const htmlPath = join(dir, 'deck.html')
    writeFileSync(htmlPath, renderStandaloneDeckHtml(deckWithDiagrams(), { mermaid: BUNDLE_MERMAID }))
    const page = await browser!.newPage({ viewport: { width: 1920, height: 1080 } })
    try {
      await page.goto(pathToFileURL(htmlPath).href)
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-sleid-diagrams'), undefined, { timeout: 60_000 })
      const state = await page.evaluate(() => ({
        root: document.documentElement.getAttribute('data-sleid-diagrams'),
        goodHasSvg: Boolean(document.querySelector('[data-id="good"] svg')),
        badPlaceholder: document.querySelector('[data-id="bad"] .sleid-diagram-error')?.textContent ?? null,
        badText: document.querySelector('[data-id="bad"]')?.textContent ?? '',
        errorElements: document.querySelectorAll('[data-sleid-diagrams="error"]').length,
        // Sources that were never drawn (the drawn ones keep their <pre> and carry data-processed).
        undrawnSources: document.querySelectorAll('pre.mermaid:not([data-processed])').length,
        errorColor: getComputedStyle(document.querySelector('.sleid-diagram-error') ?? document.body).color,
        mutedColor: (() => {
          const probe = document.createElement('div')
          probe.style.color = 'var(--sleid-muted)'
          document.body.appendChild(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        })(),
      }))
      expect(state.root).toBe('done')
      expect(state.goodHasSvg).toBe(true)
      expect(state.badPlaceholder).toBe('Diagram could not be drawn')
      expect(state.badText).not.toContain('-->')
      expect(state.badText).not.toContain('Shop appliances')
      // Only the failed element is marked.
      expect(state.errorElements).toBe(1)
      expect(state.undrawnSources).toBe(0)
      expect(state.errorColor).toBe(state.mutedColor)
    } finally {
      await page.close()
    }
  }, 90_000)
})

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import type { Deck, DiagramElement } from '@sleid/model'
import { deckToMarkdown, renderDeckHtml, ASSET_URL_RE } from '@sleid/render'
import { loadRevealAssets, renderStandaloneDeckHtml } from '@sleid/render/node'
import { deckToPptx, type PptxAsset } from '@sleid/pptx'
import { StartExportSchema, exportFileName, formatFile, getAssetWithDeck, type ExportFormat, type Db } from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'
import { newExportContext, withPage, type BrowserPool } from './browser.ts'
import {
  BUNDLE_MERMAID,
  createTempRoot,
  deckHasDiagrams,
  listFiles,
  makeWorkDir,
  mermaidBrowserFile,
  removeWorkDir,
  rewriteForBundle,
  visibleDeck,
  writeAssets,
  writeMermaid,
} from './bundle.ts'
import { serveDirectory } from './static-server.ts'
import type { Logger } from './logger.ts'

export interface ExportEnv {
  db: Db
  assets: StorageDriver
  browser: BrowserPool
  tmpRoot?: string
  logger: Logger
}

export interface ProducedFile {
  bytes: Uint8Array
  fileName: string
  contentType: string
}

const VIEWPORT = { width: 1920, height: 1080 }

/** The export for one format. Throws with a readable message when it cannot be made. */
export async function produceExport(env: ExportEnv, deck: Deck, format: ExportFormat, rawOptions: Record<string, unknown>): Promise<ProducedFile> {
  const parsed = StartExportSchema.parse({ deckId: deck.id, format, options: rawOptions })
  const options = parsed.options as Record<string, unknown>
  const title = deck.title
  switch (parsed.format) {
    case 'json':
      return file(exportFileName(title, 'json'), formatFile('json').contentType, JSON.stringify(deck, null, 2))
    case 'markdown':
      return file(exportFileName(title, 'markdown'), formatFile('markdown').contentType, deckToMarkdown(deck))
    case 'pptx': {
      const bytes = await renderPptx(env, deck)
      return { bytes, fileName: exportFileName(title, 'pptx'), contentType: formatFile('pptx').contentType }
    }
    case 'html':
      return renderHtmlZip(env, deck, title)
    case 'pdf':
      return renderPdf(env, deck, { includeNotes: options.includeNotes === true, includeHidden: options.includeHidden === true }, title)
    case 'png':
    case 'jpg':
      return renderImages(env, deck, parsed.format, {
        scale: Number(options.scale ?? 1),
        includeHidden: options.includeHidden === true,
        slideId: typeof options.slideId === 'string' ? options.slideId : undefined,
      }, title)
  }
}

function file(fileName: string, contentType: string, text: string): ProducedFile {
  return { bytes: new TextEncoder().encode(text), fileName, contentType }
}

/** Waits for reveal to be ready, and for mermaid to have drawn (or failed on) every diagram. */
async function waitForRender(page: import('playwright-core').Page, diagrams: boolean, logger: Logger, printPdf = false): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { Reveal?: { isReady?: () => boolean } }).Reveal?.isReady?.() === true,
    undefined,
    { timeout: 60_000 },
  )
  // Reveal lays out the print pages after load. Printing before that gives one page for the whole deck.
  if (printPdf) {
    await page.waitForFunction(() => document.querySelectorAll('.pdf-page').length > 0, undefined, { timeout: 60_000 })
  }
  if (diagrams) {
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-sleid-diagrams'), undefined, { timeout: 60_000 })
    const state = await page.evaluate(() => document.documentElement.getAttribute('data-sleid-diagrams'))
    if (state === 'error') logger.warn('mermaid did not start, so the diagrams are exported as placeholders')
    const failed = await page.evaluate(() => document.querySelectorAll('[data-sleid-diagrams="error"]').length)
    if (failed > 0) logger.warn(`${failed} diagram(s) could not be drawn and are exported as a placeholder`)
  }
  await page.evaluate(() => document.fonts.ready)
}

async function renderPdf(
  env: ExportEnv,
  deck: Deck,
  options: { includeNotes: boolean; includeHidden: boolean },
  title: string,
): Promise<ProducedFile> {
  const shown = visibleDeck(deck, options.includeHidden)
  if (shown.slides.length === 0) throw new Error('The deck has no slides to export')
  const dir = await makeWorkDir(createTempRoot(env.tmpRoot))
  try {
    const paths = await writeAssets(dir, shown, env.db, env.assets)
    const bundled = rewriteForBundle(shown, paths)
    const diagrams = deckHasDiagrams(bundled)
    if (diagrams) await writeMermaid(dir, mermaidBrowserFile())
    await writeFile(
      join(dir, 'index.html'),
      renderDeckHtml(bundled, {
        mode: 'print',
        assets: loadRevealAssets(),
        mermaid: BUNDLE_MERMAID,
        showNotes: options.includeNotes,
      }),
    )
    const server = await serveDirectory(dir)
    try {
      const browser = await env.browser.get()
      const context = await newExportContext(browser, { viewport: VIEWPORT })
      try {
        const pdf = await withPage(context, async (page) => {
          await page.goto(`${server.origin}/index.html?print-pdf`, { waitUntil: 'load' })
          await waitForRender(page, diagrams, env.logger, true)
          return page.pdf({
            width: '1920px',
            height: '1080px',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: false,
          })
        })
        return { bytes: new Uint8Array(pdf), fileName: exportFileName(title, 'pdf'), contentType: formatFile('pdf').contentType }
      } finally {
        await context.close()
      }
    } finally {
      await server.close()
    }
  } finally {
    await removeWorkDir(dir)
  }
}

async function renderImages(
  env: ExportEnv,
  deck: Deck,
  format: 'png' | 'jpg',
  options: { scale: number; includeHidden: boolean; slideId?: string },
  title: string,
): Promise<ProducedFile> {
  let chosen = visibleDeck(deck, options.includeHidden).slides
  if (options.slideId) {
    const slide = deck.slides.find((s) => s.id === options.slideId)
    if (!slide) throw new Error('That slide is not in the deck')
    chosen = [slide]
  }
  if (chosen.length === 0) throw new Error('The deck has no slides to export')

  const dir = await makeWorkDir(createTempRoot(env.tmpRoot))
  try {
    const paths = await writeAssets(dir, deck, env.db, env.assets)
    const bundled = rewriteForBundle(deck, paths)
    const diagrams = deckHasDiagrams(bundled)
    if (diagrams) await writeMermaid(dir, mermaidBrowserFile())
    const assets = loadRevealAssets()

    // One page per slide, so a slide's transitions and notes never reach the picture.
    const pages = chosen.map((slide) => {
      const number = deck.slides.findIndex((s) => s.id === slide.id) + 1
      const bundledSlide = bundled.slides.find((s) => s.id === slide.id)!
      return { number, slide: bundledSlide, name: `slide-${number}.html`, diagrams: false }
    })
    for (const page of pages) {
      await writeFile(
        join(dir, page.name),
        renderDeckHtml({ ...bundled, slides: [page.slide] }, { mode: 'print', assets, mermaid: BUNDLE_MERMAID }),
      )
      page.diagrams = deckHasDiagrams({ ...bundled, slides: [page.slide] })
    }

    const server = await serveDirectory(dir)
    const images: Array<{ number: number; bytes: Uint8Array }> = []
    try {
      const browser = await env.browser.get()
      // Scales below 1 use a smaller viewport, so the page itself is never rendered at a fractional device scale.
      const context = await newExportContext(browser, {
        viewport: options.scale >= 1 ? VIEWPORT : { width: Math.round(VIEWPORT.width * options.scale), height: Math.round(VIEWPORT.height * options.scale) },
        deviceScaleFactor: options.scale >= 1 ? options.scale : 1,
      })
      try {
        await withPage(context, async (page) => {
          for (const p of pages) {
            await page.goto(`${server.origin}/${p.name}`, { waitUntil: 'load' })
            await waitForRender(page, p.diagrams, env.logger)
            await page.evaluate(() => document.querySelectorAll('.fragment').forEach((el) => el.classList.add('visible')))
            const shot = await page.screenshot({
              type: format === 'png' ? 'png' : 'jpeg',
              ...(format === 'jpg' ? { quality: 92 } : {}),
            })
            images.push({ number: p.number, bytes: new Uint8Array(shot) })
          }
        })
      } finally {
        await context.close()
      }
    } finally {
      await server.close()
    }

    if (options.slideId) {
      const only = images[0]!
      return {
        bytes: only.bytes,
        fileName: exportFileName(title, format, false, only.number),
        contentType: formatFile(format).contentType,
      }
    }
    const zip = new JSZip()
    for (const image of images) {
      zip.file(`slide-${String(image.number).padStart(2, '0')}.${format}`, image.bytes)
    }
    return {
      bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
      fileName: exportFileName(title, format, true),
      contentType: formatFile(format, true).contentType,
    }
  } finally {
    await removeWorkDir(dir)
  }
}

async function renderHtmlZip(env: ExportEnv, deck: Deck, title: string): Promise<ProducedFile> {
  const dir = await makeWorkDir(createTempRoot(env.tmpRoot))
  try {
    const paths = await writeAssets(dir, deck, env.db, env.assets)
    const bundled = rewriteForBundle(deck, paths)
    const diagrams = deckHasDiagrams(bundled)
    if (diagrams) await writeMermaid(dir, mermaidBrowserFile())
    await writeFile(join(dir, 'index.html'), renderStandaloneDeckHtml(bundled, { mermaid: BUNDLE_MERMAID }))
    const zip = new JSZip()
    for (const entry of await listFiles(dir)) zip.file(entry.path, entry.bytes)
    return {
      bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
      fileName: exportFileName(title, 'html'),
      contentType: formatFile('html').contentType,
    }
  } finally {
    await removeWorkDir(dir)
  }
}

/** Rasterizes Mermaid diagrams for PPTX, with the same mermaid build as the other exports. */
class DiagramRasterizer {
  private dir: string | null = null
  private server: { origin: string; close(): Promise<void> } | null = null
  private context: import('playwright-core').BrowserContext | null = null

  private readonly env: ExportEnv

  constructor(env: ExportEnv) {
    this.env = env
  }

  private async ready() {
    if (this.server && this.context) return
    this.dir = await makeWorkDir(createTempRoot(this.env.tmpRoot))
    await writeMermaid(this.dir, mermaidBrowserFile())
    await writeFile(
      join(this.dir, 'diagram.html'),
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}#box{display:flex;align-items:center;justify-content:center;overflow:hidden}</style></head>
<body><div id="box"></div><script src="mermaid/mermaid.min.js"></script><script>
window.drawDiagram = async (source, w, h) => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const box = document.getElementById('box');
  box.style.width = w + 'px'; box.style.height = h + 'px';
  const { svg } = await mermaid.render('sleid-diagram-' + Math.random().toString(36).slice(2), source);
  box.innerHTML = svg;
  const el = box.querySelector('svg');
  if (el) { el.removeAttribute('height'); el.style.width = '100%'; el.style.height = '100%'; }
  return true;
};
</script></body></html>`,
    )
    this.server = await serveDirectory(this.dir)
    const browser = await this.env.browser.get()
    this.context = await newExportContext(browser, { viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 })
  }

  async render(element: DiagramElement): Promise<PptxAsset | null> {
    try {
      await this.ready()
      const context = this.context!
      return await withPage(context, async (page) => {
        await page.goto(`${this.server!.origin}/diagram.html`, { waitUntil: 'load' })
        await page.evaluate(([source, w, h]) => (window as unknown as { drawDiagram: (s: string, w: number, h: number) => Promise<boolean> }).drawDiagram(source, w, h), [element.source, Math.round(element.w), Math.round(element.h)] as const)
        const png = await page.locator('#box').screenshot({ omitBackground: true, type: 'png' })
        return { data: new Uint8Array(png), mime: 'image/png' }
      })
    } catch (err) {
      this.env.logger.warn(`diagram exported as a placeholder: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined)
    await this.server?.close().catch(() => undefined)
    if (this.dir) await removeWorkDir(this.dir)
  }
}

async function renderPptx(env: ExportEnv, deck: Deck): Promise<Uint8Array> {
  const rasterizer = new DiagramRasterizer(env)
  try {
    return await deckToPptx(deck, {
      resolveAsset: async (src) => {
        const match = ASSET_URL_RE.exec(src)
        if (match) {
          const id = match[1]!.toLowerCase()
          const row = await getAssetWithDeck(env.db, id)
          if (!row || row.deckId !== deck.id) return null
          const data = await env.assets.get(id)
          return data ? { data, mime: row.mime } : null
        }
        const inline = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(src)
        if (inline) return { data: new Uint8Array(Buffer.from(inline[2]!, 'base64')), mime: inline[1]! }
        // Other URLs are not fetched: the export must not reach the open internet.
        return null
      },
      rasterizeDiagram: (element) => rasterizer.render(element),
    })
  } finally {
    await rasterizer.close()
  }
}


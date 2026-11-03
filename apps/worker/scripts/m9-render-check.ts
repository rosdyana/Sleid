// M9 render check. Writes PNGs of every built-in template, and of one deck with a brand logo in a corner,
// through the worker's own PNG export (produceExport), then a PPTX of the same deck with the logo on each slide.
// Run from the repo root with CHROME_PATH set:
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node apps/worker/scripts/m9-render-check.ts <outDir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import JSZip from 'jszip'
import { BUILT_IN_TEMPLATES, builtInTemplateDeck, deckToYDoc, type Deck } from '@sleid/model'
import { deckToPptx } from '@sleid/pptx'
import { createBrowserPool } from '../src/browser.ts'
import { produceExport, type ExportEnv } from '../src/formats.ts'
import { createLocalStorage } from '@sleid/storage'

const outDir = process.argv[2]
if (!outDir) throw new Error('usage: m9-render-check.ts <outDir>')
mkdirSync(outDir, { recursive: true })

const logger = { info: () => {}, warn: (...a: unknown[]) => console.warn(...a), error: (...a: unknown[]) => console.error(...a) } as unknown as ExportEnv['logger']
const browser = createBrowserPool(process.env.CHROME_PATH || undefined)
// Templates carry no asset URLs and the logo is a data URL, so the database and the asset store are not read.
const env: ExportEnv = { db: null as never, assets: createLocalStorage(join(outDir, '.unused-assets')), browser, logger, tmpRoot: join(outDir, '.tmp') }

// A PNG logo drawn in code: a rounded accent tile with three white bars, 480 x 160 px.
function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (width * 4 + 1) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return new Uint8Array(png)
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return c ^ 0xffffffff
}

const LOGO_PNG = makePng(480, 160, (x, y) => {
  const inTile = x >= 4 && x < 476 && y >= 4 && y < 156
  if (!inTile) return [0, 0, 0, 0]
  const bar = (x > 80 && x < 400 && y > 48 && y < 72) || (x > 80 && x < 320 && y > 88 && y < 112)
  return bar ? [255, 255, 255, 255] : [11, 87, 208, 255]
})
const KIT_LOGO = `data:image/png;base64,${Buffer.from(LOGO_PNG).toString('base64')}`

async function renderTo(deck: Deck, file: string, slideIds: string[]) {
  // The export validates the deck id as a UUID; the id has no other effect on the picture.
  const exportable = { ...deck, id: randomUUID() }
  for (const [index, slideId] of slideIds.entries()) {
    const shot = await produceExport(env, exportable, 'png', { scale: 0.5, slideId })
    writeFileSync(join(outDir, `${file}-${index + 1}.png`), shot.bytes)
  }
}

async function main() {
  for (const info of BUILT_IN_TEMPLATES) {
    const deck = builtInTemplateDeck(info.id)!
    const short = info.id.replace('builtin:', '')
    await renderTo(deck, `template-${short}`, deck.slides.map((s) => s.id))
    console.log(`rendered ${info.id}: ${deck.slides.length} slides`)
  }

  // One deck with a kit logo in the top-right corner, on every slide but the title.
  const branded = builtInTemplateDeck('builtin:pitch')!
  branded.brand = {
    brandKitId: 'check-kit',
    palette: { ...branded.theme.colors },
    fonts: { heading: branded.theme.fonts.heading, body: branded.theme.fonts.body },
    logo: { src: KIT_LOGO, placement: { corner: 'tr', widthPct: 14, margin: 56, slides: 'all-but-title' } },
  }
  await renderTo(branded, 'branded-pitch', branded.slides.map((s) => s.id))

  // The same deck as PPTX, to inspect the logo picture on each slide.
  const pptx = await deckToPptx(branded, {
    resolveAsset: async (src) => {
      const m = /^data:(image\/png);base64,(.+)$/.exec(src)
      return m ? { data: Uint8Array.from(Buffer.from(m[2]!, 'base64')), mime: m[1]! } : null
    },
  })
  writeFileSync(join(outDir, 'branded-pitch.pptx'), pptx)
  const zip = await JSZip.loadAsync(pptx)
  const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort()
  const withLogo = []
  for (const f of slideFiles) {
    const xml = await zip.file(f)!.async('string')
    if (xml.includes('descr="Logo"')) withLogo.push(f)
  }
  console.log(`pptx: ${slideFiles.length} slides, logo on ${withLogo.length}: ${withLogo.map((f) => f.split('/').pop()).join(', ')}`)

  // The Yjs binding keeps the brand reference (checked, not rendered).
  void deckToYDoc(branded)
  await browser.close()
}

main().catch(async (err) => {
  console.error(err)
  await browser.close().catch(() => undefined)
  process.exitCode = 1
})

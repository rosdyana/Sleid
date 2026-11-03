// Live check of the prompt-to-deck wizard's model path against a real OpenAI-compatible server.
// Usage (from repo root):
//   LIVE_WIZARD_BASE_URL=https://host/v1 LIVE_WIZARD_MODEL=name node --experimental-strip-types apps/web/scripts/live-wizard-check.ts [outDir]
// It takes the brief from the M6 plan, a CSV (monthly electricity bill, before and after solar), and one public URL
// fetched through the production SSRF-safe fetch. It drafts the outline, then writes each slide in order with the
// same code the worker uses, applies the ops to an in-memory deck, and writes deck.json and report.json.
// It does NOT render PNGs or run the browser. Those checks are separate (see docs/DESIGN.md, M6).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyOps, createDeck, deckToYDoc, yDocToDeck, type Deck, type Element, type Op } from '@sleid/model'
import { buildIngested, chunksOf, extractFile, extractUrl, fetchPublicUrl, relevantChunks, type IngestedSource } from '@sleid/ingest'
import { createProvider, createPinnedFetch, draftOutline, withKnownSources, writeWizardSlide, WizardBrief, type WizardBrief as Brief } from '@sleid/llm'

const baseUrl = process.env.LIVE_WIZARD_BASE_URL
const model = process.env.LIVE_WIZARD_MODEL
if (!baseUrl || !model) throw new Error('Set LIVE_WIZARD_BASE_URL and LIVE_WIZARD_MODEL')
const outDir = process.argv[2] ?? join(process.cwd(), 'test-results', 'live-wizard')
mkdirSync(outDir, { recursive: true })

const provider = createProvider(
  { kind: 'openai-compatible', baseUrl, model, timeoutMs: 180_000 },
  { fetch: createPinnedFetch({ allowPrivate: false }) },
)
// The openai-compatible default is compact prompts (see apps/web settings).
const call = { provider, compact: true }

const brief: Brief = WizardBrief.parse({
  prompt: 'Pitch deck: rooftop solar for small bakeries in Jakarta',
  audience: 'bakery owners',
  goal: 'pitch',
  slideCount: 8,
  language: 'id',
  theme: 'Sheets Light',
  includeNotes: true,
  includeCharts: true,
  includeSources: true,
})

const timings: Record<string, number> = {}
const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    timings[label] = Date.now() - t0
  }
}

// References: the CSV, then the public page.
const csv = 'Bulan,Tagihan sebelum (Rp),Tagihan sesudah (Rp)\nJan,4200000,2600000\nFeb,4100000,2550000\nMar,4350000,2480000\nApr,4250000,2400000\nMei,4000000,2350000\nJun,4150000,2300000\n'
const csvSource = buildIngested({
  kind: 'file',
  title: 'tagihan-listrik.csv',
  fileName: 'tagihan-listrik.csv',
  ...(await extractFile({ fileName: 'tagihan-listrik.csv', bytes: new TextEncoder().encode(csv) }).then((r) => ({ text: r.text, tables: r.tables, images: r.images, warnings: r.warnings }))),
})
const PAGE = 'https://en.wikipedia.org/wiki/Solar_power_in_Indonesia'
const pageSource = await timed('fetch page', async () => {
  const fetched = await fetchPublicUrl(PAGE)
  const r = await extractUrl(fetched, 'Solar power in Indonesia')
  return buildIngested({ kind: 'url', title: r.title, url: fetched.url, text: r.text, tables: r.tables, warnings: r.warnings })
})

const sources: Array<{ id: string; ingested: IngestedSource }> = [
  { id: 'ref-csv', ingested: csvSource },
  { id: 'ref-page', ingested: pageSource },
]
const references = sources.map((s) => ({ id: s.id, title: s.ingested.title, origin: s.ingested.url ?? s.ingested.fileName ?? 'web', summary: s.ingested.text.slice(0, 1200) }))

const { outline, warnings: outlineWarnings } = await timed('outline', () => draftOutline(call, { brief, references }))
writeFileSync(join(outDir, 'outline.json'), JSON.stringify(outline, null, 2))

// Slides, in order, with the worker's rules: relevant chunks per slide, the table only when the slide asks for a chart.
let deck: Deck = createDeck('Pitch deck')
const doc = deckToYDoc(deck)
const initialSlideIds = deck.slides.map((s) => s.id)
const numbered = sources.map((s, i) => ({ number: i + 1, ...s }))
const chunkList = chunksOf(sources)
const slideReports: Array<Record<string, unknown>> = []
const slideWarnings: string[] = []
let totalInput = 0
let totalOutput = 0
for (let i = 0; i < outline.slides.length; i++) {
  const slide = outline.slides[i]!
  const relevant = relevantChunks([slide.title, ...slide.keyPoints].join(' '), chunkList, 6)
  const context = {
    refs: numbered.map((s) => ({ number: s.number, sourceId: s.id, title: s.ingested.title, origin: s.ingested.url ?? s.ingested.fileName ?? 'web' })),
    chunks: relevant.map((c) => ({ number: numbered.find((s) => s.id === c.sourceId)!.number, text: c.text })),
    tables: slide.visual === 'chart' ? csvSource.tables.map((t, tableIndex) => ({ number: 1, sourceId: 'ref-csv', tableIndex, name: t.name, columns: t.columns, rows: t.rows })) : [],
  }
  const current = deckFromDoc(doc)
  const t0 = Date.now()
  let ops: Op[] = []
  let status = 'ok'
  let error = ''
  try {
    const result = await writeWizardSlide(call, { brief, outline, slideIndex: i, slide, context, theme: current.theme, deck: current })
    ops = result.ops
    slideWarnings.push(...result.warnings)
    totalInput += result.usage.inputTokens
    totalOutput += result.usage.outputTokens
  } catch (err) {
    status = 'placeholder'
    error = err instanceof Error ? err.message.slice(0, 200) : String(err)
    ops = [{ op: 'addSlide', layout: 'title-content', slide: { id: crypto.randomUUID(), notes: 'Placeholder: the slide could not be written.', elements: [] } } as Op]
  }
  const cleanup: Op[] = i === 0 ? initialSlideIds.map((slideId) => ({ op: 'deleteSlide', slideId }) as Op) : []
  applyOps(doc, [...ops, ...cleanup], 'server:wizard')
  const ms = Date.now() - t0
  timings[`slide ${i + 1}`] = ms
  slideReports.push({ index: i + 1, title: slide.title, visual: slide.visual, status, ms, error })
  console.log(`slide ${i + 1} (${slide.visual}): ${status} in ${ms} ms${error ? ` - ${error}` : ''}`)
}
deck = yDocToDeck(doc)
writeFileSync(join(outDir, 'deck.json'), JSON.stringify(deck, null, 2))

// Checks that do not need a picture.
const csvRows = csvSource.tables[0]!.rows
const charts = deck.slides.flatMap((s, i) => s.elements.filter((e): e is Extract<Element, { type: 'chart' }> => e.type === 'chart').map((c) => ({ slide: i + 1, chart: c })))
const chartChecks = charts.map(({ slide, chart }) => {
  const illustrative = /illustrative/i.test(chart.options.title ?? '')
  const matches = chart.data.rows.every((row) => {
    const src = csvRows.find((r) => r[0] === row[0])
    return !src || (src[1] === row[1] && src[2] === row[2])
  })
  return { slide, title: chart.options.title, illustrative, numbersMatchCsv: matches, rows: chart.data.rows.length }
})
const allText = deck.slides.map((s) => [s.elements.map((e) => (e.type === 'text' ? JSON.stringify(e.content) : '')).join(' '), s.notes].join(' ')).join(' ')
const indonesianHits = (allText.match(/\b(dan|yang|untuk|dengan|tagihan|listrik|surya|bisa|dari)\b/gi) ?? []).length
const englishHits = (allText.match(/\b(the|and|with|for|bills|solar)\b/gi) ?? []).length
const citations = deck.slides.filter((s) => /\[\d\]/.test(s.notes)).length
const report = {
  model,
  endpoint: baseUrl,
  brief,
  outlineSlides: outline.slides.length,
  outlineWarnings,
  slides: slideReports,
  chartChecks,
  language: { indonesianWordHits: indonesianHits, englishWordHits: englishHits },
  slidesWithCitationsInNotes: citations,
  slideWarnings,
  tokens: { input: totalInput, output: totalOutput },
  timingsMs: timings,
  modelCalls: 1 + outline.slides.length,
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ timingsMs: timings, chartChecks, language: report.language, citations, warnings: slideWarnings.length }, null, 2))

function deckFromDoc(d: ReturnType<typeof deckToYDoc>): Deck {
  return yDocToDeck(d)
}

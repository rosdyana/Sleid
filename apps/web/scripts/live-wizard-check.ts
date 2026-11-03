// Live check of the prompt-to-deck wizard's model path against a real OpenAI-compatible server.
// Usage (from repo root):
//   LIVE_WIZARD_BASE_URL=https://host/v1 LIVE_WIZARD_MODEL=name node --experimental-strip-types apps/web/scripts/live-wizard-check.ts [outDir]
// It takes the brief from the M6 plan, a CSV (monthly electricity bill, before and after solar), and one public URL
// fetched through the production SSRF-safe fetch. It drafts the outline, then writes each slide in order with the
// same code the worker uses (FACTS, the numeric check, the placeholder), applies the ops to an in-memory deck, retries
// placeholder slides once in place (the worker's retry), and writes deck.json, report.json, numbers.json and
// facts.json. It does NOT render PNGs or run the browser; render the deck from deck.json separately (see docs/DESIGN.md, M6).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyOps, BUILT_IN_THEMES, createDeck, DEFAULT_THEME, deckToYDoc, yDocToDeck, type Deck, type Element, type Op } from '@sleid/model'
import { buildIngested, chunksOf, extractFile, extractUrl, fetchPublicUrl, relevantChunks, type IngestedSource } from '@sleid/ingest'
import {
  allFacts,
  chartKeysOf,
  createPinnedFetch,
  createProvider,
  draftOutline,
  parseFigures,
  placeholderSlide,
  replaceSlideOps,
  sourcesSlideOps,
  slideFacts,
  supportFor,
  writeWizardSlide,
  WizardBrief,
  type FactTable,
  type SlideContext,
  type WizardBrief as Brief,
} from '@sleid/llm'

const baseUrl = process.env.LIVE_WIZARD_BASE_URL
const model = process.env.LIVE_WIZARD_MODEL
if (!baseUrl || !model) throw new Error('Set LIVE_WIZARD_BASE_URL and LIVE_WIZARD_MODEL')
const outDir = process.argv[2] ?? join(process.cwd(), 'test-results', 'live-wizard')
mkdirSync(outDir, { recursive: true })

const provider = createProvider(
  { kind: 'openai-compatible', baseUrl, model, timeoutMs: 180_000 },
  // LIVE_WIZARD_ALLOW_PRIVATE=1 is for the dry run against the local fake model only. The live run leaves it unset.
  { fetch: createPinnedFetch({ allowPrivate: process.env.LIVE_WIZARD_ALLOW_PRIVATE === '1' }) },
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

// FACTS: computed from every reference table, the same way the worker computes them.
const numbered = sources.map((s, i) => ({ number: i + 1, ...s }))
const factTables: FactTable[] = numbered.flatMap((s) => s.ingested.tables.map((table, tableIndex) => ({ number: s.number, sourceId: s.id, tableIndex, table })))
const facts = allFacts(factTables, brief.language)
writeFileSync(join(outDir, 'facts.json'), JSON.stringify(facts, null, 2))

// Slides, in order, with the worker's rules: relevant chunks per slide, the table only when the slide asks for a chart.
let deck: Deck = createDeck('Pitch deck')
const doc = deckToYDoc(deck)
const initialSlideIds = deck.slides.map((s) => s.id)
// The worker applies the brief's theme before the first slide (a built-in name, or the AI theme; the AI theme is not run here).
const briefTheme = BUILT_IN_THEMES.find((t) => t.name === brief.theme) ?? DEFAULT_THEME
applyOps(doc, [{ op: 'setTheme', theme: briefTheme as unknown as Record<string, unknown> } as Op], 'server:wizard')
const placedCharts = new Set<string>()
const chunkList = chunksOf(sources)
const refsForContext = numbered.map((s) => ({ number: s.number, sourceId: s.id, title: s.ingested.title, origin: s.ingested.url ?? s.ingested.fileName ?? 'web' }))

function contextFor(slide: (typeof outline.slides)[number]): SlideContext {
  const relevant = relevantChunks([slide.title, ...slide.keyPoints].join(' '), chunkList, 6)
  return {
    refs: refsForContext,
    chunks: relevant.map((c) => ({ number: numbered.find((s) => s.id === c.sourceId)!.number, text: c.text })),
    tables: slide.visual === 'chart' ? csvSource.tables.map((t, tableIndex) => ({ number: 1, sourceId: 'ref-csv', tableIndex, name: t.name, columns: t.columns, rows: t.rows })) : [],
    facts: slideFacts(facts, slide.sourceIds),
  }
}

const slideReports: Array<Record<string, unknown>> = []
const slideWarnings: string[] = []
const supportBySlide = new Map<number, number[]>()
const failed: Array<{ slideId: string; number: number }> = []
let totalInput = 0
let totalOutput = 0
for (let i = 0; i < outline.slides.length; i++) {
  const slide = outline.slides[i]!
  const context = contextFor(slide)
  supportBySlide.set(i, supportFor(context))
  const current = yDocToDeck(doc)
  const t0 = Date.now()
  let ops: Op[] = []
  let status = 'ok'
  let error = ''
  let estimates: string[] = []
  try {
    const result = await writeWizardSlide(call, { brief, outline, slideIndex: i, slide, context, theme: current.theme, deck: current, placedCharts })
    ops = result.ops
    estimates = result.estimates
    if (result.chartKey) placedCharts.add(result.chartKey)
    slideWarnings.push(...result.warnings)
    totalInput += result.usage.inputTokens
    totalOutput += result.usage.outputTokens
  } catch (err) {
    status = 'placeholder'
    error = err instanceof Error ? err.message.slice(0, 200) : String(err)
    const p = placeholderSlide({ slideIndex: i, title: slide.title, bullets: slide.keyPoints, theme: current.theme, language: brief.language })
    ops = [p.op]
    failed.push({ slideId: p.slideId, number: i + 1 })
  }
  const cleanup: Op[] = i === 0 ? initialSlideIds.map((slideId) => ({ op: 'deleteSlide', slideId }) as Op) : []
  applyOps(doc, [...ops, ...cleanup], 'server:wizard')
  const ms = Date.now() - t0
  timings[`slide ${i + 1}`] = ms
  slideReports.push({ index: i + 1, title: slide.title, visual: slide.visual, status, ms, error, estimates })
  console.log(`slide ${i + 1} (${slide.visual}): ${status} in ${ms} ms${error ? ` - ${error}` : ''}${estimates.length ? ` - estimates: ${estimates.join(', ')}` : ''}`)
}

// The retry, as the worker runs it for placeholder slides: each is written again and replaces its placeholder in place.
const retries: Array<Record<string, unknown>> = []
if (failed.length) console.log(`retrying ${failed.length} placeholder slide(s) once`)
for (const f of [...failed]) {
  const now = yDocToDeck(doc)
  const position = now.slides.findIndex((s) => s.id === f.slideId)
  const slide = outline.slides[f.number - 1]!
  const t0 = Date.now()
  try {
    const context = contextFor(slide)
    const result = await writeWizardSlide(call, { brief, outline, slideIndex: f.number - 1, slide, context, theme: now.theme, deck: now, placedCharts: chartKeysOf(now) })
    const add = result.ops[0]
    if (position < 0 || result.ops.length !== 1 || !add || add.op !== 'addSlide') throw new Error('the reply did not make a slide')
    applyOps(doc, replaceSlideOps(position, f.slideId, add), 'server:wizard')
    if (result.chartKey) placedCharts.add(result.chartKey)
    slideWarnings.push(...result.warnings)
    totalInput += result.usage.inputTokens
    totalOutput += result.usage.outputTokens
    failed.splice(failed.indexOf(f), 1)
    retries.push({ slide: f.number, status: 'written', ms: Date.now() - t0, estimates: result.estimates })
    console.log(`retry of slide ${f.number}: written in ${Date.now() - t0} ms`)
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err)
    retries.push({ slide: f.number, status: 'still a placeholder', ms: Date.now() - t0, error: message })
    console.log(`retry of slide ${f.number}: still a placeholder - ${message}`)
  }
}

// The Sources slide, as the worker adds it when the brief asks for one and references were used.
const refsForSources = numbered.map((s) => ({ number: s.number, title: s.ingested.title, origin: s.ingested.url ?? s.ingested.fileName ?? 'web' }))
let sourcesSlideAdded = false
if (brief.includeSources && refsForSources.length) {
  applyOps(doc, sourcesSlideOps(briefTheme, refsForSources), 'server:wizard')
  sourcesSlideAdded = true
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

// The visible text of each slide (titles, subtitles and bullets), and every figure in it, checked against the slide's
// own reference text and FACTS (the same support the checker used).
const visibleOf = (node: unknown): string => {
  if (!node || typeof node !== 'object') return ''
  const n = node as { text?: unknown; content?: unknown[] }
  if (typeof n.text === 'string') return n.text
  return Array.isArray(n.content) ? n.content.map(visibleOf).join(' ') : ''
}
const numberRows: Array<Record<string, unknown>> = []
const labelLeaks: string[] = []
deck.slides.forEach((s, i) => {
  if (sourcesSlideAdded && i === deck.slides.length - 1) return
  const bodyTexts = s.elements.filter((e): e is Extract<Element, { type: 'text' }> => e.type === 'text').map((e) => visibleOf(e.content))
  for (const t of bodyTexts) if (/\bS\d+\b|\[\d+\]/.test(t)) labelLeaks.push(`slide ${i + 1}: ${t.slice(0, 80)}`)
  const support = supportBySlide.get(i) ?? []
  const figuresText = bodyTexts.join(' | ')
  for (const f of parseFigures(figuresText)) {
    const supported = f.exempt || f.readings.some((r) => support.some((v) => Math.abs(v - r.value) <= r.tolerance + 1e-9))
    const after = figuresText.slice(f.end, f.end + 14)
    numberRows.push({ slide: i + 1, text: f.raw, value: f.readings[0]!.value, exempt: f.exempt, supported, marked: /^\s*\((perkiraan|estimate)\)/.test(after) })
  }
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
  retries,
  placeholdersAfterRetry: failed.map((f) => f.number),
  chartChecks,
  language: { indonesianWordHits: indonesianHits, englishWordHits: englishHits },
  slidesWithCitationsInNotes: citations,
  sourcesSlideAdded,
  labelLeaks,
  theme: deck.theme.name,
  slideWarnings,
  numbers: { total: numberRows.length, unsupported: numberRows.filter((r) => !r.supported && !r.exempt).length, marked: numberRows.filter((r) => r.marked).length },
  tokens: { input: totalInput, output: totalOutput },
  timingsMs: timings,
  modelCalls: 1 + outline.slides.length + retries.length,
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
writeFileSync(join(outDir, 'numbers.json'), JSON.stringify(numberRows, null, 2))
console.log(JSON.stringify({ timingsMs: timings, chartChecks, language: report.language, citations, warnings: slideWarnings.length, numbers: report.numbers, labelLeaks }, null, 2))

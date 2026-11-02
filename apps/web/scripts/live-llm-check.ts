// Live check of every assistant ability against a real OpenAI-compatible server.
// Usage (from repo root):
//   LIVE_LLM_BASE_URL=https://host/v1 LIVE_LLM_MODEL=name [LIVE_LLM_API_KEY=...] \
//   CHROME_PATH=... node apps/web/scripts/live-llm-check.ts [outDir]
// Requests go through the pinned fetch with private addresses refused (the user-scope policy),
// so this also exercises the TLS path of the SSRF guard. Writes deck.json, report.json and,
// when CHROME_PATH is set, slide-N.png renders of the resulting deck to outDir.
// LIVE_LLM_STEPS=diagram (a comma list of step tags: diagram, chat, or an ability name) runs only those steps.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyOps, createDeck, deckToYDoc, yDocToDeck, type Deck } from '@sleid/model'
import { createPinnedFetch, createProvider, runAbility, runChat, type AbilityName, type AbilityOutcome, type LlmProvider } from '@sleid/llm'

const baseUrl = process.env.LIVE_LLM_BASE_URL
const model = process.env.LIVE_LLM_MODEL
if (!baseUrl || !model) throw new Error('Set LIVE_LLM_BASE_URL and LIVE_LLM_MODEL')
const outDir = process.argv[2] ?? join(process.cwd(), 'test-results', 'live-llm')
mkdirSync(outDir, { recursive: true })
// LIVE_LLM_RENDER_ONLY=1 skips the model steps and only renders the deck.json already in the output directory.
const renderOnly = process.env.LIVE_LLM_RENDER_ONLY === '1'

const base: LlmProvider = createProvider(
  { kind: 'openai-compatible', baseUrl, model, ...(process.env.LIVE_LLM_API_KEY ? { apiKey: process.env.LIVE_LLM_API_KEY } : {}), timeoutMs: 180_000 },
  { fetch: createPinnedFetch({ allowPrivate: false }) },
)
// Counts the model requests each step makes (the HTTP calls, including the retries inside a step).
let modelCalls = 0
const provider: LlmProvider = {
  ...base,
  generate: (request) => {
    modelCalls++
    return base.generate(request)
  },
  stream: (request) => {
    modelCalls++
    return base.stream(request)
  },
}

const doc = deckToYDoc(renderOnly ? (JSON.parse(readFileSync(join(outDir, 'deck.json'), 'utf8')) as Deck) : createDeck('Solar energy for small businesses'))
const deck = (): Deck => yDocToDeck(doc)
const report: Array<{ step: string; ok: boolean; ms: number; calls?: number; summary?: string; warnings?: string[]; ops?: number; error?: string; usage?: unknown }> = []
const onlySteps = process.env.LIVE_LLM_STEPS ? new Set(process.env.LIVE_LLM_STEPS.split(',').map((s) => s.trim()).filter(Boolean)) : null
const wanted = (tag: string) => onlySteps === null || onlySteps.has(tag)

async function step(name: string, ability: AbilityName, input: (d: Deck) => unknown, apply = true, tag: string = ability): Promise<AbilityOutcome | null> {
  if (!wanted(tag)) return null
  const t0 = Date.now()
  const calls0 = modelCalls
  try {
    const out = await runAbility(ability as never, { provider, deck: deck(), compact: true }, input(deck()))
    if (apply && out.ops.length) applyOps(doc, out.ops, 'live-check')
    report.push({ step: name, ok: true, ms: Date.now() - t0, calls: modelCalls - calls0, summary: out.summary, warnings: out.warnings, ops: out.ops.length, usage: out.usage })
    console.log(`ok   ${name} (${Date.now() - t0} ms, ${modelCalls - calls0} model call(s)) — ${out.summary}${out.warnings.length ? ` [warnings: ${out.warnings.join(' | ')}]` : ''}`)
    return out
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    report.push({ step: name, ok: false, ms: Date.now() - t0, calls: modelCalls - calls0, error: message })
    console.log(`FAIL ${name} (${Date.now() - t0} ms, ${modelCalls - calls0} model call(s)) — ${message}`)
    return null
  }
}

// The longest text box in the deck: a body with real content to rewrite.
const titleBody = (d: Deck) =>
  d.slides
    .flatMap((s) => s.elements)
    .filter((e) => e.type === 'text')
    .sort((a, b) => JSON.stringify(b.content).length - JSON.stringify(a.content).length)[0]!

if (!renderOnly) {
  await step('generate title slide', 'generateSlide', () => ({ prompt: 'Title slide: why solar panels pay off for small shops in Indonesia', index: 0, layoutHint: 'title' }))
  await step('generate content slide', 'generateSlide', () => ({ prompt: 'Three key benefits of rooftop solar for a small bakery, short bullets', layoutHint: 'title-content' }))
  await step('generate chart', 'generateChart', (d) => ({ prompt: 'Monthly electricity cost in million IDR before and after solar for Jan–Jun, the after line lower', slideId: d.slides[1]?.id }))
  await step('generate diagram slide', 'generateSlide', () => ({ prompt: 'Section slide titled "How it works"', layoutHint: 'section' }))
  await step('generate diagram', 'generateDiagram', (d) => ({ prompt: 'Flow: sunlight -> panels -> inverter -> shop appliances, with surplus -> battery', slideId: d.slides[d.slides.length - 1]!.id }), true, 'diagram')
  await step('rewrite shorten', 'rewriteText', (d) => ({ elementId: titleBody(d).id, mode: 'shorten' }))
  await step('rewrite translate', 'rewriteText', (d) => ({ elementId: titleBody(d).id, mode: 'translate', language: 'Indonesian' }), false)
  await step('generate theme', 'generateTheme', () => ({ prompt: 'Warm, sunny, trustworthy; for a solar installer', brandColors: ['#f59e0b'] }))
  await step('speaker notes', 'speakerNotes', (d) => ({ slideIds: d.slides.map((s) => s.id), tone: 'friendly', length: 'short' }))
  await step('suggest effects', 'suggestEffects', (d) => ({ slideIds: d.slides.map((s) => s.id) }))
  await step('explain', 'explain', (d) => ({ question: 'Is anything on this slide likely to confuse a shop owner?', slideId: d.slides[1]?.id }), false)

  // Chat with tools.
  if (wanted('chat')) {
    const t0 = Date.now()
    let proposals = 0
    let text = ''
    let error: string | undefined
    try {
      for await (const ev of runChat({ provider, deck: deck(), compact: true }, { messages: [{ role: 'user', content: 'Add a closing slide with a call to action to book a free roof survey.' }], focusSlideId: deck().slides[0]!.id })) {
        if (ev.type === 'text') text += ev.delta
        if (ev.type === 'proposal') {
          proposals++
          applyOps(doc, ev.proposal.ops, 'live-check')
        }
        if (ev.type === 'error') error = ev.message
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    const ok = !error && proposals > 0
    report.push({ step: 'chat with tools', ok, ms: Date.now() - t0, summary: `${proposals} proposal(s); text: ${text.slice(0, 160)}`, ...(error ? { error } : {}) })
    console.log(`${ok ? 'ok  ' : 'FAIL'} chat with tools (${Date.now() - t0} ms) — ${proposals} proposal(s)${error ? ` — ${error}` : ''}`)
  }
}

if (!renderOnly) {
  writeFileSync(join(outDir, 'deck.json'), JSON.stringify(deck(), null, 2))
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${report.filter((r) => r.ok).length}/${report.length} steps ok; ${deck().slides.length} slides; output in ${outDir}`)
}

if (process.env.CHROME_PATH) {
  const { renderDeckHtml, DEFAULT_MERMAID_SCRIPT } = await import('@sleid/render')
  const { chromium } = await import('playwright-core')
  const html = renderDeckHtml(deck(), { mode: 'present', mermaid: DEFAULT_MERMAID_SCRIPT })
  writeFileSync(join(outDir, 'deck.html'), html)
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
  for (let i = 0; i < deck().slides.length; i++) {
    // A fresh page per slide. Mermaid measures each diagram at page load, and one loaded on a hidden slide comes out
    // as a 16 px box. Reveal's own navigation (which runs the slide's transition) is not used, because it did not keep
    // the diagrams on the later slides readable.
    const slidePage = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await slidePage.goto(`file://${join(outDir, 'deck.html')}#/${i}`)
    await slidePage.waitForTimeout(2500)
    await slidePage.evaluate(() => document.querySelectorAll('.fragment').forEach((f) => f.classList.add('visible')))
    // Wait until every diagram on the deck has drawn its SVG (Mermaid loads from a CDN, so this can take a few seconds).
    await slidePage.waitForFunction(() => [...document.querySelectorAll('.sleid-diagram-el')].every((el) => el.querySelector('svg')), null, { timeout: 30_000 }).catch(() => {})
    await slidePage.waitForTimeout(2000)
    await slidePage.screenshot({ path: join(outDir, `slide-${i + 1}.png`) })
    await slidePage.close()
  }
  await browser.close()
  console.log('renders written')
}

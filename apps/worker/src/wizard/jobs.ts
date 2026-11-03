// The wizard's background work: reference ingestion, research, and generation of the deck, slide by slide.
// Failures are written to the run or source row (never thrown to the queue), so the editor and the dashboard show them.
import { BUILT_IN_THEMES, DEFAULT_THEME, type Deck, type Op, type Theme } from '@sleid/model'
import {
  chunksOf,
  buildIngested,
  extractFile,
  extractUrl,
  fetchPublicUrl,
  relevantChunks,
  IngestError,
  LIMITS,
  type FetchedUrl,
  type IngestedSource,
} from '@sleid/ingest'
import {
  allFacts,
  chartKeysOf,
  draftResearchQueries,
  Outline,
  placeholderSlide,
  replaceSlideOps,
  slideFacts,
  sourcesSlideOps,
  WizardBrief,
  writeWizardSlide,
  runAbility,
  type FactLine,
  type OutlineSlide,
  type SlideContext,
  type Usage,
} from '@sleid/llm'
import {
  getWizardRun,
  getWizardSource,
  insertWizardSource,
  listWizardSources,
  reapStaleWizardRuns,
  recordLlmUsage,
  setWizardStatusUnlessCancelled,
  touchWizardRun,
  updateWizardRun,
  updateWizardSource,
  type Db,
  type FailedSlide,
} from '@sleid/db'
import type { StorageDriver } from '@sleid/storage'
import type { SearchProvider, SearchResult } from '@sleid/research'
import { dedupeResults } from '@sleid/research'
import type { Logger } from '../logger.ts'
import type { ResolvedWizardProvider } from './provider.ts'
import type { WizardCollab } from './collab.ts'
import { startPointFor } from './start-point.ts'

export const MAX_RESEARCH_URLS = 8
const RESEARCH_RESULTS_PER_QUERY = 5
export const AI_THEME = 'AI from brand colours'
/** A run that has made no progress for this long lost its worker. */
export const STALE_RUN_MS = 5 * 60_000
export const STALE_RUN_MESSAGE = 'The worker stopped before this run finished (no progress for 5 minutes). The slides written so far are kept. Start the run again from its outline.'

export interface WizardEnv {
  db: Db
  uploads: StorageDriver
  collab: WizardCollab
  resolveProvider(userId: string, providerId: string | null): Promise<ResolvedWizardProvider>
  /** Null when no search provider is configured. Research then refuses to run. */
  search: SearchProvider | null
  /** Queues an ingest job for a source. */
  enqueueIngest(runId: string, sourceId: string): Promise<void>
  /** Test-only override for the URL fetch (the production fetch is the SSRF-safe one). */
  fetchUrl?: (url: string) => Promise<FetchedUrl>
  logger: Logger
}

function messageOf(err: unknown): string {
  if (err instanceof IngestError) return err.message
  if (err instanceof Error) return err.message.split('\n')[0]!.slice(0, 300)
  return 'Something went wrong.'
}

async function isCancelled(db: Db, runId: string): Promise<boolean> {
  return (await getWizardRun(db, runId))?.status === 'cancelled'
}

/** Marks runs whose worker stopped (no heartbeat for STALE_RUN_MS) as failed. Called once when the worker starts. */
export async function recoverStaleRuns(env: { db: Db; logger: Logger }, now?: Date): Promise<string[]> {
  const reaped = await reapStaleWizardRuns(env.db, { staleMs: STALE_RUN_MS, message: STALE_RUN_MESSAGE, ...(now ? { now } : {}) })
  if (reaped.length) env.logger.warn(`[wizard] ${reaped.length} run(s) had no progress for 5 minutes and were marked failed: ${reaped.join(', ')}`)
  return reaped
}

/** Ingests one source: reads its file or fetches its URL, extracts the text, and stores the result on the row. */
export async function runIngest(env: WizardEnv, sourceId: string): Promise<void> {
  const source = await getWizardSource(env.db, sourceId)
  if (!source) return
  const run = await getWizardRun(env.db, source.runId)
  if (!run || run.status === 'cancelled') {
    await updateWizardSource(env.db, sourceId, { status: 'failed', error: 'The run was cancelled.' })
    return
  }
  await updateWizardSource(env.db, sourceId, { status: 'running', error: null })
  try {
    let ingested: IngestedSource
    if (source.kind === 'file') {
      if (!source.fileKey || !source.fileName) throw new IngestError('invalid', 'The uploaded file is missing.')
      const bytes = await env.uploads.get(source.fileKey)
      if (!bytes) throw new IngestError('invalid', 'The uploaded file is missing from storage.')
      const r = await extractFile({ fileName: source.fileName, bytes })
      ingested = buildIngested({ kind: 'file', title: source.title, fileName: source.fileName, text: r.text, tables: r.tables, images: r.images, warnings: r.warnings })
    } else {
      if (!source.url) throw new IngestError('invalid', 'The address is missing.')
      const fetched = await (env.fetchUrl ?? ((u: string) => fetchPublicUrl(u)))(source.url)
      const r = await extractUrl(fetched, source.title)
      ingested = buildIngested({ kind: source.kind, title: r.title || source.title, url: fetched.url, text: r.text, tables: r.tables, warnings: r.warnings })
    }
    if (!ingested.text.trim() && ingested.tables.length === 0 && ingested.images.length === 0) {
      throw new IngestError('invalid', 'No text could be read from it.')
    }
    await updateWizardSource(env.db, sourceId, {
      status: 'ready',
      title: ingested.title,
      wordCount: ingested.wordCount,
      extracted: ingested as unknown as Record<string, unknown>,
      error: null,
    })
  } catch (err) {
    env.logger.warn(`[wizard] source ${sourceId} failed: ${err instanceof Error ? err.message : String(err)}`)
    await updateWizardSource(env.db, sourceId, { status: 'failed', error: messageOf(err) })
  } finally {
    await touchWizardRun(env.db, source.runId)
  }
}

/** Searches for the brief, de-duplicates the results, and queues each page as a search source. */
export async function runResearch(env: WizardEnv, runId: string): Promise<void> {
  const run = await getWizardRun(env.db, runId)
  if (!run || run.status === 'cancelled') return
  if (!env.search) {
    await updateWizardRun(env.db, runId, { status: 'draft', error: 'Research is not configured on this server.' })
    return
  }
  await updateWizardRun(env.db, runId, { status: 'ingesting', error: null })
  try {
    const brief = WizardBrief.parse(run.brief)
    const resolved = await env.resolveProvider(run.userId, run.providerId)
    const { queries, usage } = await draftResearchQueries({ provider: resolved.provider, compact: resolved.compact }, brief)
    await recordLlmUsage(env.db, {
      userId: run.userId,
      deckId: null,
      providerId: resolved.providerId,
      ability: 'wizardQueries',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: 0,
      ok: true,
    })
    const results: SearchResult[] = []
    for (const query of queries) {
      if (await isCancelled(env.db, runId)) return
      try {
        results.push(...(await env.search.search(query, { limit: RESEARCH_RESULTS_PER_QUERY })))
      } catch (err) {
        env.logger.warn(`[wizard] search "${query}" failed: ${messageOf(err)}`)
      }
    }
    const picked = dedupeResults(results).slice(0, MAX_RESEARCH_URLS)
    if (picked.length === 0) {
      await updateWizardRun(env.db, runId, { status: 'draft', error: 'The search found no pages for this brief. Add references yourself.' })
      return
    }
    let position = (await listWizardSources(env.db, runId)).length
    for (const r of picked) {
      const row = await insertWizardSource(env.db, {
        runId,
        kind: 'search',
        title: r.title,
        url: r.url,
        fileName: null,
        mime: null,
        fileKey: null,
        bytes: null,
        status: 'queued',
        wordCount: 0,
        extracted: null,
        error: null,
        position: position++,
      })
      await env.enqueueIngest(runId, row.id)
    }
    await updateWizardRun(env.db, runId, { status: 'draft', error: null })
  } catch (err) {
    env.logger.error(`[wizard] research failed: ${messageOf(err)}`)
    await updateWizardRun(env.db, runId, { status: 'draft', error: `Research failed: ${messageOf(err)}` })
  }
}

/** What a slide is written from: the references (numbered as the model cites them), their chunks, tables and FACTS. */
interface RunContext {
  brief: WizardBrief
  outline: Outline
  resolved: ResolvedWizardProvider
  refs: Array<{ number: number; sourceId: string; title: string; origin: string }>
  numberOf: Map<string, number>
  sourceChunks: ReturnType<typeof chunksOf>
  tables: Array<{ number: number; sourceId: string; tableIndex: number; table: NonNullable<IngestedSource['tables']>[number] }>
  facts: FactLine[]
}

async function loadRunContext(env: WizardEnv, run: { id: string; userId: string; providerId: string | null }, brief: WizardBrief, outline: Outline): Promise<RunContext> {
  const resolved = await env.resolveProvider(run.userId, run.providerId)
  const ready = (await listWizardSources(env.db, run.id)).filter((s) => s.status === 'ready')
  const refs = ready.map((s, i) => ({ number: i + 1, sourceId: s.id, title: s.title, origin: s.url ?? s.fileName ?? 'web search' }))
  const numberOf = new Map(refs.map((r) => [r.sourceId, r.number]))
  const ingested = new Map(ready.map((s) => [s.id, s.extracted as unknown as IngestedSource]))
  const sourceChunks = chunksOf(ready.map((s) => ({ id: s.id, ingested: ingested.get(s.id)! })))
  const tables = refs.flatMap((r) => (ingested.get(r.sourceId)?.tables ?? []).map((table, tableIndex) => ({ number: r.number, sourceId: r.sourceId, tableIndex, table })))
  return { brief, outline, resolved, refs, numberOf, sourceChunks, tables, facts: allFacts(tables, brief.language) }
}

function contextFor(ctx: RunContext, slide: OutlineSlide): SlideContext {
  const relevant = relevantChunks([slide.title, ...slide.keyPoints].join(' '), ctx.sourceChunks, 6)
  const slideTables = (slide.sourceIds.length ? ctx.tables.filter((t) => slide.sourceIds.includes(t.sourceId)) : ctx.tables).slice(0, 5)
  return {
    refs: ctx.refs.map((r) => ({ number: r.number, sourceId: r.sourceId, title: r.title, origin: r.origin })),
    chunks: relevant.map((c) => ({ number: ctx.numberOf.get(c.sourceId) ?? 0, text: c.text })).filter((c) => c.number > 0),
    tables: slideTables.map((t) => ({ number: t.number, sourceId: t.sourceId, tableIndex: t.tableIndex, name: t.table.name, columns: t.table.columns, rows: t.table.rows })),
    facts: slideFacts(ctx.facts, slide.sourceIds),
  }
}

async function recordSlideUsage(env: WizardEnv, userId: string, deckId: string, providerId: string | null, usage: Usage): Promise<void> {
  await recordLlmUsage(env.db, {
    userId,
    deckId,
    providerId,
    ability: 'wizardSlide',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: 0,
    ok: true,
  })
}

/** Generates the deck from the outline. The deck exists already (created by the web app); slides land in it live. */
export async function runGenerate(env: WizardEnv, runId: string): Promise<void> {
  const run = await getWizardRun(env.db, runId)
  // A retried job for a run that already ended (cancelled, failed by the recovery, or done) does nothing.
  if (!run || ['cancelled', 'failed', 'done'].includes(run.status)) return
  const deckId = run.deckId
  if (!deckId || !run.outline) {
    await updateWizardRun(env.db, runId, { status: 'failed', error: 'The run has no deck or outline.' })
    return
  }
  try {
    const brief = WizardBrief.parse(run.brief)
    const outline = Outline.parse(run.outline)
    const ctx = await loadRunContext(env, run, brief, outline)
    const { resolved, refs } = ctx

    const warnings: string[] = []
    let deck = await env.collab.getDeck(deckId)
    const initialSlides = deck.slides.map((s) => s.id)
    let theme: Theme = deck.theme as Theme
    const pending: Op[] = []

    const start = await startPointFor(env, { userId: run.userId, deckId }, brief)
    if (start) {
      // A kit's theme and brand reference go on the deck before the first slide. writeWizardSlide reads the deck's
      // brand, so every slide is written against the kit's palette (and its snapped colours).
      await env.collab.applyOps(deckId, 'wizard', start.ops)
      deck = await env.collab.getDeck(deckId)
      theme = start.theme
    } else if (brief.theme === AI_THEME) {
      try {
        const outcome = await runAbility('generateTheme', { provider: resolved.provider, deck, compact: resolved.compact }, {
          ...(brief.brandColors?.length ? { brandColors: brief.brandColors } : {}),
          ...(brief.prompt ? { prompt: brief.prompt.slice(0, 1000) } : {}),
        })
        const op = outcome.ops.find((o) => o.op === 'setTheme')
        if (op && op.op === 'setTheme') {
          theme = { ...theme, ...op.theme } as Theme
          pending.push(op)
        }
        warnings.push(...outcome.warnings)
      } catch (err) {
        warnings.push(`The AI theme could not be made (${messageOf(err)}); the default theme is used.`)
        theme = DEFAULT_THEME
      }
    } else {
      const builtIn = BUILT_IN_THEMES.find((t) => t.name === brief.theme) ?? DEFAULT_THEME
      theme = builtIn
      pending.push({ op: 'setTheme', theme: builtIn as unknown as Record<string, unknown> } as Op)
    }

    const total = outline.slides.length + (brief.includeSources && refs.length ? 1 : 0)
    if (!(await setWizardStatusUnlessCancelled(env.db, runId, 'generating', { total, progress: 0, error: null, failedSlides: [] }))) return

    let defaultsDeleted = false
    let written = 0
    const failed: FailedSlide[] = []
    // Chart data already on the deck: the same chart is not placed on a second slide.
    const placedCharts = new Set<string>()
    for (let i = 0; i < outline.slides.length; i++) {
      if (await isCancelled(env.db, runId)) break
      const slide = outline.slides[i]!
      let ops: Op[]
      let slideChartKey: string | undefined
      let placeholderId: string | null = null
      try {
        deck = await env.collab.getDeck(deckId)
        const result = await writeWizardSlide({ provider: resolved.provider, compact: resolved.compact }, {
          brief,
          outline,
          slideIndex: i,
          slide,
          context: contextFor(ctx, slide),
          theme,
          deck,
          placedCharts,
        })
        ops = result.ops
        slideChartKey = result.chartKey
        warnings.push(...result.warnings)
        await recordSlideUsage(env, run.userId, deckId, resolved.providerId, result.usage)
      } catch (err) {
        env.logger.warn(`[wizard] slide ${i + 1} of run ${runId} failed: ${messageOf(err)}`)
        warnings.push(`Slide ${i + 1} could not be written: ${messageOf(err)}`)
        const placeholder = placeholderSlide({ slideIndex: i, title: slide.title, bullets: slide.keyPoints, theme, language: brief.language })
        ops = [placeholder.op]
        placeholderId = placeholder.slideId
      }
      const cleanup: Op[] = !defaultsDeleted ? initialSlides.map((slideId) => ({ op: 'deleteSlide', slideId }) as Op) : []
      const batch = [...pending.splice(0), ...ops, ...cleanup]
      try {
        await env.collab.applyOps(deckId, 'wizard', batch)
        if (slideChartKey) placedCharts.add(slideChartKey)
      } catch (err) {
        // A batch that the collab service refuses is replaced by the placeholder, so the run goes on.
        env.logger.warn(`[wizard] slide ${i + 1} of run ${runId} was refused: ${messageOf(err)}`)
        warnings.push(`Slide ${i + 1} was refused by the editor and replaced by its outline points.`)
        const fallback = placeholderSlide({ slideIndex: i, title: slide.title, bullets: slide.keyPoints, theme, language: brief.language })
        placeholderId = fallback.slideId
        await env.collab.applyOps(deckId, 'wizard', [fallback.op, ...cleanup])
      }
      if (placeholderId) failed.push({ slideId: placeholderId, number: i + 1 })
      if (cleanup.length) defaultsDeleted = true
      written++
      await setWizardStatusUnlessCancelled(env.db, runId, 'generating', { progress: written, failedSlides: failed })
    }

    if (await isCancelled(env.db, runId)) {
      env.logger.info(`[wizard] run ${runId} cancelled after ${written} slides`)
      return
    }

    if (brief.includeSources && refs.length) {
      const sourceOps = sourcesSlideOps(theme, refs.map((r) => ({ number: r.number, title: r.title, origin: r.origin })))
      const cleanup: Op[] = !defaultsDeleted ? initialSlides.map((slideId) => ({ op: 'deleteSlide', slideId }) as Op) : []
      await env.collab.applyOps(deckId, 'wizard', [...sourceOps, ...cleanup])
      if (cleanup.length) defaultsDeleted = true
      written++
      await setWizardStatusUnlessCancelled(env.db, runId, 'generating', { progress: written, failedSlides: failed })
    }

    if (!defaultsDeleted && initialSlides.length) {
      await env.collab.applyOps(deckId, 'wizard', initialSlides.map((slideId) => ({ op: 'deleteSlide', slideId }) as Op))
    }
    const done = await setWizardStatusUnlessCancelled(env.db, runId, 'done', {
      progress: written,
      failedSlides: failed,
      error: warnings.length ? warnings.slice(0, 5).join(' ') : null,
    })
    env.logger.info(`[wizard] run ${runId} ${done ? 'done' : 'not updated'}: ${written} of ${total} written, ${failed.length} placeholder(s), ${warnings.length} warnings`)
  } catch (err) {
    env.logger.error(`[wizard] run ${runId} failed: ${messageOf(err)}`)
    await setWizardStatusUnlessCancelled(env.db, runId, 'failed', { error: messageOf(err) })
  }
}

/**
 * Writes the run's placeholder slides again, in place: each old placeholder is deleted and its new slide is added at
 * the same index. Slides that still fail stay placeholders. The web app sets the run to `generating` before queuing
 * this job; the run ends `done` with the slides that are still placeholders.
 */
export async function runRetry(env: WizardEnv, runId: string): Promise<void> {
  const run = await getWizardRun(env.db, runId)
  if (!run || run.status !== 'generating' || !run.deckId || !run.outline) return
  const deckId = run.deckId
  const queue = [...run.failedSlides].sort((a, b) => a.number - b.number)
  const warnings: string[] = []
  const remaining: FailedSlide[] = []
  let next = 0
  let written = 0
  try {
    const brief = WizardBrief.parse(run.brief)
    const outline = Outline.parse(run.outline)
    const ctx = await loadRunContext(env, run, brief, outline)
    for (; next < queue.length; next++) {
      const f = queue[next]!
      if (await isCancelled(env.db, runId)) break
      const deck = await env.collab.getDeck(deckId)
      const position = deck.slides.findIndex((s) => s.id === f.slideId)
      const slide = outline.slides[f.number - 1]
      if (position < 0 || !slide) {
        // The user deleted the placeholder: nothing to replace.
        warnings.push(`Slide ${f.number} is no longer in the deck, so it was not written again.`)
        written++
        continue
      }
      try {
        const result = await writeWizardSlide({ provider: ctx.resolved.provider, compact: ctx.resolved.compact }, {
          brief,
          outline,
          slideIndex: f.number - 1,
          slide,
          context: contextFor(ctx, slide),
          theme: deck.theme as Theme,
          deck,
          placedCharts: chartKeysOf(deck),
        })
        const [add] = result.ops
        if (result.ops.length !== 1 || !add || add.op !== 'addSlide') throw new Error('the reply did not make a slide')
        await env.collab.applyOps(deckId, 'wizard', replaceSlideOps(position, f.slideId, add))
        await recordSlideUsage(env, run.userId, deckId, ctx.resolved.providerId, result.usage)
        warnings.push(...result.warnings)
      } catch (err) {
        env.logger.warn(`[wizard] retry of slide ${f.number} in run ${runId} failed: ${messageOf(err)}`)
        warnings.push(`Slide ${f.number} could not be written again: ${messageOf(err)}`)
        remaining.push(f)
      }
      written++
      await setWizardStatusUnlessCancelled(env.db, runId, 'generating', { progress: written })
    }
    if (await isCancelled(env.db, runId)) return
    const untried = queue.slice(next)
    const done = await setWizardStatusUnlessCancelled(env.db, runId, 'done', {
      progress: written,
      failedSlides: [...remaining, ...untried],
      error: warnings.length ? warnings.slice(0, 5).join(' ') : null,
    })
    env.logger.info(`[wizard] retry of run ${runId} ${done ? 'done' : 'not updated'}: ${queue.length - remaining.length - untried.length} written, ${remaining.length + untried.length} still placeholders`)
  } catch (err) {
    // The placeholders stay as they were, and the run can be retried again.
    env.logger.error(`[wizard] retry of run ${runId} failed: ${messageOf(err)}`)
    await setWizardStatusUnlessCancelled(env.db, runId, 'done', {
      progress: written,
      failedSlides: [...remaining, ...queue.slice(next)],
      error: `The retry failed: ${messageOf(err)}`,
    })
  }
}

export { LIMITS }

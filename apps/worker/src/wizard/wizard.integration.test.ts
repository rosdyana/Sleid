// Wizard jobs against real Postgres, a fake model (scripted replies), a fake search provider, and a local
// HTTP server for the URL reference. The collab service is replaced by an in-memory Yjs document that applies
// the same deck-ops (the collab path itself is covered by the MCP and collab integration tests).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyOps, builtInTemplateDeck, createDeck, deckToYDoc, yDocToDeck, type Deck, type Op } from '@sleid/model'
import { assets, getWizardRun, insertBrandKitRow, insertWizardRun, insertWizardSource, listWizardSources, setBrandKitLogo, updateWizardRun, getWizardSource, type Db } from '@sleid/db'
import { createHash, randomUUID } from 'node:crypto'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import { fetchPublicUrl } from '@sleid/ingest'
import { Outline, WizardBrief, withKnownSources } from '@sleid/llm'
import { scriptedProvider } from '@sleid/llm/testing'
import type { SearchProvider } from '@sleid/research'
import { recoverStaleRuns, runGenerate, runIngest, runResearch, runRetry, STALE_RUN_MESSAGE, type WizardEnv } from './jobs.ts'
import type { WizardCollab } from './collab.ts'

const db: Db | null = await connectOrNull()
const silent = { info() {}, warn() {}, error() {} }

const csvBytes = new TextEncoder().encode('Month,Before,After\nJan,120000,80000\nFeb,118000,76000\nMar,115000,70000\n')
const pageHtml = `<html><head><title>Local page</title></head><body><article><p>Rooftop solar lowers bakery bills in Jakarta.</p></article></body></html>`

function fakeCollab(title: string): { collab: WizardCollab; doc: Y.Doc; initialSlideIds: string[] } {
  const base = createDeck(title)
  const doc = deckToYDoc(base)
  return {
    doc,
    initialSlideIds: base.slides.map((s) => s.id),
    collab: {
      async applyOps(_deckId, actor, ops) {
        applyOps(doc, ops as Op[], `server:${actor}`)
        return { ok: true as const }
      },
      async getDeck(): Promise<Deck> {
        return yDocToDeck(doc)
      },
    },
  }
}

const slideReply = (o: Record<string, unknown>) => JSON.stringify(o)

describe.skipIf(!db)('wizard jobs (real Postgres)', () => {
  const database = db!
  let server: Server
  let base = ''
  let uploadsDir = ''
  let uploads: StorageDriver
  const users: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/page')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(pageHtml)
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    uploadsDir = mkdtempSync(join(tmpdir(), 'sleid-wizard-test-'))
    uploads = createLocalStorage(uploadsDir)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeUsers(database, users)
    rmSync(uploadsDir, { recursive: true, force: true })
  })

  async function setup(label: string) {
    const user = await makeUser(database, label)
    users.push(user.id)
    const deckId = await makeDeck(database, user.id, 'Wizard test')
    return { user, deckId }
  }

  function envFor(provider: ReturnType<typeof scriptedProvider>, collab: WizardCollab, extra: Partial<WizardEnv> = {}): WizardEnv {
    return {
      db: database,
      uploads,
      collab,
      search: null,
      enqueueIngest: async () => {},
      resolveProvider: async () => ({ provider, compact: false, secrets: [], providerId: null }),
      fetchUrl: (url) => fetchPublicUrl(url, { policy: { allowPrivate: true } }),
      logger: silent,
      ...extra,
    }
  }

  async function ingestFile(runId: string, name: string, bytes: Uint8Array, env: WizardEnv): Promise<string> {
    const row = await insertWizardSource(database, {
      runId,
      kind: 'file',
      title: name,
      url: null,
      fileName: name,
      mime: 'text/csv',
      fileKey: null,
      bytes: bytes.byteLength,
      status: 'queued',
      wordCount: 0,
      extracted: null,
      error: null,
      position: 0,
    })
    const fileKey = `wizard/${runId}/${row.id}`
    await uploads.put(fileKey, bytes)
    await database.execute(`update wizard_sources set file_key = '${fileKey}' where id = '${row.id}'` as never)
    await runIngest(env, row.id)
    return row.id
  }

  it('makes a deck from a brief, a CSV, a URL and an outline: chart numbers match the CSV, citations, Sources slide', async () => {
    const { user, deckId } = await setup('wizard-full')
    const brief = WizardBrief.parse({ prompt: 'Pitch: rooftop solar for bakeries', slideCount: 5, includeSources: true, language: 'en' })
    const run = await insertWizardRun(database, { userId: user.id, brief: brief as unknown as Record<string, unknown> })
    const fake = fakeCollab('Solar for bakeries')
    // References first (the CSV's source id is needed by the replies that chart it).
    const ingestEnv = envFor(scriptedProvider([]), fake.collab)
    const csvId = await ingestFile(run.id, 'bills.csv', csvBytes, ingestEnv)
    const urlRow = await insertWizardSource(database, {
      runId: run.id, kind: 'url', title: 'page', url: `${base}/page`, fileName: null, mime: null, fileKey: null, bytes: null,
      status: 'queued', wordCount: 0, extracted: null, error: null, position: 1,
    })
    await runIngest(ingestEnv, urlRow.id)
    const sources = await listWizardSources(database, run.id)
    expect(sources.map((s) => s.status)).toEqual(['ready', 'ready'])
    expect(sources[1]!.title).toBe('Local page')

    const provider = scriptedProvider([
      slideReply({ layout: 'title', title: 'Solar for bakeries', bullets: [], notes: 'Welcome.' }),
      slideReply({
        layout: 'title-content',
        title: 'Bills fall',
        bullets: ['Lower bills'],
        notes: 'Bills fell in every month [1].',
        chartFromTable: { title: 'Monthly bill', chartType: 'bar', sourceId: csvId, tableIndex: 0, categoryColumn: 'Month', valueColumns: ['Before', 'After'] },
      }),
      slideReply({ layout: 'title-content', title: 'Illustrative trend', bullets: ['Trend'], notes: 'Sketch only.', chartIllustrative: { title: 'Trend', chartType: 'line', categories: ['Q1', 'Q2'], series: [{ name: 'Output', values: [3, 5] }] } }),
      slideReply({ layout: 'title-content', title: 'How it works', bullets: ['Panels', 'Inverter'], notes: 'Flow.', diagram: { title: 'Flow', mermaid: 'graph LR\nA[Panels] --> B[Inverter]' } }),
      slideReply({ layout: 'title-content', title: 'Next steps', bullets: ['Survey roofs'], notes: 'Background [2].' }),
    ])
    const env = envFor(provider, fake.collab)
    const outline = withKnownSources(
      Outline.parse({
        title: 'Solar for bakeries',
        slides: [
          { title: 'Cover', layout: 'title', keyPoints: [], visual: 'none', sourceIds: [] },
          { title: 'Bills fall', layout: 'title-content', keyPoints: ['Lower bills'], visual: 'chart', sourceIds: [csvId] },
          { title: 'Illustrative trend', layout: 'title-content', keyPoints: ['Trend'], visual: 'chart', sourceIds: [] },
          { title: 'How it works', layout: 'title-content', keyPoints: ['Panels'], visual: 'diagram', sourceIds: [] },
          { title: 'Next steps', layout: 'title-content', keyPoints: ['Survey'], visual: 'none', sourceIds: [] },
        ],
      }),
      new Set(sources.map((s) => s.id)),
    )
    await updateWizardRun(database, run.id, { status: 'ready', outline: outline as unknown as Record<string, unknown>, total: 6, deckId })

    await runGenerate(env, run.id)

    const after = await getWizardRun(database, run.id)
    expect(after!.status).toBe('done')
    expect(after!.progress).toBe(6)
    const deck = yDocToDeck(fake.doc)
    expect(deck.slides).toHaveLength(6)
    expect(deck.slides.some((s) => fake.initialSlideIds.includes(s.id))).toBe(false)
    expect(deck.theme.name).toBe('Sheets Light')

    const chart = deck.slides[1]!.elements.find((e) => e.type === 'chart') as { data: { columns: string[]; rows: unknown[][] } }
    expect(chart.data.columns).toEqual(['Month', 'Before', 'After'])
    expect(chart.data.rows).toEqual([
      ['Jan', 120000, 80000],
      ['Feb', 118000, 76000],
      ['Mar', 115000, 70000],
    ])
    expect(deck.slides[1]!.notes).toContain('[1]')

    const illustrative = deck.slides[2]!.elements.find((e) => e.type === 'chart') as { options: { title?: string } }
    expect(illustrative.options.title).toBe('Trend (illustrative)')
    expect(deck.slides[2]!.notes).toContain('Illustrative chart')

    expect(deck.slides[3]!.elements.some((e) => e.type === 'diagram')).toBe(true)

    const sourcesSlide = deck.slides[5]!
    const text = JSON.stringify(sourcesSlide)
    expect(text).toContain('Sources')
    expect(text).toContain('bills.csv')
    expect(text).toContain(`${base}/page`)
  }, 120_000)

  it('cancel mid-run stops after the current slide and keeps what was written', async () => {
    const { user, deckId } = await setup('wizard-cancel')
    const provider = scriptedProvider([
      slideReply({ layout: 'title', title: 'One', bullets: [], notes: '' }),
      slideReply({ layout: 'title-content', title: 'Two', bullets: ['a'], notes: '' }),
      slideReply({ layout: 'title-content', title: 'Three', bullets: ['b'], notes: '' }),
    ])
    const runId = (await insertWizardRun(database, { userId: user.id, brief: WizardBrief.parse({ prompt: 'x', slideCount: 3 }) as unknown as Record<string, unknown> })).id
    let calls = 0
    const original = provider.generate.bind(provider)
    provider.generate = async (request) => {
      calls++
      if (calls === 2) await updateWizardRun(database, runId, { status: 'cancelled' })
      return original(request)
    }
    const fake = fakeCollab('Cancel test')
    const outline = Outline.parse({
      title: 'Cancel test',
      slides: [
        { title: 'One', layout: 'title', keyPoints: [], visual: 'none', sourceIds: [] },
        { title: 'Two', layout: 'title-content', keyPoints: ['a'], visual: 'none', sourceIds: [] },
        { title: 'Three', layout: 'title-content', keyPoints: ['b'], visual: 'none', sourceIds: [] },
      ],
    })
    await updateWizardRun(database, runId, { status: 'ready', outline: outline as unknown as Record<string, unknown>, total: 3, deckId })
    await runGenerate(envFor(provider, fake.collab), runId)
    const run = await getWizardRun(database, runId)
    expect(run!.status).toBe('cancelled')
    expect(calls).toBe(2)
    expect(yDocToDeck(fake.doc).slides.map((s) => s.elements.find((e) => e.type === 'text' && e.role === 'title'))).toHaveLength(2)
  }, 120_000)

  it('a slide the model cannot write becomes a placeholder with its outline points, and the run goes on', async () => {
    const { user, deckId } = await setup('wizard-placeholder')
    const provider = scriptedProvider([
      slideReply({ layout: 'title', title: 'Cover', bullets: [], notes: '' }),
      'not json',
      'still not json',
    ])
    const runId = (await insertWizardRun(database, { userId: user.id, brief: WizardBrief.parse({ prompt: 'x', slideCount: 3 }) as unknown as Record<string, unknown> })).id
    const fake = fakeCollab('Placeholder test')
    const outline = Outline.parse({
      title: 'Placeholder test',
      slides: [
        { title: 'Cover', layout: 'title', keyPoints: [], visual: 'none', sourceIds: [] },
        { title: 'Hard slide', layout: 'title-content', keyPoints: ['Point one', 'Point two'], visual: 'none', sourceIds: [] },
      ],
    })
    await updateWizardRun(database, runId, { status: 'ready', outline: outline as unknown as Record<string, unknown>, total: 2, deckId })
    await runGenerate(envFor(provider, fake.collab), runId)
    const run = await getWizardRun(database, runId)
    expect(run!.status).toBe('done')
    expect(run!.error).toContain('Slide 2 could not be written')
    const deck = yDocToDeck(fake.doc)
    expect(deck.slides).toHaveLength(2)
    expect(JSON.stringify(deck.slides[1])).toContain('Point one')
    // The visible note is on the slide too (not only in the speaker notes), and the run records the placeholder.
    expect(JSON.stringify(deck.slides[1])).toContain('Could not be generated')
    expect(deck.slides[1]!.notes).toContain('could not be written')
    expect(run!.failedSlides).toEqual([{ slideId: deck.slides[1]!.id, number: 2 }])
  }, 120_000)

  it('the figures on a slide come from the CSV: the FACTS reach the prompt, and an invented figure is corrected once', async () => {
    const { user, deckId } = await setup('wizard-numbers')
    const run = await insertWizardRun(database, { userId: user.id, brief: WizardBrief.parse({ prompt: 'x', slideCount: 3, language: 'en' }) as unknown as Record<string, unknown> })
    const fake = fakeCollab('Numbers')
    const env = envFor(scriptedProvider([]), fake.collab)
    const csvId = await ingestFile(run.id, 'bills.csv', csvBytes, env)
    const provider = scriptedProvider([
      slideReply({ layout: 'title', title: 'Cover', bullets: [], notes: '' }),
      slideReply({ layout: 'title-content', title: 'Bills', bullets: ['Average before Rp3.38 million'], notes: 'See [1].' }),
      slideReply({ layout: 'title-content', title: 'Bills', bullets: ['Average before: 117,667'], notes: 'See [1].' }),
    ])
    const outline = withKnownSources(
      Outline.parse({
        title: 'Numbers',
        slides: [
          { title: 'Cover', layout: 'title', keyPoints: [], visual: 'none', sourceIds: [] },
          { title: 'Bills', layout: 'title-content', keyPoints: ['Average before'], visual: 'none', sourceIds: [csvId] },
        ],
      }),
      new Set([csvId]),
    )
    await updateWizardRun(database, run.id, { status: 'ready', outline: outline as unknown as Record<string, unknown>, total: 2, deckId })
    await runGenerate(envFor(provider, fake.collab), run.id)
    // The slide prompt carries the computed average of the CSV's first column (120000, 118000, 115000).
    expect(provider.requests[1]!.messages[0]!.content).toContain('average 117,667')
    // The first reply stated an invented figure; the corrective request was made and its figure is kept.
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[2]!.messages[0]!.content).toContain('Correction:')
    const slide = yDocToDeck(fake.doc).slides[1]!
    expect(JSON.stringify(slide)).toContain('Average before: 117,667')
    expect(JSON.stringify(slide)).not.toContain('(estimate)')
    expect((await getWizardRun(database, run.id))!.failedSlides).toEqual([])
  }, 120_000)

  it('a retry writes a placeholder slide again in place, and a retry that fails again keeps the placeholder', async () => {
    const { user, deckId } = await setup('wizard-retry')
    const brief = WizardBrief.parse({ prompt: 'x', slideCount: 3, language: 'en' }) as unknown as Record<string, unknown>
    const runId = (await insertWizardRun(database, { userId: user.id, brief })).id
    const fake = fakeCollab('Retry test')
    const outline = Outline.parse({
      title: 'Retry test',
      slides: [
        { title: 'Cover', layout: 'title', keyPoints: [], visual: 'none', sourceIds: [] },
        { title: 'Hard slide', layout: 'title-content', keyPoints: ['Point one', 'Point two'], visual: 'none', sourceIds: [] },
        { title: 'Last slide', layout: 'title-content', keyPoints: ['Final'], visual: 'none', sourceIds: [] },
      ],
    })
    await updateWizardRun(database, runId, { status: 'ready', outline: outline as unknown as Record<string, unknown>, total: 3, deckId })
    await runGenerate(
      envFor(scriptedProvider([slideReply({ layout: 'title', title: 'Cover', bullets: [], notes: '' }), 'not json', 'still not json', slideReply({ layout: 'title-content', title: 'Last', bullets: ['Done'], notes: '' })]), fake.collab),
      runId,
    )
    const before = yDocToDeck(fake.doc)
    expect(before.slides).toHaveLength(3)
    const placeholderId = before.slides[1]!.id
    const failed = (await getWizardRun(database, runId))!.failedSlides
    expect(failed).toEqual([{ slideId: placeholderId, number: 2 }])

    // The web app sets the run to generating and queues the retry. The first retry fails again (invalid replies).
    await updateWizardRun(database, runId, { status: 'generating', progress: 0, total: 1, error: null })
    await runRetry(envFor(scriptedProvider(['not json', 'still not json']), fake.collab), runId)
    let run = await getWizardRun(database, runId)
    expect(run!.status).toBe('done')
    expect(run!.failedSlides).toEqual([{ slideId: placeholderId, number: 2 }])
    expect(yDocToDeck(fake.doc).slides[1]!.id).toBe(placeholderId)

    // The second retry writes the slide: same index, new content, no placeholder left.
    await updateWizardRun(database, runId, { status: 'generating', progress: 0, total: 1, error: null })
    const provider = scriptedProvider([slideReply({ layout: 'title-content', title: 'Second, written', bullets: ['Survei atap'], notes: 'Back.' })])
    await runRetry(envFor(provider, fake.collab), runId)
    run = await getWizardRun(database, runId)
    expect(run!.status).toBe('done')
    expect(run!.failedSlides).toEqual([])
    const after = yDocToDeck(fake.doc)
    expect(after.slides).toHaveLength(3)
    expect(after.slides[1]!.id).not.toBe(placeholderId)
    expect(after.slides[0]!.id).toBe(before.slides[0]!.id)
    expect(after.slides[2]!.id).toBe(before.slides[2]!.id)
    expect(JSON.stringify(after.slides[1])).toContain('Second, written')
    expect(JSON.stringify(after.slides[1])).not.toContain('Could not be generated')
    expect(provider.requests).toHaveLength(1)
  }, 120_000)

  it('research queues one ingest job per distinct page and records the page as a search source', async () => {
    const { user } = await setup('wizard-research')
    const provider = scriptedProvider([JSON.stringify({ queries: ['rooftop solar bakeries jakarta'] })])
    const search: SearchProvider = {
      kind: 'searxng',
      label: 'fake',
      search: async () => [
        { title: 'Local page', url: `${base}/page?utm_source=x`, snippet: '' },
        { title: 'Local page again', url: `${base}/page`, snippet: '' },
      ],
    }
    const queued: string[] = []
    const env = envFor(provider, fakeCollab('x').collab, { search, enqueueIngest: async (_run, source) => void queued.push(source) })
    const runId = (await insertWizardRun(database, { userId: user.id, brief: WizardBrief.parse({ prompt: 'rooftop solar', research: true }) as unknown as Record<string, unknown> })).id
    await runResearch(env, runId)
    const sources = await listWizardSources(database, runId)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.kind).toBe('search')
    expect(queued).toEqual([sources[0]!.id])
    await runIngest(env, sources[0]!.id)
    const ready = await getWizardSource(database, sources[0]!.id)
    expect(ready!.status).toBe('ready')
    expect(ready!.wordCount).toBeGreaterThan(3)
    const run = await getWizardRun(database, runId)
    expect(run!.status).toBe('draft')
  }, 60_000)

  it('a URL that is refused by the policy fails its source with the reason, and the run is not stopped', async () => {
    const { user } = await setup('wizard-refused')
    const runId = (await insertWizardRun(database, { userId: user.id, brief: WizardBrief.parse({ prompt: 'x' }) as unknown as Record<string, unknown> })).id
    const row = await insertWizardSource(database, {
      runId, kind: 'url', title: 'private', url: 'http://127.0.0.1:9/x', fileName: null, mime: null, fileKey: null, bytes: null,
      status: 'queued', wordCount: 0, extracted: null, error: null, position: 0,
    })
    // No test policy here: the production fetch refuses loopback.
    await runIngest({ ...envFor(scriptedProvider([]), fakeCollab('x').collab), fetchUrl: undefined }, row.id)
    const after = await getWizardSource(database, row.id)
    expect(after!.status).toBe('failed')
    expect(after!.error).toMatch(/could not be fetched|blocked|resolve|not allowed/i)
  }, 60_000)
  it('a run whose worker stopped (no heartbeat for five minutes) is failed on startup; fresh and finished runs are left alone', async () => {
    const { user } = await setup('wizard-recover')
    const brief = WizardBrief.parse({ prompt: 'x' }) as unknown as Record<string, unknown>
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)
    const stale = await insertWizardRun(database, { userId: user.id, brief })
    await updateWizardRun(database, stale.id, { status: 'generating', heartbeatAt: minutesAgo(10) })
    const fresh = await insertWizardRun(database, { userId: user.id, brief })
    await updateWizardRun(database, fresh.id, { status: 'generating', heartbeatAt: new Date() })
    const finished = await insertWizardRun(database, { userId: user.id, brief })
    await updateWizardRun(database, finished.id, { status: 'done', heartbeatAt: minutesAgo(60) })
    // No heartbeat yet (the run was ingesting when the worker stopped): its last update is the clock.
    const noBeat = await insertWizardRun(database, { userId: user.id, brief })
    await updateWizardRun(database, noBeat.id, { status: 'ingesting' })

    // A minute on, only the run with a ten-minute-old heartbeat is stale.
    const first = await recoverStaleRuns({ db: database, logger: silent }, new Date(Date.now() + 60_000))
    expect(first).toContain(stale.id)
    expect(first).not.toContain(fresh.id)
    expect(first).not.toContain(finished.id)
    const failed = await getWizardRun(database, stale.id)
    expect(failed!.status).toBe('failed')
    expect(failed!.error).toBe(STALE_RUN_MESSAGE)
    expect((await getWizardRun(database, fresh.id))!.status).toBe('generating')
    expect((await getWizardRun(database, finished.id))!.status).toBe('done')

    // Six minutes on, the fresh run has gone quiet too, and the run with no heartbeat is stale.
    const second = await recoverStaleRuns({ db: database, logger: silent }, new Date(Date.now() + 6 * 60_000))
    expect(second).toEqual(expect.arrayContaining([fresh.id, noBeat.id]))
    expect((await getWizardRun(database, noBeat.id))!.status).toBe('failed')
    expect((await getWizardRun(database, finished.id))!.status).toBe('done')
  }, 60_000)

  it('a late generate job for a run that already failed writes nothing', async () => {
    const { user, deckId } = await setup('wizard-late')
    const brief = WizardBrief.parse({ prompt: 'x', slideCount: 3 })
    const run = await insertWizardRun(database, { userId: user.id, brief: brief as unknown as Record<string, unknown> })
    const outline = Outline.parse({ title: 'Late', slides: [{ title: 'One', layout: 'title-content', keyPoints: ['a'], visual: 'none', sourceIds: [] }] })
    await updateWizardRun(database, run.id, { status: 'failed', deckId, outline: outline as unknown as Record<string, unknown> })
    const fake = fakeCollab('Late')
    const provider = scriptedProvider([slideReply({ layout: 'title', title: 'x', bullets: [], notes: '' })])
    await runGenerate(envFor(provider, fake.collab), run.id)
    expect(provider.requests).toHaveLength(0)
    expect((await getWizardRun(database, run.id))!.status).toBe('failed')
    expect(yDocToDeck(fake.doc).slides.map((s) => s.id)).toEqual(fake.initialSlideIds)
  }, 60_000)
})

// M9: a run that starts from a template, and a run that applies a brand kit (theme, logo copy, colour constraint).
describe.skipIf(!db)('wizard jobs with a template or a brand kit (real Postgres)', () => {
  const database = db!
  let uploadsDir = ''
  let uploads: StorageDriver
  const users: string[] = []
  const PNG_1X1 = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  const KIT_PALETTE = {
    background: '#ffffff',
    surface: '#f0f4ff',
    text: '#102030',
    muted: '#556677',
    accent: '#0055cc',
    accent2: '#00aa66',
    accent3: '#dd7700',
    accent4: '#8844aa',
  }

  beforeAll(() => {
    uploadsDir = mkdtempSync(join(tmpdir(), 'sleid-wizard-kit-test-'))
    uploads = createLocalStorage(uploadsDir)
  })

  afterAll(async () => {
    await removeUsers(database, users)
    rmSync(uploadsDir, { recursive: true, force: true })
  })

  async function setup(label: string) {
    const user = await makeUser(database, label)
    users.push(user.id)
    const deckId = await makeDeck(database, user.id, 'Template test')
    return { user, deckId }
  }

  function envFor(provider: ReturnType<typeof scriptedProvider>, collab: WizardCollab): WizardEnv {
    return {
      db: database,
      uploads,
      collab,
      search: null,
      enqueueIngest: async () => {},
      resolveProvider: async () => ({ provider, compact: false, secrets: [], providerId: null }),
      logger: silent,
    }
  }

  function twoSlideOutline(title: string) {
    return Outline.parse({
      title,
      slides: [
        { title: 'Cover', layout: 'title', keyPoints: [], visual: 'none', sourceIds: [] },
        { title: 'Point', layout: 'title-content', keyPoints: ['One'], visual: 'none', sourceIds: [] },
      ],
    })
  }

  it('a template run takes the template theme and writes the outline slides', async () => {
    const { user, deckId } = await setup('wizard-template-run')
    const brief = WizardBrief.parse({ prompt: 'Pitch', slideCount: 3, templateId: 'builtin:pitch', theme: 'Sheets Light' })
    const run = await insertWizardRun(database, { userId: user.id, brief: brief as unknown as Record<string, unknown> })
    const fake = fakeCollab('Template run')
    const provider = scriptedProvider([
      slideReply({ layout: 'title', title: 'Cover', bullets: [], notes: '' }),
      slideReply({ layout: 'title-content', title: 'Point', bullets: ['One'], notes: '' }),
    ])
    await updateWizardRun(database, run.id, { status: 'ready', outline: twoSlideOutline('Template run') as unknown as Record<string, unknown>, total: 2, deckId })
    await runGenerate(envFor(provider, fake.collab), run.id)
    expect((await getWizardRun(database, run.id))!.status).toBe('done')
    const deck = yDocToDeck(fake.doc)
    expect(deck.theme).toEqual(builtInTemplateDeck('builtin:pitch')!.theme)
    expect(deck.theme.name).not.toBe('Sheets Light')
    expect(deck.brand).toBeUndefined()
    expect(deck.slides).toHaveLength(2)
  }, 120_000)

  it('a brand kit run applies the kit before the first slide, copies its logo, and keeps every colour in the palette', async () => {
    const { user, deckId } = await setup('wizard-kit-run')
    const kitId = randomUUID()
    await insertBrandKitRow(database, {
      id: kitId,
      ownerId: user.id,
      name: 'Kit Co',
      visibility: 'private',
      tokens: { palette: KIT_PALETTE, fonts: { heading: 'Georgia, serif', body: 'Helvetica, sans-serif' } },
      logoPlacement: { corner: 'tr', widthPct: 12, margin: 48, slides: 'all-but-title' },
      defaultTemplateId: null,
    })
    const logoKey = `brand-logos/${kitId}-test.png`
    await uploads.put(logoKey, PNG_1X1)
    await setBrandKitLogo(database, user.id, kitId, { key: logoKey, mime: 'image/png', bytes: PNG_1X1.byteLength, sha256: createHash('sha256').update(PNG_1X1).digest('hex') })

    const brief = WizardBrief.parse({ prompt: 'Kit deck', slideCount: 3, brandKitId: kitId })
    const run = await insertWizardRun(database, { userId: user.id, brief: brief as unknown as Record<string, unknown> })
    const fake = fakeCollab('Kit run')
    const provider = scriptedProvider([
      slideReply({ layout: 'title', title: 'Cover', bullets: [], notes: '' }),
      slideReply({ layout: 'title-content', title: 'Point', bullets: ['One'], notes: '' }),
    ])
    await updateWizardRun(database, run.id, { status: 'ready', outline: twoSlideOutline('Kit run') as unknown as Record<string, unknown>, total: 2, deckId })
    await runGenerate(envFor(provider, fake.collab), run.id)
    expect((await getWizardRun(database, run.id))!.status).toBe('done')

    const deck = yDocToDeck(fake.doc)
    expect(deck.brand?.brandKitId).toBe(kitId)
    expect(deck.theme.colors).toEqual(KIT_PALETTE)
    expect(deck.theme.name).toBe('Kit Co')
    // The first slide was written against the kit: the brand reference was on the deck before the first slide landed.
    expect(provider.requests).toHaveLength(2)
    expect(deck.slides).toHaveLength(2)

    // The logo is a copy in the deck's own assets, and the file is in storage under the new id.
    const src = deck.brand?.logo?.src ?? ''
    const match = /^\/api\/assets\/([0-9a-f-]{36})$/.exec(src)
    expect(match).not.toBeNull()
    const assetId = match![1]!
    const row = (await database.select().from(assets)).find((a) => a.id === assetId)
    expect(row?.deckId).toBe(deckId)
    expect(row?.mime).toBe('image/png')
    expect(Buffer.from((await uploads.get(assetId))!).equals(Buffer.from(PNG_1X1))).toBe(true)

    // Every colour in the written deck is one of the kit's palette colours.
    const palette = new Set(Object.values(KIT_PALETTE).map((c) => c.toLowerCase()))
    const colours = JSON.stringify(deck).match(/#[0-9a-fA-F]{6}\b/g) ?? []
    expect(colours.length).toBeGreaterThan(0)
    for (const c of colours) expect(palette.has(c.toLowerCase())).toBe(true)
  }, 120_000)

  it('a run whose kit is no longer readable fails with a message and writes nothing', async () => {
    const { user, deckId } = await setup('wizard-kit-gone')
    const brief = WizardBrief.parse({ prompt: 'x', slideCount: 3, brandKitId: randomUUID() })
    const run = await insertWizardRun(database, { userId: user.id, brief: brief as unknown as Record<string, unknown> })
    const fake = fakeCollab('Kit gone')
    const provider = scriptedProvider([])
    await updateWizardRun(database, run.id, { status: 'ready', outline: twoSlideOutline('Kit gone') as unknown as Record<string, unknown>, total: 2, deckId })
    await runGenerate(envFor(provider, fake.collab), run.id)
    const after = await getWizardRun(database, run.id)
    expect(after!.status).toBe('failed')
    expect(after!.error).toContain('brand kit')
    expect(provider.requests).toHaveLength(0)
    expect(yDocToDeck(fake.doc).slides.map((s) => s.id)).toEqual(fake.initialSlideIds)
  }, 60_000)
})

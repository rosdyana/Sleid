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
import { applyOps, createDeck, deckToYDoc, yDocToDeck, type Deck, type Op } from '@sleid/model'
import { getWizardRun, insertWizardRun, insertWizardSource, listWizardSources, updateWizardRun, getWizardSource, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import { fetchPublicUrl } from '@sleid/ingest'
import { Outline, WizardBrief, withKnownSources } from '@sleid/llm'
import { scriptedProvider } from '@sleid/llm/testing'
import type { SearchProvider } from '@sleid/research'
import { runGenerate, runIngest, runResearch, type WizardEnv } from './jobs.ts'
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
    expect(deck.slides[1]!.notes).toContain('could not be written')
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
})

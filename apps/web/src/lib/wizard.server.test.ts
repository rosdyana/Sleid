// Wizard service rules against real Postgres: ownership, upload and URL limits, outline validation, generate precondition.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { getWizardRunFor, updateWizardRun, listWizardSources, type Db } from '@sleid/db'
import { createLocalStorage } from '@sleid/storage'
import { LIMITS } from '@sleid/ingest'
import * as wizard from './wizard.server'

const db: Db | null = await connectOrNull()
const enc = (s: string) => new TextEncoder().encode(s)

describe.skipIf(!db)('wizard service', () => {
  const database = db!
  const users: string[] = []
  const jobs: Array<{ kind: string; payload: unknown }> = []
  let dir = ''
  let deps: wizard.WizardDeps

  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    dir = mkdtempSync(join(tmpdir(), 'sleid-wizard-web-'))
    deps = {
      db: database,
      uploads: createLocalStorage(dir),
      queue: {
        enqueueWizard: async (kind, payload) => {
          jobs.push({ kind, payload })
          return 'job'
        },
      },
      env: {},
      resolveProvider: async () => {
        throw new Error('no provider in this test')
      },
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }
  })

  afterAll(async () => {
    await removeUsers(database, users)
  })

  async function owner(label: string) {
    const u = await makeUser(database, label)
    users.push(u.id)
    return { id: u.id }
  }

  it('creates a run for its owner only; another user gets not-found', async () => {
    const a = await owner('wiz-owner')
    const b = await owner('wiz-other')
    const run = await wizard.createRun(deps, a, { prompt: 'Solar deck' })
    await expect(wizard.getRun(deps, b, run.id)).rejects.toMatchObject({ status: 404 })
    await expect(wizard.addUrl(deps, b, run.id, 'https://example.com/')).rejects.toMatchObject({ status: 404 })
    await expect(wizard.cancelRun(deps, b, run.id)).rejects.toMatchObject({ status: 404 })
  })

  it('refuses research when no search provider is configured', async () => {
    const a = await owner('wiz-research-off')
    await expect(wizard.createRun(deps, a, { prompt: 'x', research: true })).rejects.toThrow(/Research is not set up/)
  })

  it('refuses an unsupported or mismatched file, an empty one, and one over the size cap', async () => {
    const a = await owner('wiz-files')
    const run = await wizard.createRun(deps, a, { prompt: 'x' })
    await expect(wizard.addFile(deps, a, run.id, { fileName: 'run.exe', bytes: enc('MZ') })).rejects.toMatchObject({ status: 415 })
    await expect(wizard.addFile(deps, a, run.id, { fileName: 'fake.pdf', bytes: enc('plain text') })).rejects.toMatchObject({ status: 415 })
    await expect(wizard.addFile(deps, a, run.id, { fileName: 'empty.txt', bytes: new Uint8Array() })).rejects.toMatchObject({ status: 400 })
    await expect(wizard.addFile(deps, a, run.id, { fileName: 'big.txt', bytes: new Uint8Array(LIMITS.maxFileBytes + 1) })).rejects.toMatchObject({ status: 413 })
  })

  it('accepts a CSV, stores it under a run-scoped key and queues its ingest job', async () => {
    const a = await owner('wiz-csv')
    const run = await wizard.createRun(deps, a, { prompt: 'x' })
    const source = await wizard.addFile(deps, a, run.id, { fileName: 'bills.csv', bytes: enc('Month,Before\nJan,1\n') })
    expect(source.status).toBe('queued')
    const rows = await listWizardSources(database, run.id)
    expect(rows[0]!.fileKey).toBe(`wizard/${run.id}/${rows[0]!.id}`)
    expect(await deps.uploads.get(rows[0]!.fileKey!)).not.toBeNull()
    expect(jobs.at(-1)).toEqual({ kind: 'ingest', payload: { runId: run.id, sourceId: rows[0]!.id } })
  })

  it('refuses a URL to a private or loopback address before queuing anything', async () => {
    const a = await owner('wiz-url')
    const run = await wizard.createRun(deps, a, { prompt: 'x' })
    const before = jobs.length
    await expect(wizard.addUrl(deps, a, run.id, 'http://127.0.0.1:3002/internal')).rejects.toMatchObject({ status: 400 })
    await expect(wizard.addUrl(deps, a, run.id, 'http://169.254.169.254/latest')).rejects.toMatchObject({ status: 400 })
    await expect(wizard.addUrl(deps, a, run.id, 'ftp://example.com/x')).rejects.toMatchObject({ status: 400 })
    expect(jobs.length).toBe(before)
  })

  it('caps URLs at 10 and rejects a duplicate', async () => {
    const a = await owner('wiz-url-cap')
    const run = await wizard.createRun(deps, a, { prompt: 'x' })
    await wizard.addUrl(deps, a, run.id, 'https://example.com/')
    await expect(wizard.addUrl(deps, a, run.id, 'https://example.com/')).rejects.toMatchObject({ status: 409 })
    for (let i = 1; i < LIMITS.maxUrls; i++) await wizard.addUrl(deps, a, run.id, `https://example.com/${i}`)
    await expect(wizard.addUrl(deps, a, run.id, 'https://example.com/extra')).rejects.toMatchObject({ status: 409 })
  })

  it('saves a valid outline, drops unknown source ids, and refuses a malformed one', async () => {
    const a = await owner('wiz-outline')
    const run = await wizard.createRun(deps, a, { prompt: 'x' })
    await updateWizardRun(database, run.id, { status: 'ready' })
    const outline = { title: 'Deck', slides: [{ title: 'One', layout: 'title', keyPoints: [], visual: 'none', sourceIds: ['not-a-real-id'] }] }
    const saved = await wizard.saveOutline(deps, a, run.id, outline)
    expect(saved.outline!.slides[0]!.sourceIds).toEqual([])
    await expect(wizard.saveOutline(deps, a, run.id, { title: '', slides: [] })).rejects.toThrow()
  })

  it('generation needs a drafted outline, and makes a deck once', async () => {
    const a = await owner('wiz-generate')
    const run = await wizard.createRun(deps, a, { prompt: 'x' })
    await expect(wizard.startGeneration(deps, a, run.id)).rejects.toMatchObject({ status: 409 })
    await updateWizardRun(database, run.id, { status: 'ready', outline: { title: 'Deck', slides: [{ title: 'One', layout: 'title', keyPoints: [], visual: 'none', sourceIds: [] }] } })
    const started = await wizard.startGeneration(deps, a, run.id)
    expect(started.deckId).toMatch(/^[0-9a-f-]{36}$/)
    const row = await getWizardRunFor(database, a.id, run.id)
    expect(row!.status).toBe('generating')
    expect(row!.deckId).toBe(started.deckId)
    expect(jobs.at(-1)).toEqual({ kind: 'generate', payload: { runId: run.id } })
    await expect(wizard.startGeneration(deps, a, run.id)).rejects.toMatchObject({ status: 409 })
  })

  it('writes the placeholder slides again only for a done run that has placeholders, and queues a retry job', async () => {
    const a = await owner('wiz-retry')
    const b = await owner('wiz-retry-other')
    const run = await wizard.createRun(deps, a, { prompt: 'x', slideCount: 3 })
    const deckId = await makeDeck(database, a.id, 'Retry deck')
    // Not done yet: refused.
    await expect(wizard.retryFailedSlides(deps, a, run.id)).rejects.toMatchObject({ status: 409 })
    await updateWizardRun(database, run.id, { status: 'done', deckId, failedSlides: [] })
    // Done with no placeholders: nothing to retry.
    await expect(wizard.retryFailedSlides(deps, a, run.id)).rejects.toThrow(/No slide needs/)
    await updateWizardRun(database, run.id, { status: 'done', deckId, failedSlides: [{ slideId: '11111111-1111-4111-8111-111111111111', number: 2 }] })
    // Another user gets not-found.
    await expect(wizard.retryFailedSlides(deps, b, run.id)).rejects.toMatchObject({ status: 404 })
    const before = jobs.length
    const view = await wizard.retryFailedSlides(deps, a, run.id)
    expect(view.status).toBe('generating')
    expect(view.failedSlides).toEqual([2])
    expect(view.total).toBe(1)
    expect(jobs.length).toBe(before + 1)
    expect(jobs.at(-1)).toEqual({ kind: 'generate', payload: { runId: run.id, retry: true } })
    // A second click while it runs is refused, and no second job is queued.
    await expect(wizard.retryFailedSlides(deps, a, run.id)).rejects.toMatchObject({ status: 409 })
    expect(jobs.length).toBe(before + 1)
  })

  it('cancel moves an active run to cancelled', async () => {
    const a = await owner('wiz-cancel')
    const run = await wizard.createRun(deps, a, { prompt: 'x' })
    const cancelled = await wizard.cancelRun(deps, a, run.id)
    expect(cancelled.status).toBe('cancelled')
  })
})

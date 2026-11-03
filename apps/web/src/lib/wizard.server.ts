// The prompt-to-deck wizard, as plain functions over the database, the storage driver and the job queue, so the
// tests can call them. Server functions (wizard.functions.ts) and the upload route are thin wrappers.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { LlmError, assertAllowedEndpoint, draftOutline, withKnownSources, Outline, WizardBrief, type WizardBrief as Brief, type Outline as OutlineT } from '@sleid/llm'
import { decks, deckMembers, getWizardRunFor, insertWizardRun, insertWizardSource, listWizardSources, recordLlmUsage, updateWizardRun, updateWizardSource, wizardRuns, wizardSources, type Db, type WizardRunRow, type WizardSourceRow } from '@sleid/db'
import { detectFileKind, IngestError, LIMITS, baseName, testPrivateWizardUrls, type IngestedSource } from '@sleid/ingest'
import { researchFromEnv } from '@sleid/research'
import type { StorageDriver } from '@sleid/storage'
import type { ResolvedProvider } from './llm-settings.server'

export interface WizardQueue {
  enqueueWizard(kind: 'research' | 'ingest' | 'generate', payload: { runId: string; sourceId?: string; retry?: boolean }): Promise<string | null>
}

export interface WizardDeps {
  db: Db
  uploads: StorageDriver
  queue: WizardQueue
  env: NodeJS.ProcessEnv
  /** The provider for a run (the user's choice, or the defaults). Same resolution as the assistant. */
  resolveProvider: (userId: string, providerId: string | null) => Promise<ResolvedProvider>
  /** Test-only: DNS lookup for the early URL check. */
  lookup?: Parameters<typeof assertAllowedEndpoint>[2]
}

export interface WizardUser {
  id: string
}

export const MAX_FILES = LIMITS.maxFiles
export const MAX_URLS = LIMITS.maxUrls

export class WizardError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'WizardError'
    this.status = status
  }
}

export const RunIdSchema = z.uuid()

async function ownedRun(deps: WizardDeps, user: WizardUser, runId: string): Promise<WizardRunRow> {
  const run = await getWizardRunFor(deps.db, user.id, runId)
  if (!run) throw new WizardError('That run was not found.', 404)
  return run
}

export interface RunView {
  id: string
  status: WizardRunRow['status']
  progress: number
  total: number
  error: string | null
  deckId: string | null
  brief: Brief
  outline: OutlineT | null
  /** Slide numbers (1-based) that are placeholders: the model could not write them. */
  failedSlides: number[]
  sources: SourceView[]
  researchAvailable: boolean
  researchLabel: string
}

export interface SourceView {
  id: string
  kind: WizardSourceRow['kind']
  title: string
  url: string | null
  fileName: string | null
  status: WizardSourceRow['status']
  wordCount: number
  error: string | null
  tables: number
  images: number
}

function sourceView(row: WizardSourceRow): SourceView {
  const extracted = row.extracted as Partial<IngestedSource> | null
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    fileName: row.fileName,
    status: row.status,
    wordCount: row.wordCount,
    error: row.error,
    tables: extracted?.tables?.length ?? 0,
    images: extracted?.images?.length ?? 0,
  }
}

function researchState(env: NodeJS.ProcessEnv): { available: boolean; label: string } {
  try {
    const config = researchFromEnv(env)
    return config ? { available: true, label: config.label } : { available: false, label: 'not configured' }
  } catch (err) {
    return { available: false, label: `misconfigured: ${err instanceof Error ? err.message : 'invalid setting'}` }
  }
}

export async function createRun(deps: WizardDeps, user: WizardUser, rawBrief: unknown, providerId?: string | null): Promise<RunView> {
  const brief = WizardBrief.parse(rawBrief)
  if (brief.research && !researchState(deps.env).available) {
    throw new WizardError('Research is not set up on this server. Set SEARXNG_URL, BRAVE_API_KEY or TAVILY_API_KEY (see the README).')
  }
  const row = await insertWizardRun(deps.db, { userId: user.id, brief: brief as unknown as Record<string, unknown>, providerId: providerId ?? null })
  return runView(deps, row)
}

export async function getRun(deps: WizardDeps, user: WizardUser, runId: string): Promise<RunView> {
  return runView(deps, await ownedRun(deps, user, runId))
}

async function runView(deps: WizardDeps, row: WizardRunRow): Promise<RunView> {
  const sources = await listWizardSources(deps.db, row.id)
  const research = researchState(deps.env)
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    total: row.total,
    error: row.error,
    deckId: row.deckId,
    brief: WizardBrief.parse(row.brief),
    outline: row.outline ? Outline.parse(row.outline) : null,
    failedSlides: row.failedSlides.map((f) => f.number).sort((a, b) => a - b),
    sources: sources.map(sourceView),
    researchAvailable: research.available,
    researchLabel: research.label,
  }
}

/** Reads the upload, checks its type and size against the limits, stores the bytes and queues the extraction. */
export async function addFile(deps: WizardDeps, user: WizardUser, runId: string, file: { fileName: string; bytes: Uint8Array }): Promise<SourceView> {
  const run = await ownedRun(deps, user, runId)
  if (run.status !== 'draft') throw new WizardError('References can only be added before the outline is drafted.', 409)
  const fileName = baseName(file.fileName)
  if (!fileName) throw new WizardError('The file needs a name.')
  if (file.bytes.byteLength === 0) throw new WizardError(`"${fileName}" is empty.`)
  if (file.bytes.byteLength > LIMITS.maxFileBytes) throw new WizardError(`"${fileName}" is larger than ${LIMITS.maxFileBytes / (1024 * 1024)} MB.`, 413)
  let kind: ReturnType<typeof detectFileKind>
  try {
    kind = detectFileKind(fileName, file.bytes)
  } catch (err) {
    throw new WizardError(err instanceof Error ? err.message : 'The file type is not supported.', 415)
  }
  const existing = await listWizardSources(deps.db, runId)
  const files = existing.filter((s) => s.kind === 'file')
  if (files.length >= MAX_FILES) throw new WizardError(`A run takes at most ${MAX_FILES} files.`, 409)
  const total = files.reduce((sum, s) => sum + (s.bytes ?? 0), 0) + file.bytes.byteLength
  if (total > LIMITS.maxTotalBytes) throw new WizardError(`The files together are larger than ${LIMITS.maxTotalBytes / (1024 * 1024)} MB.`, 413)

  const row = await insertWizardSource(deps.db, {
    runId,
    kind: 'file',
    title: fileName,
    url: null,
    fileName,
    mime: null,
    fileKey: null,
    bytes: file.bytes.byteLength,
    status: 'queued',
    wordCount: 0,
    extracted: null,
    error: null,
    position: existing.length,
  })
  const fileKey = `wizard/${runId}/${row.id}`
  await deps.uploads.put(fileKey, file.bytes)
  await updateWizardSource(deps.db, row.id, { fileKey, mime: kindMime(kind) })
  await deps.queue.enqueueWizard('ingest', { runId, sourceId: row.id })
  return sourceView({ ...row, fileKey })
}

function kindMime(kind: string): string {
  return kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/*' : 'application/octet-stream'
}

/** A URL reference. The pre-check gives a fast answer; the worker enforces the same policy on every hop. */
export async function addUrl(deps: WizardDeps, user: WizardUser, runId: string, rawUrl: string): Promise<SourceView> {
  const run = await ownedRun(deps, user, runId)
  if (run.status !== 'draft') throw new WizardError('References can only be added before the outline is drafted.', 409)
  const url = rawUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new WizardError('That is not a valid web address.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new WizardError('Use an http:// or https:// address.')
  try {
    await assertAllowedEndpoint(parsed.href, { allowPrivate: testPrivateWizardUrls(deps.env) }, deps.lookup)
  } catch (err) {
    throw new WizardError(err instanceof Error ? err.message : 'That address is not allowed.')
  }
  const existing = await listWizardSources(deps.db, runId)
  if (existing.filter((s) => s.kind === 'url').length >= MAX_URLS) throw new WizardError(`A run takes at most ${MAX_URLS} addresses.`, 409)
  if (existing.some((s) => s.url === parsed.href)) throw new WizardError('That address is already in the references.', 409)
  const row = await insertWizardSource(deps.db, {
    runId,
    kind: 'url',
    title: parsed.hostname,
    url: parsed.href,
    fileName: null,
    mime: null,
    fileKey: null,
    bytes: null,
    status: 'queued',
    wordCount: 0,
    extracted: null,
    error: null,
    position: existing.length,
  })
  await deps.queue.enqueueWizard('ingest', { runId, sourceId: row.id })
  return sourceView(row)
}

export async function removeSource(deps: WizardDeps, user: WizardUser, runId: string, sourceId: string): Promise<void> {
  const run = await ownedRun(deps, user, runId)
  if (run.status !== 'draft') throw new WizardError('References can only be removed before the outline is drafted.', 409)
  const [row] = await deps.db.select().from(wizardSources).where(and(eq(wizardSources.id, sourceId), eq(wizardSources.runId, runId))).limit(1)
  if (!row) throw new WizardError('That reference was not found.', 404)
  if (row.fileKey) await deps.uploads.delete(row.fileKey)
  await deps.db.delete(wizardSources).where(eq(wizardSources.id, sourceId))
}

export async function startResearch(deps: WizardDeps, user: WizardUser, runId: string): Promise<RunView> {
  const run = await ownedRun(deps, user, runId)
  if (run.status !== 'draft') throw new WizardError('Research runs before the outline is drafted.', 409)
  if (!researchState(deps.env).available) throw new WizardError('Research is not set up on this server.')
  await updateWizardRun(deps.db, runId, { status: 'ingesting', error: null })
  await deps.queue.enqueueWizard('research', { runId })
  return getRun(deps, user, runId)
}

/** True when no reference is still queued or being read. */
export function referencesSettled(sources: WizardSourceRow[]): boolean {
  return sources.every((s) => s.status === 'ready' || s.status === 'failed')
}

/** The model's view of each ready reference: title, origin and the start of its text (or the table columns). */
function referenceSummaries(sources: WizardSourceRow[]) {
  return sources
    .filter((s) => s.status === 'ready')
    .slice(0, 12)
    .map((s) => {
      const e = s.extracted as Partial<IngestedSource> | null
      const tableLine = (e?.tables ?? []).slice(0, 2).map((t) => `Table "${t.name}": ${t.columns.join(', ')} (${t.rows.length} rows)`)
      const text = (e?.text ?? '').slice(0, 1200)
      return { id: s.id, title: s.title, origin: s.url ?? s.fileName ?? 'web search', summary: [text, ...tableLine].filter(Boolean).join('\n') }
    })
}

export async function draftWizardOutline(deps: WizardDeps, user: WizardUser, runId: string): Promise<RunView> {
  const run = await ownedRun(deps, user, runId)
  if (run.status !== 'draft' && run.status !== 'ready') throw new WizardError('The outline can be drafted now only before generation.', 409)
  const sources = await listWizardSources(deps.db, runId)
  if (!referencesSettled(sources)) throw new WizardError('Some references are still being read. Wait for them to finish, then draft the outline.', 409)
  const brief = WizardBrief.parse(run.brief)
  await updateWizardRun(deps.db, runId, { status: 'outlining', error: null })
  try {
    const resolved = await deps.resolveProvider(user.id, run.providerId)
    const references = referenceSummaries(sources)
    const result = await draftOutline({ provider: resolved.provider, compact: resolved.compact }, { brief, references })
    const outline = withKnownSources(result.outline, new Set(references.map((r) => r.id)))
    await recordLlmUsage(deps.db, {
      userId: user.id,
      deckId: null,
      providerId: resolved.info.id === 'env' ? null : resolved.info.id,
      ability: 'wizardOutline',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      latencyMs: 0,
      ok: true,
    })
    await updateWizardRun(deps.db, runId, {
      status: 'ready',
      outline: outline as unknown as Record<string, unknown>,
      total: outline.slides.length + (brief.includeSources ? 1 : 0),
      error: result.warnings.length ? result.warnings.join(' ') : null,
    })
  } catch (err) {
    const message = err instanceof LlmError || err instanceof Error ? err.message : 'The outline could not be drafted.'
    await updateWizardRun(deps.db, runId, { status: 'draft', error: message })
    throw new WizardError(message, 502)
  }
  return getRun(deps, user, runId)
}

/** The user's edits. The whole outline is validated, and references that no longer exist are dropped. */
export async function saveOutline(deps: WizardDeps, user: WizardUser, runId: string, rawOutline: unknown): Promise<RunView> {
  const run = await ownedRun(deps, user, runId)
  if (run.status !== 'ready') throw new WizardError('There is no outline to edit yet.', 409)
  const parsed = Outline.parse(rawOutline)
  const known = new Set((await listWizardSources(deps.db, runId)).map((s) => s.id))
  const outline = withKnownSources(parsed, known)
  const brief = WizardBrief.parse(run.brief)
  await updateWizardRun(deps.db, runId, { outline: outline as unknown as Record<string, unknown>, total: outline.slides.length + (brief.includeSources ? 1 : 0) })
  return getRun(deps, user, runId)
}

/**
 * Creates the deck and queues generation. The deck is created empty; the collab service fills its first document,
 * and the worker writes the slides into it live.
 */
export async function startGeneration(deps: WizardDeps, user: WizardUser, runId: string): Promise<{ deckId: string; runId: string }> {
  const run = await ownedRun(deps, user, runId)
  if (run.status !== 'ready' || !run.outline) throw new WizardError('Draft the outline before generating the deck.', 409)
  if (run.deckId) throw new WizardError('This run already made a deck.', 409)
  const outline = Outline.parse(run.outline)
  const deckId = await deps.db.transaction(async (tx) => {
    const [deck] = await tx.insert(decks).values({ ownerId: user.id, title: outline.title.slice(0, 200) }).returning({ id: decks.id })
    if (!deck) throw new WizardError('The deck could not be created.', 500)
    await tx.insert(deckMembers).values({ deckId: deck.id, userId: user.id, role: 'owner', via: 'owner' })
    return deck.id
  })
  const moved = await deps.db
    .update(wizardRuns)
    .set({ deckId, status: 'generating', progress: 0, error: null, updatedAt: new Date() })
    .where(and(eq(wizardRuns.id, runId), eq(wizardRuns.status, 'ready')))
    .returning({ id: wizardRuns.id })
  if (moved.length === 0) throw new WizardError('The run changed while the deck was made. Try again.', 409)
  await deps.queue.enqueueWizard('generate', { runId })
  return { deckId, runId }
}

/**
 * Writes the placeholder slides again. Only for a finished run that has placeholders: the run goes back to generating,
 * the worker replaces each placeholder in place, and the run ends done again.
 */
export async function retryFailedSlides(deps: WizardDeps, user: WizardUser, runId: string): Promise<RunView> {
  const run = await ownedRun(deps, user, runId)
  if (run.status !== 'done' || !run.deckId) throw new WizardError('Slides can be written again once the deck is done.', 409)
  if (run.failedSlides.length === 0) throw new WizardError('No slide needs to be written again.', 409)
  const moved = await deps.db
    .update(wizardRuns)
    .set({ status: 'generating', progress: 0, total: run.failedSlides.length, error: null, heartbeatAt: new Date(), updatedAt: new Date() })
    .where(and(eq(wizardRuns.id, runId), eq(wizardRuns.status, 'done')))
    .returning({ id: wizardRuns.id })
  if (moved.length === 0) throw new WizardError('The run changed while the retry was queued. Try again.', 409)
  await deps.queue.enqueueWizard('generate', { runId, retry: true })
  return getRun(deps, user, runId)
}

export async function cancelRun(deps: WizardDeps, user: WizardUser, runId: string): Promise<RunView> {
  await ownedRun(deps, user, runId)
  await deps.db
    .update(wizardRuns)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(wizardRuns.id, runId), inArray(wizardRuns.status, ['draft', 'ingesting', 'outlining', 'ready', 'generating'])))
  return getRun(deps, user, runId)
}

/** The run that made a deck, for the editor banner and the Sources panel. Null for decks made by hand. */
export async function getRunForDeck(deps: WizardDeps, user: WizardUser, deckId: string): Promise<RunView | null> {
  const [row] = await deps.db
    .select()
    .from(wizardRuns)
    .where(and(eq(wizardRuns.deckId, deckId), eq(wizardRuns.userId, user.id)))
    .orderBy(sql`${wizardRuns.createdAt} desc`)
    .limit(1)
  return row ? runView(deps, row) : null
}

/**
 * The MCP and scripting entry point: makes a run from a prompt, adds URLs, optionally researches, waits for the
 * references (up to `waitMs`), drafts the outline and starts generation. Returns the ids at once when the wait ends.
 */
export async function createDeckFromPrompt(
  deps: WizardDeps,
  user: WizardUser,
  input: { brief: unknown; urls?: string[]; research?: boolean; waitMs?: number },
): Promise<{ deckId: string | null; runId: string; status: string }> {
  const brief = WizardBrief.parse({ ...(input.brief as Record<string, unknown>), research: input.research ?? false })
  const run = await createRun(deps, user, brief)
  for (const url of input.urls ?? []) await addUrl(deps, user, run.id, url)
  if (brief.research) await startResearch(deps, user, run.id)
  const deadline = Date.now() + (input.waitMs ?? 60_000)
  for (;;) {
    const sources = await listWizardSources(deps.db, run.id)
    const runNow = await getWizardRunFor(deps.db, user.id, run.id)
    if (runNow?.status === 'draft' && referencesSettled(sources)) break
    if (Date.now() > deadline) return { deckId: null, runId: run.id, status: runNow?.status ?? 'draft' }
    await new Promise((r) => setTimeout(r, 1000))
  }
  await draftWizardOutline(deps, user, run.id)
  const { deckId } = await startGeneration(deps, user, run.id)
  return { deckId, runId: run.id, status: 'generating' }
}

/** Reads one multipart-free upload: the body is the file, the name comes in `x-file-name` (URL-encoded). Size is capped while reading. */
export async function readUploadBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new WizardError('The file is too large.', 413)
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new WizardError('The file is too large.', 413)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export function fileNameFromHeader(value: string | null): string {
  if (!value) throw new WizardError('The upload needs an x-file-name header.')
  try {
    return decodeURIComponent(value)
  } catch {
    throw new WizardError('The file name is not valid.')
  }
}

export { IngestError }
export type { WizardRunRow, WizardSourceRow }

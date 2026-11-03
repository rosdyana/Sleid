// Shared setup for the MCP integration tests (mcp.integration.test.ts and mcp.agent-flow.integration.test.ts): real Postgres
// (127.0.0.1:5433), an in-process collab service, an in-process export, import and wizard worker (pg-boss, Chrome), and real
// local storage. Test-only. startHarness returns null when the database is unreachable, and each test then skips.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getExportJob, createApiToken, type Db, type TokenScope } from '@sleid/db'
import { connectOrNull, makeUser, removeUsers, TEST_DATABASE_URL } from '@sleid/db/testing'
import { createJobQueue, type JobQueue } from '@sleid/jobs'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import { createCollabServer, type CollabServer } from '../../../../collab/src/server.ts'
import { createBrowserPool, type BrowserPool } from '../../../../worker/src/browser.ts'
import { startExportService } from '../../../../worker/src/service.ts'
import { startImportService } from '../../../../worker/src/import/service.ts'
import { createCollabInternalClient, type CollabInternalClient } from '~/lib/collab-client.server'
import { handleExportDownload } from '~/lib/http-handlers.server'
import { handleMcpRequest } from './http.ts'
import { FixedWindowLimiter } from './rate-limit.ts'
import type { McpDeps } from './deps.ts'

export const TOKEN_SECRET = 'mcp-integration-token-secret-0123456789'
export const INTERNAL_SECRET = 'mcp-integration-internal-secret-0123'
export const CHROME = process.env.CHROME_PATH?.trim() ?? ''
export const BROWSER_OK = CHROME !== '' && existsSync(CHROME)
export const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export interface ToolResult {
  isError?: boolean
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
}

export interface Harness {
  db: Db
  collab: CollabInternalClient
  collabServer: CollabServer
  queue: JobQueue
  browser: BrowserPool
  exportsStorage: StorageDriver
  assetsStorage: StorageDriver
  mcpUrl: string
  origin: string
  baseDeps: McpDeps
  httpServers: Server[]
  userIds: string[]
  tempDirs: string[]
  stopWorkers: Array<() => Promise<void>>
}

export function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
}

export function jsonOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>
}

/** A Node HTTP listener that hands each request to a web-standard handler. Test-only adapter. */
export function listen(h: Harness, handler: (request: Request) => Promise<Response>): Promise<{ origin: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length > 0 && req.method !== 'GET' ? Buffer.concat(chunks) : undefined
      const url = `http://127.0.0.1${req.url ?? '/'}`
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
      }
      const response = await handler(new Request(url, { method: req.method, headers, body }))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no address'))
      resolve({ origin: `http://127.0.0.1:${address.port}`, server })
    })
    h.httpServers.push(server)
  })
}

/** Deps for the MCP route, with the download route alongside it, the way the web app serves both. */
export function makeHandler(h: Harness, overrides: Partial<McpDeps> = {}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const download = /^\/api\/exports\/([^/]+)\/file$/.exec(url.pathname)
    if (download) {
      return handleExportDownload(download[1]!, { db: h.db, storage: h.assetsStorage, userId: null }, h.exportsStorage, {
        linkToken: url.searchParams.get('token'),
      })
    }
    return handleMcpRequest(request, { ...h.baseDeps, ...overrides })
  }
}

export async function clientFor(h: Harness, token: string, url: string = h.mcpUrl): Promise<Client> {
  const mcp = new Client({ name: 'sleid-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
  await mcp.connect(transport)
  return mcp
}

export async function tool(mcp: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  // Renders can take a while on a busy machine, so the client waits longer than its 60 second default.
  return (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as ToolResult
}

export async function tokenFor(h: Harness, userId: string, scopes: TokenScope[], deckIds: string[] | null = null): Promise<string> {
  const { secret } = await createApiToken(h.db, { userId, name: `test ${scopes.join(',')}`, scopes, deckIds })
  return secret
}

export async function person(h: Harness, label: string) {
  const u = await makeUser(h.db, label)
  h.userIds.push(u.id)
  return u
}

/** Polls an export job until it is done. Throws when it fails or takes longer than 90 seconds. */
export async function waitForExport(h: Harness, exportId: string): Promise<void> {
  const started = Date.now()
  for (;;) {
    const row = await getExportJob(h.db, exportId)
    if (row && (row.status === 'done' || row.status === 'failed')) {
      if (row.status === 'failed') throw new Error(`export failed: ${row.error}`)
      return
    }
    if (Date.now() - started > 90_000) throw new Error('export did not finish in time')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** Starts the services and returns the harness, or null when the database is not reachable. */
export async function startHarness(): Promise<Harness | null> {
  const db = await connectOrNull()
  if (!db) return null
  const root = mkdtempSync(join(tmpdir(), 'sleid-mcp-test-'))
  const exportsStorage = createLocalStorage(join(root, 'exports'))
  const assetsStorage = createLocalStorage(join(root, 'assets'))
  const silent = { info: () => {}, warn: () => {}, error: () => {} }

  const collabServer = await createCollabServer({
    db,
    tokenSecret: TOKEN_SECRET,
    internalSecret: INTERNAL_SECRET,
    host: '127.0.0.1',
    port: 0,
    internalHost: '127.0.0.1',
    internalPort: 0,
    debounceMs: 100,
    maxDebounceMs: 300,
    logger: silent,
  })
  const live = { baseUrl: collabServer.internalUrl, secret: INTERNAL_SECRET }
  const collab = createCollabInternalClient({ baseUrl: live.baseUrl, secret: live.secret })

  // A test-only queue name and wizard prefix: a dev worker on the same database must not take this test's jobs.
  const suffix = randomUUID().slice(0, 8)
  const queue = createJobQueue(TEST_DATABASE_URL, { queueName: `export-deck-mcp-${suffix}`, prefix: `mcp-${suffix}-`, importQueueName: `import-deck-mcp-${suffix}` })
  await queue.start()
  const stopWorkers: Array<() => Promise<void>> = []
  await startImportService({ db, queue, uploads: assetsStorage, assets: assetsStorage, concurrency: 2, logger: silent })
  const browser = createBrowserPool(BROWSER_OK ? CHROME : undefined)
  const service = await startExportService({
    db,
    queue,
    assets: assetsStorage,
    exports: exportsStorage,
    browser,
    live,
    concurrency: 2,
    tmpRoot: join(root, 'tmp'),
    logger: silent,
  })
  stopWorkers.push(() => service.stop())

  const h: Harness = {
    db,
    collab,
    collabServer,
    queue,
    browser,
    exportsStorage,
    assetsStorage,
    mcpUrl: '',
    origin: '',
    baseDeps: undefined as unknown as McpDeps,
    httpServers: [],
    userIds: [],
    tempDirs: [root],
    stopWorkers,
  }
  const listener = await listen(h, makeHandler(h))
  h.origin = listener.origin
  h.mcpUrl = `${listener.origin}/mcp`
  h.baseDeps = {
    db,
    env: process.env,
    publicUrl: listener.origin,
    live,
    collab,
    getQueue: async () => queue,
    exportStorage: exportsStorage,
    assetStorage: assetsStorage,
    limiter: new FixedWindowLimiter(10_000, 60_000),
    maxBodyBytes: 4 * 1024 * 1024,
    // Long enough for a render while other suites share the machine (the web app uses 30 seconds).
    renderTimeoutMs: 90_000,
    logger: { warn: () => {}, error: () => {} },
  }
  return h
}

export async function stopHarness(h: Harness | null): Promise<void> {
  if (!h) return
  for (const server of h.httpServers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const stop of h.stopWorkers) await stop().catch(() => undefined)
  await h.queue.stop().catch(() => undefined)
  await h.collabServer.close()
  await removeUsers(h.db, h.userIds)
  await h.db.$client.end({ timeout: 1 })
  for (const dir of h.tempDirs) rmSync(dir, { recursive: true, force: true })
}

/** A client that counts every tool call and keeps the arguments it was called with. */
export interface RecordingClient {
  mcp: Client
  calls: Array<{ name: string; args: Record<string, unknown> }>
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>
}

export function recording(mcp: Client): RecordingClient {
  const calls: RecordingClient['calls'] = []
  return {
    mcp,
    calls,
    async call(name, args) {
      calls.push({ name, args })
      return tool(mcp, name, args)
    },
  }
}

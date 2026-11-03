// Integration: the MCP server over real Streamable HTTP, with the official SDK client.
// Real Postgres (127.0.0.1:5433), an in-process collab service, an in-process export worker (pg-boss, Chrome),
// and real local storage (see test-harness.ts). Skips when the database is unreachable. Browser-dependent checks
// (render_slide, render_deck, export_deck completion) skip with a message when CHROME_PATH does not point at a file.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import JSZip from 'jszip'
import {
  assets,
  createApiToken,
  deckMembers,
  deckSnapshots,
  grantMembership,
  listMcpAudit,
  readDeck,
  revokeApiToken,
  type Db,
  type TokenScope,
} from '@sleid/db'
import { makeDeck, makeUser } from '@sleid/db/testing'
import type { JobQueue } from '@sleid/jobs'
import type { StorageDriver } from '@sleid/storage'
import type { CollabServer } from '../../../../collab/src/server.ts'
import { createBrandKit, uploadBrandLogo } from '../brand-kits.server.ts'
import { startWizardService } from '../../../../worker/src/wizard/service.ts'
import { createWizardCollab } from '../../../../worker/src/wizard/collab.ts'
import type { CollabInternalClient } from '~/lib/collab-client.server'
import { FixedWindowLimiter } from './rate-limit.ts'
import type { McpDeps } from './deps.ts'
import {
  BROWSER_OK,
  INTERNAL_SECRET,
  PNG_SIGNATURE,
  clientFor,
  jsonOf,
  listen,
  makeHandler,
  startHarness,
  stopHarness,
  textOf,
  tool,
  waitForExport as waitForExportFor,
  type Harness,
  tokenFor as tokenForFor,
  person as personFor,
} from './test-harness.ts'

let h: Harness | null = null
let db: Db | null = null
let collab: CollabInternalClient
let collabServer: CollabServer | null = null
let queue: JobQueue | null = null
let assetsStorage: StorageDriver
let baseDeps: McpDeps | null = null
let mcpUrl = ''

beforeAll(async () => {
  h = await startHarness()
  if (!h) return
  db = h.db
  collab = h.collab
  collabServer = h.collabServer
  queue = h.queue
  assetsStorage = h.assetsStorage
  baseDeps = h.baseDeps
  mcpUrl = h.mcpUrl
}, 120_000)

afterAll(async () => {
  await stopHarness(h)
}, 120_000)

const client = (token: string) => clientFor(h!, token)
const tokenFor = (userId: string, scopes: TokenScope[], deckIds: string[] | null = null) => tokenForFor(h!, userId, scopes, deckIds)
const person = (label: string) => personFor(h!, label)

describe('MCP over Streamable HTTP', () => {
  it('lists the tools, resources and prompt, and serves the schema resources', async () => {
    if (!db) return
    const owner = await person('mcp-list')
    const mcp = await client(await tokenFor(owner.id, ['decks:read']))
    const { tools } = await mcp.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'add_comment',
        'add_slide',
        'apply_brand_kit',
        'apply_ops',
        'apply_style_from_deck',
        'create_deck',
        'create_deck_from_prompt',
        'delete_slide',
        'derive_theme_from_deck',
        'export_deck',
        'generate_with_ai',
        'get_deck',
        'get_deck_style',
        'get_wizard_status',
        'import_deck',
        'insert_chart',
        'insert_component',
        'insert_diagram',
        'insert_icon',
        'insert_image',
        'lint_deck',
        'list_assets',
        'list_brand_kits',
        'list_comments',
        'list_decks',
        'list_icons',
        'list_templates',
        'list_versions',
        'move_slide',
        'plan_deck',
        'render_deck',
        'render_slide',
        'restore_version',
        'set_deck_options',
        'set_notes',
        'set_theme',
        'share_deck',
        'update_component',
        'update_text',
        'upload_asset',
        'validate_deck',
      ].sort(),
    )
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20)

    const resources = await mcp.listResources()
    expect(resources.resources.map((r) => r.uri).sort()).toEqual([
      'sleid://guide/elements',
      'sleid://schema/deck',
      'sleid://schema/ops',
      'sleid://templates',
      'sleid://themes',
    ])
    const templates = await mcp.listResourceTemplates()
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual(['sleid://decks/{deckId}'])

    const prompts = await mcp.listPrompts()
    expect(prompts.prompts.map((p) => p.name)).toEqual(['build_deck'])
    const prompt = await mcp.getPrompt({ name: 'build_deck', arguments: { topic: 'Solar', slide_count: '5' } })
    expect(JSON.stringify(prompt.messages)).toContain('create_deck')

    const ops = await mcp.readResource({ uri: 'sleid://schema/ops' })
    expect(JSON.stringify(ops.contents[0])).toContain('addSlide')
    const themes = await mcp.readResource({ uri: 'sleid://themes' })
    expect(JSON.stringify(themes.contents[0])).toContain('Midnight')
    await mcp.close()
  })

  it('authenticates: missing, unknown and revoked tokens get 401 with WWW-Authenticate', async () => {
    if (!db) return
    const owner = await person('mcp-auth')
    const secret = await tokenFor(owner.id, ['decks:read'])
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

    const missing = await fetch(mcpUrl, { method: 'POST', headers, body })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/)

    const unknown = await fetch(mcpUrl, { method: 'POST', headers: { ...headers, authorization: 'Bearer sleid_pat_nope' }, body })
    expect(unknown.status).toBe(401)

    const ok = await fetch(mcpUrl, { method: 'POST', headers: { ...headers, authorization: `Bearer ${secret}` }, body })
    expect(ok.status).toBe(200)

    // A revoked token must stop working at once, even though its secret is still known.
    const { secret: doomed, token: doomedRecord } = await createApiToken(db, { userId: owner.id, name: 'doomed', scopes: ['decks:read'], deckIds: null })
    await revokeApiToken(db, owner.id, doomedRecord.id)
    const revoked = await fetch(mcpUrl, { method: 'POST', headers: { ...headers, authorization: `Bearer ${doomed}` }, body })
    expect(revoked.status).toBe(401)
    expect(revoked.headers.get('www-authenticate')).toContain('invalid_token')
  })

  it('runs the deck workflow: create, slides, chart, diagram, outline, render, export, share', async () => {
    if (!db) return
    const owner = await person('mcp-owner')
    const viewer = await person('mcp-viewer-friend')
    const mcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create', 'exports', 'ai']))

    const created = jsonOf(await tool(mcp, 'create_deck', { title: 'MCP workflow', theme: 'Midnight' }))
    const deckId = created.id as string
    expect(deckId).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.url).toContain(`/d/${deckId}`)

    const cover = jsonOf(await tool(mcp, 'add_slide', { deckId, layout: 'title', title: 'Solar at the shop', body: 'Lower bills' }))
    const content = jsonOf(
      await tool(mcp, 'add_slide', {
        deckId,
        layout: 'title-content',
        title: 'Why it pays',
        body: 'Lower power bills\n- Panels on the roof\n- **Battery** for night use\n*Estimates only*',
        notes: 'Say the numbers out loud.',
      }),
    )
    const twoCol = jsonOf(await tool(mcp, 'add_slide', { deckId, layout: 'two-column', title: 'Options' }))
    expect(cover.slideId).toBeTruthy()
    expect(content.slideId).toBeTruthy()
    expect(twoCol.index).toBe(3)

    const chart = await tool(mcp, 'insert_chart', {
      deckId,
      slideId: content.slideId,
      chartType: 'bar',
      columns: ['Month', 'Saving'],
      rows: [
        ['Jan', 10],
        ['Feb', 14],
        ['Mar', 19],
      ],
      title: 'Saving per month',
    })
    expect(chart.isError).toBeFalsy()
    expect(jsonOf(chart).elementId).toBeTruthy()

    const badRow = await tool(mcp, 'insert_chart', { deckId, slideId: content.slideId, chartType: 'bar', columns: ['a', 'b'], rows: [['x']] })
    expect(badRow.isError).toBe(true)
    expect(textOf(badRow)).toContain('one cell per column')

    // A bare multi-word node is what the live model produced in M4: the parser must refuse it, and the agent must see why.
    const invalid = await tool(mcp, 'insert_diagram', { deckId, slideId: twoCol.slideId, mermaid: 'graph LR\nShop appliances --> Battery' })
    expect(invalid.isError).toBe(true)
    expect(textOf(invalid)).toMatch(/did not parse/)
    const valid = await tool(mcp, 'insert_diagram', { deckId, slideId: content.slideId, mermaid: 'graph LR\n  Sun[Sunlight] --> Panels[Solar panels]' })
    expect(valid.isError).toBeFalsy()

    const text = await tool(mcp, 'update_text', { deckId, elementId: jsonOf(chart).elementId as string, text: 'not text' })
    expect(text.isError).toBe(true)

    const outline = jsonOf(await tool(mcp, 'get_deck', { deckId }))
    // The body text fills the content slide, so the chart and the diagram do not fit on it. Each goes on a new
    // slide after its target, as the placement rule says. The deck is cover, two content slides, options, chart, diagram.
    expect(outline.slideCount).toBe(6)
    const slides = outline.slides as Array<{ index: number; id: string; elements: Array<{ type: string; text?: string }> }>
    expect(slides.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5])
    const contentSlide = slides.find((s) => s.id === content.slideId)!
    expect(JSON.stringify(contentSlide)).toContain('Panels on the roof')
    expect(slides.some((s) => s.elements.some((e) => e.type === 'chart'))).toBe(true)
    expect(slides.some((s) => s.elements.some((e) => e.type === 'diagram'))).toBe(true)

    const deckJson = jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'json' }))
    expect(deckJson.id).toBe(deckId)
    expect(deckJson.theme).toMatchObject({ name: 'Midnight' })

    // Add a title-free slide, then set notes and move it.
    const extra = jsonOf(await tool(mcp, 'add_slide', { deckId, layout: 'blank' }))
    expect((await tool(mcp, 'set_notes', { deckId, slideId: extra.slideId as string, notes: 'Notes' })).isError).toBeFalsy()
    const mv = await tool(mcp, 'move_slide', { deckId, slideId: extra.slideId as string, toIndex: 0 })
    const dl = await tool(mcp, 'delete_slide', { deckId, slideId: extra.slideId as string })
    expect(mv.isError).toBeFalsy()
    expect(dl.isError).toBeFalsy()

    const shared = jsonOf(await tool(mcp, 'share_deck', { deckId, email: viewer.email, role: 'viewer' }))
    expect(shared.accepted).toBe(true)
    expect(shared.role).toBe('viewer')
    // share_deck is an explicit grant, so the membership is 'invite' and survives a link restriction.
    const [sharedRow] = await db.select().from(deckMembers).where(eq(deckMembers.userId, viewer.id))
    expect(sharedRow).toMatchObject({ deckId, via: 'invite', role: 'viewer' })

    // The live document holds what the tools wrote.
    const live = await collab.getDeck(deckId)
    expect(live.slides).toHaveLength(6)

    if (BROWSER_OK) {
      const rendered = await tool(mcp, 'render_slide', { deckId, index: 1 })
      expect(rendered.isError).toBeFalsy()
      const image = rendered.content.find((c) => c.type === 'image')!
      expect(image.mimeType).toBe('image/png')
      const bytes = Buffer.from(image.data!, 'base64')
      expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
      expect(bytes.readUInt32BE(16)).toBe(1920)
      expect(bytes.readUInt32BE(20)).toBe(1080)

      const exported = jsonOf(await tool(mcp, 'export_deck', { deckId, format: 'pptx' }))
      const downloadUrl = exported.downloadUrl as string
      expect(downloadUrl).toContain('/api/exports/')
      expect(downloadUrl).toContain('token=sleid_dl_')
      expect(downloadUrl).not.toContain('sleid_pat_')
      const exportId = /exports\/([^/]+)\/file/.exec(downloadUrl)![1]!
      await waitForExportFor(h!, exportId)
      const first = await fetch(downloadUrl)
      expect(first.status).toBe(200)
      expect(first.headers.get('content-type')).toContain('presentationml')
      const zip = await JSZip.loadAsync(Buffer.from(await first.arrayBuffer()))
      expect(zip.file('ppt/slides/slide1.xml')).not.toBeNull()
      // One-time: the second use is refused.
      expect((await fetch(downloadUrl)).status).toBe(404)
    } else {
      console.warn('[mcp test] CHROME_PATH is not set, so render_slide and the export download were not run')
    }

    const audit = await listMcpAudit(db, owner.id, 200)
    const tools = audit.map((r) => r.tool)
    expect(tools).toEqual(expect.arrayContaining(['create_deck', 'add_slide', 'insert_chart', 'insert_diagram', 'get_deck', 'share_deck']))
    expect(audit.some((r) => r.tool === 'insert_diagram' && r.ok === false && (r.error ?? '').includes('did not parse'))).toBe(true)
    expect(audit.some((r) => r.tool === 'insert_diagram' && r.ok === true && r.deckId === deckId)).toBe(true)
    await mcp.close()
  }, 180_000)

  it('refuses writes without the scope, from a viewer, and after membership is removed', async () => {
    if (!db) return
    const owner = await person('mcp-perm-owner')
    const editor = await person('mcp-perm-editor')
    const viewer = await person('mcp-perm-viewer')
    const deckId = await makeDeck(db, owner.id, 'Permissions')
    await db.insert(deckMembers).values([
      { deckId, userId: editor.id, role: 'editor' },
      { deckId, userId: viewer.id, role: 'viewer' },
    ])
    // Give the collab service a document to read and write.
    await collab.getDeck(deckId)

    // Read-only token: apply_ops is refused by scope.
    const readOnly = await client(await tokenFor(owner.id, ['decks:read']))
    const denied = await tool(readOnly, 'apply_ops', { deckId, ops: [{ op: 'setNotes', slideId: 'x', notes: 'y' }] })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('decks:write')
    await readOnly.close()

    // Viewer role: reads work, writes are refused with the role in the message.
    const viewerMcp = await client(await tokenFor(viewer.id, ['decks:read', 'decks:write', 'exports', 'ai']))
    const read = jsonOf(await tool(viewerMcp, 'get_deck', { deckId }))
    expect(read.deckId).toBe(deckId)
    const slideId = (read.slides as Array<{ id: string }>)[0]!.id
    const refused = await tool(viewerMcp, 'add_slide', { deckId, layout: 'blank' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('Your role on this deck is viewer')
    expect((await tool(viewerMcp, 'set_notes', { deckId, slideId, notes: 'no' })).isError).toBe(true)
    // Generating with AI needs editor access too, and is refused before any model call.
    const aiRefused = await tool(viewerMcp, 'generate_with_ai', { deckId, ability: 'speakerNotes', input: {} })
    expect(aiRefused.isError).toBe(true)
    expect(textOf(aiRefused)).toContain('editor')
    await viewerMcp.close()

    // Editor token: writes work until the membership is removed, then the next call is refused.
    const editorMcp = await client(await tokenFor(editor.id, ['decks:read', 'decks:write']))
    expect((await tool(editorMcp, 'set_notes', { deckId, slideId, notes: 'Editor note' })).isError).toBeFalsy()
    await db.delete(deckMembers).where(eq(deckMembers.userId, editor.id))
    const gone = await tool(editorMcp, 'get_deck', { deckId })
    expect(gone.isError).toBe(true)
    expect(textOf(gone)).toBe('Deck not found.')
    await editorMcp.close()
  }, 60_000)

  it('limits a token to its deck allowlist, and reports other decks as not found', async () => {
    if (!db) return
    const owner = await person('mcp-allow')
    const allowed = await makeDeck(db, owner.id, 'Allowed deck')
    const other = await makeDeck(db, owner.id, 'Other deck')
    const mcp = await client(await tokenFor(owner.id, ['decks:read'], [allowed]))

    const list = jsonOf(await tool(mcp, 'list_decks', {}))
    expect((list.decks as Array<{ id: string }>).map((d) => d.id)).toEqual([allowed])

    const hidden = await tool(mcp, 'get_deck', { deckId: other })
    expect(hidden.isError).toBe(true)
    expect(textOf(hidden)).toBe('Deck not found.')
    await mcp.close()
  }, 60_000)

  it('rate limits per token and caps the request body', async () => {
    if (!db) return
    const owner = await person('mcp-limits')
    const secret = await tokenFor(owner.id, ['decks:read'])
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}` }

    const limited = await listen(h!, makeHandler(h!, { limiter: new FixedWindowLimiter(3, 60_000) }))
    const statuses: number[] = []
    let retryAfter: string | null = null
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${limited.origin}/mcp`, { method: 'POST', headers, body: ping })
      statuses.push(res.status)
      if (res.status === 429) retryAfter = res.headers.get('retry-after')
    }
    expect(statuses).toEqual([200, 200, 200, 429])
    expect(Number(retryAfter)).toBeGreaterThan(0)

    const capped = await listen(h!, makeHandler(h!, { maxBodyBytes: 300 }))
    const big = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: { pad: 'x'.repeat(1000) } })
    const tooBig = await fetch(`${capped.origin}/mcp`, { method: 'POST', headers, body: big })
    expect(tooBig.status).toBe(413)
  }, 60_000)

  it('writes the audit row for a failed call with its error text', async () => {
    if (!db) return
    const owner = await person('mcp-audit')
    const deckId = await makeDeck(db, owner.id, 'Audit')
    const mcp = await client(await tokenFor(owner.id, ['decks:read']))
    const denied = await tool(mcp, 'apply_ops', { deckId, ops: [{ op: 'setNotes', slideId: 'x', notes: 'y' }] })
    expect(denied.isError).toBe(true)
    const [row] = (await listMcpAudit(db, owner.id, 10)).filter((r) => r.tool === 'apply_ops')
    expect(row).toMatchObject({ ok: false, deckId, userId: owner.id })
    expect(row!.error).toContain('decks:write')
    expect(row!.ms).toBeGreaterThanOrEqual(0)
    await mcp.close()
  }, 60_000)

  it('import_deck makes a deck from markdown text through the worker, and refuses bad input before queuing it', async () => {
    if (!db) return
    const owner = await person('mcp-import')
    const mcp = await client(await tokenFor(owner.id, ['decks:create', 'decks:read']))

    const md = '# Imported\n\nFirst slide\n\n---\n\n# Second\n\n- one\n- two\n\n---\n\n# Third\n\nLast'
    const made = jsonOf(await tool(mcp, 'import_deck', { format: 'markdown', text: md, title: 'MCP import' }))
    expect(made.deckId).toMatch(/^[0-9a-f-]{36}$/)
    expect(made.url).toContain(`/d/${made.deckId}`)
    expect(made.warnings).toEqual([])
    const read = jsonOf(await tool(mcp, 'get_deck', { deckId: made.deckId, format: 'json' }))
    expect(read.title).toBe('MCP import')
    expect((read.slides as unknown[]).length).toBe(3)

    // Exactly one of contentBase64 or text.
    const both = await tool(mcp, 'import_deck', { format: 'markdown', text: '# a', contentBase64: 'IyBh' })
    expect(both.isError).toBe(true)
    expect(textOf(both)).toMatch(/exactly one of contentBase64 or text/)
    const neither = await tool(mcp, 'import_deck', { format: 'json' })
    expect(neither.isError).toBe(true)
    // A pptx needs the file itself.
    const pptxText = await tool(mcp, 'import_deck', { format: 'pptx', text: 'PK' })
    expect(pptxText.isError).toBe(true)
    expect(textOf(pptxText)).toMatch(/needs contentBase64/)
    // Content checks: a NUL byte is not text, and nothing is queued for it.
    const nul = await tool(mcp, 'import_deck', { format: 'markdown', text: '# a\u0000b' })
    expect(nul.isError).toBe(true)
    expect(textOf(nul)).toMatch(/NUL bytes/)
    // A broken base64 string is refused.
    const badBase64 = await tool(mcp, 'import_deck', { format: 'markdown', contentBase64: 'not base64!' })
    expect(badBase64.isError).toBe(true)
    expect(textOf(badBase64)).toMatch(/not valid base64/)
    await mcp.close()
  }, 120_000)

  it('import_deck needs the decks:create scope', async () => {
    if (!db) return
    const owner = await person('mcp-import-scope')
    const mcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write']))
    const denied = await tool(mcp, 'import_deck', { format: 'markdown', text: '# Nope' })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toMatch(/decks:create/)
    await mcp.close()
  }, 60_000)
})

// ---- create_deck_from_prompt and get_wizard_status ----
// A fake OpenAI-compatible model answers the wizard's structured calls (queries, outline, one slide) by schema name, and
// the in-process wizard worker writes the slides through the collab service. No live model is involved.
interface FakeModel {
  url: string
  close(): Promise<void>
}

function wizardAnswer(
  body: { response_format?: { json_schema?: { name?: string } }; messages?: Array<{ role: string; content?: string }> },
  options: { failSlide?: number } = {},
): Record<string, unknown> {
  const name = body.response_format?.json_schema?.name
  const system = body.messages?.find((m) => m.role === 'system')?.content ?? ''
  if (name === 'queries') return { queries: ['rooftop solar bakery'] }
  if (name === 'outline') {
    const count = Number(/exactly (\d+) slides/.exec(system)?.[1] ?? 3)
    return {
      title: 'Solar for bakeries',
      slides: Array.from({ length: count }, (_, i) => ({
        title: i === 0 ? 'Solar for bakeries' : `Point ${i + 1}`,
        layout: i === 0 ? 'title' : 'title-content',
        keyPoints: ['Solar cuts the bill'],
        visual: 'none',
        sourceRefs: [],
      })),
    }
  }
  if (name === 'slide') {
    const index = Number(/write slide (\d+) of/.exec(system)?.[1] ?? 1)
    // A reply that is not JSON, both times: the slide becomes a placeholder.
    if (index === options.failSlide) return { __raw: 'not json' }
    return { layout: index === 1 ? 'title' : 'title-content', title: index === 1 ? 'Solar for bakeries' : `Point ${index}`, bullets: ['Solar cuts the bill'], notes: 'Say it plainly.' }
  }
  return { paragraphs: ['OK'] }
}

async function startFakeModel(options: { failSlide?: number } = {}): Promise<FakeModel> {
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? (JSON.parse(raw) as Parameters<typeof wizardAnswer>[0] & { stream?: boolean }) : {}
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    const answer = wizardAnswer(body, options)
    const content = typeof answer.__raw === 'string' ? answer.__raw : JSON.stringify(answer)
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ model: 'fake-local', choices: [{ index: 0, delta: { content } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n',
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: 'fake-local', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  h!.httpServers.push(server)
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('MCP create_deck_from_prompt', () => {
  it('makes a deck from a prompt through the wizard worker, and get_wizard_status follows the run to done', async () => {
    if (!db || !baseDeps) return
    const owner = await person('mcp-wizard')
    const token = await tokenFor(owner.id, ['decks:create', 'decks:read', 'decks:write', 'ai'])
    const model = await startFakeModel({ failSlide: 2 })
    const saved = baseDeps.env
    // The server-default provider from the environment (the environment scope may use a local address).
    const env = { ...process.env, SLEID_LLM_KIND: 'openai-compatible', SLEID_LLM_ENDPOINT: model.url, SLEID_LLM_MODEL: 'fake-local' }
    baseDeps.env = env
    const wizard = await startWizardService({
      db,
      queue: queue!,
      uploads: assetsStorage,
      collab: createWizardCollab({ baseUrl: collabServer!.internalUrl, secret: INTERNAL_SECRET }),
      search: null,
      env,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    try {
      const mcp = await client(token)
      const created = jsonOf(await tool(mcp, 'create_deck_from_prompt', { prompt: 'Pitch: rooftop solar for bakeries', slideCount: 3, language: 'en' }))
      expect(typeof created.runId).toBe('string')
      expect(typeof created.deckId).toBe('string')
      const runId = created.runId as string
      const deckId = created.deckId as string

      let status: Record<string, unknown> = {}
      const started = Date.now()
      for (;;) {
        status = jsonOf(await tool(mcp, 'get_wizard_status', { runId }))
        if (status.status === 'done' || status.status === 'failed') break
        if (Date.now() - started > 90_000) throw new Error(`the wizard run did not finish: ${JSON.stringify(status)}`)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      expect(status.status).toBe('done')
      expect(status.progress).toBe(3)
      expect(status.total).toBe(3)
      expect(status.deckId).toBe(deckId)
      // Slide 2 is a placeholder (the fake model's reply was not JSON), and get_wizard_status says which slide it is.
      expect(status.failedSlides).toEqual([2])

      const outline = jsonOf(await tool(mcp, 'get_deck', { deckId }))
      expect(outline.slideCount).toBe(3)
      const deckJson = jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'json' }))
      const slides = deckJson.slides as Array<{ elements: Array<{ role?: string; content?: unknown }> }>
      expect(slides).toHaveLength(3)
      const titles = slides.map((s) => JSON.stringify(s.elements.find((e) => e.role === 'title')?.content ?? ''))
      expect(titles[0]).toContain('Solar for bakeries')
      expect(titles[1]).toContain('Point 2')
      expect(titles[2]).toContain('Point 3')
      await mcp.close()
    } finally {
      baseDeps.env = saved
      await wizard.stop()
      await model.close()
    }
  }, 120_000)

  it('comments and versions: a commenter starts a thread, a viewer reads it but cannot write, and only an editor restores', async (ctx) => {
    if (!db || !collab) return ctx.skip()
    const owner = await person('mcp-m7-owner')
    const commenter = await person('mcp-m7-commenter')
    const viewer = await person('mcp-m7-viewer')
    const deckId = await makeDeck(db, owner.id, 'M7 through MCP')
    await db.transaction(async (tx) => {
      await grantMembership(tx, deckId, commenter.id, 'commenter')
      await grantMembership(tx, deckId, viewer.id, 'viewer')
    })
    const ownerMcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write']))
    const commenterMcp = await client(await tokenFor(commenter.id, ['decks:read', 'decks:write']))
    const viewerMcp = await client(await tokenFor(viewer.id, ['decks:read', 'decks:write']))

    const slideId = (await collab.getDeck(deckId)).slides[0]!.id
    const added = await tool(commenterMcp, 'add_comment', { deckId, slideId, body: `Please check the numbers, ${'@[Owner](' + owner.id + ')'}` })
    expect(added.isError).toBeFalsy()
    const threadId = jsonOf(added).threadId as string
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/)

    const listed = jsonOf(await tool(viewerMcp, 'list_comments', { deckId, slideId }))
    const threads = listed.threads as Array<{ id: string; comments: Array<{ text: string; author: string }> }>
    expect(threads.map((t) => t.id)).toEqual([threadId])
    expect(threads[0]!.comments[0]).toMatchObject({ author: 'mcp-m7-commenter', text: 'Please check the numbers, @Owner' })

    const viewerTry = await tool(viewerMcp, 'add_comment', { deckId, slideId, body: 'viewers cannot comment' })
    expect(viewerTry.isError).toBe(true)
    expect(textOf(viewerTry)).toContain('commenter')

    // Versions: name the live state, change it, then a commenter cannot restore and the owner can.
    const named = await collab.snapshot(deckId, { userId: owner.id, name: 'v1' })
    await collab.applyOps(deckId, 'test', [{ op: 'setTitle', title: 'Changed after v1' }])
    const versions = jsonOf(await tool(viewerMcp, 'list_versions', { deckId }))
    expect((versions.versions as Array<{ id: string; name: string | null }>).map((v) => v.name)).toContain('v1')

    const denied = await tool(commenterMcp, 'restore_version', { deckId, versionId: named.id })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('editor')

    const restored = await tool(ownerMcp, 'restore_version', { deckId, versionId: named.id })
    expect(restored.isError).toBeFalsy()
    expect(jsonOf(restored)).toMatchObject({ ok: true, restored: 'v1' })
    expect((await collab.getDeck(deckId)).title).toBe('M7 through MCP')
    const after = await db.select({ name: deckSnapshots.name }).from(deckSnapshots).where(eq(deckSnapshots.deckId, deckId))
    expect(after.map((r) => r.name)).toContain('Before restore')

    const badVersion = await tool(ownerMcp, 'restore_version', { deckId, versionId: '00000000-0000-4000-8000-000000000000' })
    expect(badVersion.isError).toBe(true)
  })
})

// ---- M9: templates and brand kits ----------------------------------------

const TEST_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

describe('MCP templates and brand kits (M9)', () => {
  it('list_templates, create_deck from a template, list_brand_kits and apply_brand_kit, with the scopes and the audit', async () => {
    if (!db) return
    const owner = await person('mcp-m9-owner')
    const viewer = await person('mcp-m9-viewer')
    const writer = await tokenFor(owner.id, ['decks:read', 'decks:create', 'decks:write'])
    const mcp = await client(writer)

    // 1. The built-in templates are listed, with their ids and slide counts.
    const listed = jsonOf(await tool(mcp, 'list_templates', {}))
    const pitch = (listed.templates as Array<{ id: string; name: string; slideCount: number; builtIn: boolean }>).find((t) => t.id === 'builtin:pitch')
    expect(pitch).toMatchObject({ name: 'Pitch', builtIn: true })
    expect(pitch!.slideCount).toBeGreaterThanOrEqual(4)
    const templateResource = await mcp.readResource({ uri: 'sleid://templates' })
    const resource = JSON.parse((templateResource.contents[0] as { text: string }).text) as Array<{ id: string }>
    expect(resource.map((t) => t.id)).toContain('builtin:pitch')

    // 2. create_deck with a template makes a deck with its theme and slides, and the given title.
    const made = jsonOf(await tool(mcp, 'create_deck', { title: 'From the pitch', templateId: 'builtin:pitch' }))
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(made.title).toBe('From the pitch')
    const read = jsonOf(await tool(mcp, 'get_deck', { deckId: made.id, format: 'json' }))
    expect((read.slides as unknown[]).length).toBe(pitch!.slideCount)
    expect((read.theme as { name: string }).name).toBe('Midnight')
    expect(read.brand).toBeUndefined()

    // A template and a theme cannot both be given, and an unknown template is refused.
    const both = await tool(mcp, 'create_deck', { title: 'x', templateId: 'builtin:pitch', theme: 'Midnight' })
    expect(both.isError).toBe(true)
    expect(textOf(both)).toMatch(/either theme or templateId/)
    const unknown = await tool(mcp, 'create_deck', { title: 'x', templateId: 'builtin:nope' })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toMatch(/Template not found/)

    // 3. A brand kit with a logo, made the way the web app makes it (the same functions and stores).
    const kitDeps = {
      db: db!,
      storage: assetsStorage,
      collab,
      readDeck: async (id: string) => (await readDeck(db!, id, { live: baseDeps!.live })).deck,
    }
    const kit = await createBrandKit(kitDeps, owner.id, {
      name: 'Acme',
      visibility: 'private',
      tokens: {
        palette: { background: '#ffffff', surface: '#f0f4ff', text: '#102030', muted: '#556677', accent: '#0055cc', accent2: '#00aa66', accent3: '#dd7700', accent4: '#8844aa' },
        fonts: { heading: 'Georgia, serif', body: 'Helvetica, sans-serif' },
      },
    })
    await uploadBrandLogo(kitDeps, owner.id, kit.id, { mime: 'image/png', bytes: TEST_PNG })

    // The list also holds kits other people made on this server (instance-visible), so only this test's kit is compared.
    const kits = jsonOf(await tool(mcp, 'list_brand_kits', {}))
    const ownKits = (kits.brandKits as Array<{ id: string }>).filter((k) => k.id === kit.id)
    expect(ownKits).toEqual([expect.objectContaining({ id: kit.id, name: 'Acme', owned: true, hasLogo: true, accent: '#0055cc' })])

    // 4. apply_brand_kit: the deck takes the kit's theme, and the logo is placed on the deck.
    const applied = jsonOf(await tool(mcp, 'apply_brand_kit', { deckId: made.id, brandKitId: kit.id }))
    expect(applied).toMatchObject({ deckId: made.id, brandKitId: kit.id, theme: 'Acme', logo: true })
    const branded = jsonOf(await tool(mcp, 'get_deck', { deckId: made.id, format: 'json' }))
    expect((branded.theme as { name: string; colors: { accent: string } }).colors.accent).toBe('#0055cc')
    expect(branded.brand).toMatchObject({ brandKitId: kit.id, logo: { src: expect.stringMatching(/^\/api\/assets\//) } })

    // Removing the kit keeps the theme and clears the logo.
    const removed = jsonOf(await tool(mcp, 'apply_brand_kit', { deckId: made.id, brandKitId: null }))
    expect(removed).toMatchObject({ removed: true })
    const plain = jsonOf(await tool(mcp, 'get_deck', { deckId: made.id, format: 'json' }))
    expect(plain.brand).toBeUndefined()
    expect((plain.theme as { name: string }).name).toBe('Acme')

    // 5. Scopes and roles: a token without decks:write, a viewer, and an outsider are refused.
    const readOnly = await client(await tokenFor(owner.id, ['decks:read']))
    const noWrite = await tool(readOnly, 'apply_brand_kit', { deckId: made.id, brandKitId: kit.id })
    expect(noWrite.isError).toBe(true)
    expect(textOf(noWrite)).toMatch(/decks:write/)
    await readOnly.close()

    await db!.insert(deckMembers).values({ deckId: made.id as string, userId: viewer.id, role: 'viewer', via: 'invite' })
    const viewerClient = await client(await tokenFor(viewer.id, ['decks:read', 'decks:write']))
    const viewerTry = await tool(viewerClient, 'apply_brand_kit', { deckId: made.id, brandKitId: kit.id })
    expect(viewerTry.isError).toBe(true)
    expect(textOf(viewerTry)).toMatch(/editor access|Your role/)
    await viewerClient.close()

    const outsider = await person('mcp-m9-outsider')
    const outsiderClient = await client(await tokenFor(outsider.id, ['decks:read', 'decks:write']))
    const outsiderTry = await tool(outsiderClient, 'apply_brand_kit', { deckId: made.id, brandKitId: kit.id })
    expect(outsiderTry.isError).toBe(true)
    expect(textOf(outsiderTry)).toMatch(/Deck not found/)
    await outsiderClient.close()

    // 6. Every call is in the audit, including the refused ones: the two applies, then the call with a token that lacks the scope.
    const audit = await db!.execute(sql`select ok from mcp_audit where user_id = ${owner.id} and tool = 'apply_brand_kit' order by created_at`)
    expect(audit.map((r) => (r as { ok: boolean }).ok)).toEqual([true, true, false])
    await mcp.close()
  }, 120_000)
})


// ---- M11 phase D: assets, components, validation, renders and the compact read ----

const TEST_PNG_B64 = Buffer.from(TEST_PNG).toString('base64')

describe('MCP assets, components and checks (M11 phase D)', () => {
  it('upload_asset to the library, then insert_image copies it into a deck; another user cannot copy it', async () => {
    if (!db) return
    const owner = await person('mcp-d-assets')
    const mcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create']))
    const lib = jsonOf(await tool(mcp, 'upload_asset', { name: 'Logo', mime: 'png', base64: TEST_PNG_B64, library: true }))
    expect(lib).toMatchObject({ scope: 'library', url: null, width: 1, height: 1 })
    const libraryId = lib.assetId as string

    const deckId = jsonOf(await tool(mcp, 'create_deck', { title: 'Assets' })).id as string
    const slideId = jsonOf(await tool(mcp, 'add_slide', { deckId, layout: 'blank' })).slideId as string
    const placed = await tool(mcp, 'insert_image', { deckId, slideId, assetId: libraryId, alt: 'Logo picture' })
    expect(placed.isError).toBeFalsy()
    const copyId = /\/api\/assets\/(.+)$/.exec(jsonOf(placed).src as string)![1]!
    expect(copyId).not.toBe(libraryId)
    const [row] = await db.select().from(assets).where(eq(assets.id, copyId))
    expect(row).toMatchObject({ deckId, mime: 'image/png' })

    const onDeck = jsonOf(await tool(mcp, 'upload_asset', { name: 'Shot', mime: 'png', base64: TEST_PNG_B64, deckId }))
    expect(onDeck).toMatchObject({ scope: 'deck', url: `/api/assets/${onDeck.assetId}` })
    const listed = jsonOf(await tool(mcp, 'list_assets', { deckId }))
    expect((listed.assets as Array<{ assetId: string }>).map((a) => a.assetId)).toEqual(expect.arrayContaining([copyId, onDeck.assetId]))
    const both = await tool(mcp, 'upload_asset', { name: 'x', mime: 'png', base64: TEST_PNG_B64, deckId, library: true })
    expect(both.isError).toBe(true)

    const other = await person('mcp-d-assets-other')
    const otherMcp = await client(await tokenFor(other.id, ['decks:read', 'decks:write', 'decks:create']))
    const otherDeck = jsonOf(await tool(otherMcp, 'create_deck', { title: 'Theirs' })).id as string
    const otherSlide = jsonOf(await tool(otherMcp, 'add_slide', { deckId: otherDeck, layout: 'blank' })).slideId as string
    const refused = await tool(otherMcp, 'insert_image', { deckId: otherDeck, slideId: otherSlide, assetId: libraryId, alt: 'Stolen' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toBe('That asset was not found.')
    await mcp.close()
    await otherMcp.close()
  }, 120_000)

  it('insert_image fetches an http URL and stores it on the deck; the public policy refuses a loopback address', async () => {
    if (!db) return
    const owner = await person('mcp-d-url')
    const served = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(TEST_PNG))
    })
    await new Promise<void>((resolve) => served.listen(0, '127.0.0.1', resolve))
    h!.httpServers.push(served)
    const port = (served.address() as AddressInfo).port
    const token = await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create'])
    // The test listener allows the local address; the default listener (public addresses only) does not.
    const allowLocal = await listen(h!, makeHandler(h!, { imageFetchPolicy: { allowPrivate: true } }))
    const testMcp = await clientFor(h!, token, `${allowLocal.origin}/mcp`)
    const publicMcp = await client(token)
    const deckId = jsonOf(await tool(publicMcp, 'create_deck', { title: 'From a URL' })).id as string
    const slideId = jsonOf(await tool(publicMcp, 'add_slide', { deckId, layout: 'blank' })).slideId as string

    const url = `http://127.0.0.1:${port}/shot.png`
    const stored = await tool(testMcp, 'insert_image', { deckId, slideId, url, alt: 'A remote picture' })
    expect(stored.isError).toBeFalsy()
    const assetId = /\/api\/assets\/(.+)$/.exec(jsonOf(stored).src as string)![1]!
    const [row] = await db.select().from(assets).where(eq(assets.id, assetId))
    expect(row).toMatchObject({ deckId, mime: 'image/png' })

    const refused = await tool(publicMcp, 'insert_image', { deckId, slideId, url, alt: 'Blocked' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/could not be fetched/)
    await testMcp.close()
    await publicMcp.close()
  }, 120_000)

  it('validate_deck reports each problem with its path, and changes nothing', async () => {
    if (!db) return
    const owner = await person('mcp-d-validate')
    const mcp = await client(await tokenFor(owner.id, ['decks:read']))
    const bad = JSON.stringify({ slides: [{ elements: [{ type: 'text', x: 'left', y: 0, w: 10, h: 10, content: { type: 'doc' }, style: { align: 'sideways' } }] }] })
    const result = jsonOf(await tool(mcp, 'validate_deck', { text: bad }))
    expect(result.ok).toBe(false)
    const issues = result.issues as Array<{ path: string; message: string }>
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['slides[0].elements[0].x', 'slides[0].elements[0].style.align']))
    expect(jsonOf(await tool(mcp, 'validate_deck', { text: '{"title":"Q3","slides":[]}' }))).toMatchObject({ ok: true, issues: [] })
    expect(jsonOf(await tool(mcp, 'validate_deck', { text: '{nope' })).ok).toBe(false)
    await mcp.close()
  }, 60_000)

  it('import_deck takes a json deck with no id or version, and turns its data: image into an asset', async () => {
    if (!db) return
    const owner = await person('mcp-d-json')
    const mcp = await client(await tokenFor(owner.id, ['decks:create', 'decks:read']))
    const doc = {
      slides: [
        {
          elements: [
            { type: 'text', x: 120, y: 80, w: 1680, h: 160, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] }, style: {} },
            { type: 'image', x: 200, y: 300, w: 400, h: 300, src: `data:image/png;base64,${TEST_PNG_B64}`, alt: 'A dot' },
          ],
        },
      ],
    }
    const made = jsonOf(await tool(mcp, 'import_deck', { format: 'json', text: JSON.stringify(doc), title: 'JSON import' }))
    const read = jsonOf(await tool(mcp, 'get_deck', { deckId: made.deckId, format: 'json' }))
    const image = (read.slides as Array<{ elements: Array<{ type: string; src?: string }> }>)[0]!.elements.find((e) => e.type === 'image')
    expect(image!.src).toMatch(/^\/api\/assets\/[0-9a-f-]{36}$/)
    await mcp.close()
  }, 120_000)

  it('add_slide with components is checked by lint_deck, rebuilds a component, reads back compact, and reports bad props', async () => {
    if (!db) return
    const owner = await person('mcp-d-components')
    const mcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create']))
    const deckId = jsonOf(await tool(mcp, 'create_deck', { title: 'Components' })).id as string
    const made = jsonOf(
      await tool(mcp, 'add_slide', {
        deckId,
        variant: 'light',
        components: [
          { kind: 'header', props: { label: 'Why', heading: 'One place for the team', subtitle: 'Docs, issues and automation' } },
          {
            kind: 'card_grid',
            props: { cards: [{ icon: 'lock', title: 'Private', body: 'Only members see a page.' }, { icon: 'link', title: 'Linked', body: 'Every item links to its source.' }, { title: 'Fast', body: 'Search finds it.' }] },
          },
        ],
      }),
    )
    const slideId = made.slideId as string
    const header = (made.components as Array<{ kind: string; instance: string }>).find((c) => c.kind === 'header')!
    expect(made.components).toHaveLength(2)
    expect(jsonOf(await tool(mcp, 'lint_deck', { deckId }))).toMatchObject({ ok: true })

    const icon = await tool(mcp, 'insert_icon', { deckId, slideId, name: 'check', size: 40 })
    expect(icon.isError).toBeFalsy()
    expect(jsonOf(icon).elementId).toBeTruthy()
    const badIcon = await tool(mcp, 'insert_icon', { deckId, slideId, name: 'no-such-icon-xyz' })
    expect(badIcon.isError).toBe(true)
    expect(textOf(badIcon)).toMatch(/Unknown icon/)

    const rebuilt = jsonOf(await tool(mcp, 'update_component', { deckId, instance: header.instance, props: { label: 'Why', heading: 'Two places, one login' } }))
    expect(rebuilt.instance).toBe(header.instance)
    const compact = jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'compact' }))
    expect(JSON.stringify(compact)).toContain('Two places, one login')
    const first = jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'compact', range: { from: 0, to: 0 } }))
    expect((first.slides as unknown[]).length).toBe(1)
    const byId = jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'outline', slideIds: [slideId] }))
    expect((byId.slides as unknown[]).length).toBe(1)
    expect(jsonOf(await tool(mcp, 'lint_deck', { deckId }))).toMatchObject({ ok: true })

    const badCards = await tool(mcp, 'add_slide', { deckId, components: [{ kind: 'card_grid', props: { cards: [] } }] })
    expect(badCards.isError).toBe(true)
    expect(textOf(badCards)).toMatch(/components\[0\] \(card_grid\) is not valid/)

    const plan = jsonOf(await tool(mcp, 'plan_deck', { brief: 'Team tool', slideCount: 5 }))
    expect((plan.calls as Array<{ tool: string }>)[0]!.tool).toBe('create_deck')
    expect((plan.slides as unknown[]).length).toBe(5)
    await mcp.close()
  }, 120_000)

  it('create_deck with startEmpty makes a deck with no slides, and add_slide fills it', async () => {
    if (!db) return
    const owner = await person('mcp-d-empty')
    const mcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create']))
    const deckId = jsonOf(await tool(mcp, 'create_deck', { title: 'Empty', startEmpty: true })).id as string
    expect(jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'outline' }))).toMatchObject({ slideCount: 0 })
    await savedSlideCount(deckId, 0)
    const made = jsonOf(await tool(mcp, 'add_slide', { deckId, variant: 'dark', components: [{ kind: 'header', region: 'center', props: { heading: 'Cover' } }] }))
    expect(made.index).toBe(0)
    expect(jsonOf(await tool(mcp, 'lint_deck', { deckId }))).toMatchObject({ ok: true })
    await mcp.close()
  }, 120_000)

  it('set_deck_options and list_icons work through MCP', async () => {
    if (!db) return
    const owner = await person('mcp-d-options')
    const mcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create']))
    const deckId = jsonOf(await tool(mcp, 'create_deck', { title: 'Two languages' })).id as string
    expect(jsonOf(await tool(mcp, 'set_deck_options', { deckId, secondaryLanguage: 'zh-TW' }))).toMatchObject({ secondaryLanguage: 'zh-TW' })
    const read = jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'json' }))
    expect(read.secondaryLanguage).toBe('zh-TW')
    expect(jsonOf(await tool(mcp, 'set_deck_options', { deckId, secondaryLanguage: null })).secondaryLanguage).toBeNull()
    const icons = jsonOf(await tool(mcp, 'list_icons', { query: 'eye' }))
    expect(icons.icons as string[]).toEqual(expect.arrayContaining(['eye-off']))
    await mcp.close()
  }, 120_000)

  it('render_deck returns a contact sheet as one PNG, and the slides mode returns one PNG per slide', async (ctx) => {
    if (!db) return ctx.skip()
    if (!BROWSER_OK) {
      console.warn('[mcp test] CHROME_PATH is not set, so render_deck was not run')
      return
    }
    const owner = await person('mcp-d-render')
    const mcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create']))
    const deckId = jsonOf(await tool(mcp, 'create_deck', { title: 'Renders', theme: 'Midnight' })).id as string
    const first = jsonOf(await tool(mcp, 'add_slide', { deckId, layout: 'title', title: 'One', body: 'Two' })).slideId as string
    const second = jsonOf(await tool(mcp, 'add_slide', { deckId, layout: 'blank', title: 'Three' })).slideId as string

    const sheet = await tool(mcp, 'render_deck', { deckId, mode: 'sheet' })
    expect(sheet.isError).toBeFalsy()
    const pictures = sheet.content.filter((c) => c.type === 'image')
    expect(pictures).toHaveLength(1)
    expect([...Buffer.from(pictures[0]!.data!, 'base64').subarray(0, 8)]).toEqual(PNG_SIGNATURE)

    const slides = await tool(mcp, 'render_deck', { deckId, mode: 'slides', slideIds: [first, second] })
    expect(slides.isError).toBeFalsy()
    expect(slides.content.filter((c) => c.type === 'image')).toHaveLength(2)
    const listed = JSON.parse(textOf(slides)) as { slides: Array<{ slideId: string }> }
    expect(listed.slides.map((s) => s.slideId)).toEqual([first, second])
    await mcp.close()
  }, 240_000)
})

/**
 * Waits until the saved state (read from the database, not the live document) has this many slides. The store runs a
 * moment after a write, so a check of the saved state has to wait for it.
 */
async function savedSlideCount(deckId: string, expected: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    const saved = (await readDeck(db!, deckId)).deck.slides.length
    if (saved === expected) return
    if (Date.now() - started > 10_000) throw new Error(`the saved deck has ${saved} slides, expected ${expected}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe('MCP deletions reach the database (M11 phase D)', () => {
  it('a deleted slide is gone from the saved state too, so a reload from the database does not bring it back', async () => {
    if (!db) return
    const owner = await person('mcp-d-delete')
    const mcp = await client(await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create']))
    const deckId = jsonOf(await tool(mcp, 'create_deck', { title: 'Delete me' })).id as string
    await savedSlideCount(deckId, 1)
    const slideId = (jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'json' })).slides as Array<{ id: string }>)[0]!.id
    expect((await tool(mcp, 'delete_slide', { deckId, slideId })).isError).toBeFalsy()
    expect(jsonOf(await tool(mcp, 'get_deck', { deckId, format: 'outline' }))).toMatchObject({ slideCount: 0 })
    await savedSlideCount(deckId, 0)
    await mcp.close()
  }, 120_000)
})

describe('MCP derive_theme_from_deck (M11 phase D)', () => {
  it('reads the look of a deck, and saves it as a brand kit with its logo only when the token can write decks', async () => {
    if (!db) return
    const owner = await person('mcp-d-derive')
    const writer = await client(await tokenFor(owner.id, ['decks:read', 'decks:write', 'decks:create']))
    const deckId = jsonOf(await tool(writer, 'create_deck', { title: 'Brand source' })).id as string
    const logo = `data:image/png;base64,${TEST_PNG_B64}`
    const set = await tool(writer, 'set_theme', { deckId, theme: { components: { chrome: { logoLight: logo, footerText: 'Acme Ltd' } } } })
    expect(set.isError).toBeFalsy()

    const look = jsonOf(await tool(writer, 'derive_theme_from_deck', { deckId }))
    expect((look.theme as { name: string }).name).toBe('Sheets Light')
    expect(JSON.stringify(look)).not.toContain('base64,')

    const readOnly = await client(await tokenFor(owner.id, ['decks:read']))
    const refused = await tool(readOnly, 'derive_theme_from_deck', { deckId, saveAsBrandKit: { name: 'Nope' } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/decks:write/)
    await readOnly.close()

    const saved = jsonOf(await tool(writer, 'derive_theme_from_deck', { deckId, saveAsBrandKit: { name: 'Derived kit' } }))
    expect(saved).toMatchObject({ name: 'Derived kit', logos: { light: true, dark: false } })
    const kits = jsonOf(await tool(writer, 'list_brand_kits', {}))
    const kit = (kits.brandKits as Array<{ id: string; name: string; owned: boolean; hasLogo: boolean }>).find((k) => k.id === saved.brandKitId)
    expect(kit).toMatchObject({ name: 'Derived kit', owned: true, hasLogo: true })
    await writer.close()
  }, 120_000)
})


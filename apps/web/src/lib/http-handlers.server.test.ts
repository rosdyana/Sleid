// Asset and export HTTP rules against real Postgres. Skips when the database is unreachable.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createExportJob, decks, grantMembership, markExportDone, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import { ASSET_MAX_BYTES, bytesMatchMime, handleAssetRead, handleAssetUpload, handleExportDownload, type HandlerDeps } from './http-handlers.server.ts'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')

let db: Db | null = null
let storage: StorageDriver
const dir = mkdtempSync(join(tmpdir(), 'sleid-http-test-'))
const userIds: string[] = []
let deckId = ''
let owner = ''
let editor = ''
let viewer = ''
let outsider = ''

beforeAll(async () => {
  db = await connectOrNull()
  if (!db) return
  storage = createLocalStorage(dir)
  const people = await Promise.all(['http-owner', 'http-editor', 'http-viewer', 'http-outsider'].map((l) => makeUser(db!, l)))
  ;[owner, editor, viewer, outsider] = [people[0]!.id, people[1]!.id, people[2]!.id, people[3]!.id]
  userIds.push(...people.map((p) => p.id))
  deckId = await makeDeck(db, owner, 'HTTP test deck')
  await db.transaction((tx) => grantMembership(tx, deckId, editor, 'editor'))
  await db.transaction((tx) => grantMembership(tx, deckId, viewer, 'viewer'))
})

afterAll(async () => {
  if (!db) return
  await removeUsers(db, userIds)
  await db.$client.end({ timeout: 1 })
  rmSync(dir, { recursive: true, force: true })
})

function deps(userId: string | null): HandlerDeps {
  return { db: db!, storage, userId }
}

function upload(file: File | null, field = 'file'): Request {
  const form = new FormData()
  if (file) form.append(field, file)
  return new Request(`http://test/api/decks/${deckId}/assets`, { method: 'POST', body: form })
}

function pngFile(name = 'pic.png') {
  return new File([PNG], name, { type: 'image/png' })
}

describe('asset upload', () => {
  it('an editor uploads a PNG and gets the asset URL back', async (ctx) => {
    if (!db) return ctx.skip()
    const res = await handleAssetUpload(upload(pngFile()), deckId, deps(editor))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; url: string; mime: string; bytes: number }
    expect(body.url).toBe(`/api/assets/${body.id}`)
    expect(body.mime).toBe('image/png')
    expect(body.bytes).toBe(PNG.byteLength)
    expect(await storage.get(body.id)).not.toBeNull()
  })

  it('a viewer cannot upload (403), a non-member gets 404, an anonymous caller gets 401', async (ctx) => {
    if (!db) return ctx.skip()
    expect((await handleAssetUpload(upload(pngFile()), deckId, deps(viewer))).status).toBe(403)
    expect((await handleAssetUpload(upload(pngFile()), deckId, deps(outsider))).status).toBe(404)
    expect((await handleAssetUpload(upload(pngFile()), deckId, deps(null))).status).toBe(401)
  })

  it('refuses a file over 10 MB with 413', async (ctx) => {
    if (!db) return ctx.skip()
    const big = new Uint8Array(ASSET_MAX_BYTES + 1)
    big.set(PNG.subarray(0, 8))
    const res = await handleAssetUpload(upload(new File([big], 'big.png', { type: 'image/png' })), deckId, deps(editor))
    expect(res.status).toBe(413)
  })

  it('refuses a type that is not an image (415), and a file whose bytes do not match its type (415)', async (ctx) => {
    if (!db) return ctx.skip()
    expect((await handleAssetUpload(upload(new File(['hello'], 'a.txt', { type: 'text/plain' })), deckId, deps(editor))).status).toBe(415)
    expect((await handleAssetUpload(upload(new File(['not a png'], 'fake.png', { type: 'image/png' })), deckId, deps(editor))).status).toBe(415)
  })

  it('refuses an SVG with active content, and an empty file', async (ctx) => {
    if (!db) return ctx.skip()
    const evil = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect((await handleAssetUpload(upload(new File([evil], 'evil.svg', { type: 'image/svg+xml' })), deckId, deps(editor))).status).toBe(415)
    expect((await handleAssetUpload(upload(new File([], 'empty.png', { type: 'image/png' })), deckId, deps(editor))).status).toBe(400)
  })

  it('bytesMatchMime accepts real signatures only', () => {
    expect(bytesMatchMime('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
    expect(bytesMatchMime('image/gif', new TextEncoder().encode('GIF89a....'))).toBe(true)
    expect(bytesMatchMime('image/webp', new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe(true)
    expect(bytesMatchMime('image/svg+xml', SVG)).toBe(true)
    expect(bytesMatchMime('image/svg+xml', new TextEncoder().encode('<svg onload="x()"></svg>'))).toBe(false)
  })
})

describe('asset read', () => {
  let assetId = ''

  beforeAll(async () => {
    if (!db) return
    const res = await handleAssetUpload(upload(new File([SVG], 'shape.svg', { type: 'image/svg+xml' })), deckId, deps(editor))
    assetId = ((await res.json()) as { id: string }).id
  })

  it('a viewer can read an asset of their deck', async (ctx) => {
    if (!db) return ctx.skip()
    const res = await handleAssetRead(assetId, deps(viewer))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
  })

  it('an SVG is served with a sandbox CSP, exact content type and nosniff', async (ctx) => {
    if (!db) return ctx.skip()
    const res = await handleAssetRead(assetId, deps(viewer))
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('a non-member and an anonymous visitor get 404 for an unpublished deck', async (ctx) => {
    if (!db) return ctx.skip()
    expect((await handleAssetRead(assetId, deps(outsider))).status).toBe(404)
    expect((await handleAssetRead(assetId, deps(null))).status).toBe(404)
    expect((await handleAssetRead(randomUUID(), deps(viewer))).status).toBe(404)
  })

  it('anyone can read an asset once the deck is published, and not after it is unpublished', async (ctx) => {
    if (!db) return ctx.skip()
    const token = randomUUID().replace(/-/g, '') + 'abcd'
    await db.update(decks).set({ publishedToken: token, publishedAt: new Date() }).where(eq(decks.id, deckId))
    expect((await handleAssetRead(assetId, deps(null))).status).toBe(200)
    await db.update(decks).set({ publishedToken: null, publishedAt: null }).where(eq(decks.id, deckId))
    expect((await handleAssetRead(assetId, deps(null))).status).toBe(404)
  })
})

describe('export download', () => {
  it('only the requester can download, and only once the file is done', async (ctx) => {
    if (!db) return ctx.skip()
    const exportId = await createExportJob(db, { deckId, userId: editor, format: 'json', options: {} })
    expect((await handleExportDownload(exportId, deps(editor), storage)).status).toBe(409)
    expect((await handleExportDownload(exportId, deps(viewer), storage)).status).toBe(404)
    await storage.put(exportId, new TextEncoder().encode('{}'))
    await markExportDone(db, exportId, { fileKey: exportId, fileName: 'Deck "x".sleid.json', contentType: 'application/json', bytes: 2 })
    const res = await handleExportDownload(exportId, deps(editor), storage)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Deck _x_\.sleid\.json"; filename\*=UTF-8''/)
    expect(await res.text()).toBe('{}')
  })
})

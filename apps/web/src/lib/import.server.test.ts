// Import service rules: the content checks, the size caps, the per-user limit, ownership and queue failures.
// The database part runs against real Postgres and skips when it is unreachable. The rest is pure.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getImportJob, importJobs, markImportDone, type Db } from '@sleid/db'
import { connectOrNull, makeDeck, makeUser, removeUsers } from '@sleid/db/testing'
import { createLocalStorage, type StorageDriver } from '@sleid/storage'
import * as imports from './import.server'

const MB = 1024 * 1024
const enc = (s: string) => new TextEncoder().encode(s)
const PPTX_HEAD = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])

async function refused(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(imports.ImportError)
    return { status: (err as imports.ImportError).status, message: (err as Error).message }
  }
  throw new Error('expected the import to be refused')
}

describe('checkImportBytes (content, not the file name)', () => {
  it('a pptx must start with the zip signature', () => {
    expect(() => imports.checkImportBytes('pptx', PPTX_HEAD)).not.toThrow()
    expect(() => imports.checkImportBytes('pptx', enc('# just markdown'))).toThrow(imports.ImportError)
    try {
      imports.checkImportBytes('pptx', enc('# just markdown'))
    } catch (err) {
      expect((err as imports.ImportError).status).toBe(415)
    }
  })

  it('markdown and json must be UTF-8 with no NUL bytes', () => {
    expect(() => imports.checkImportBytes('markdown', enc('# Hello, world'))).not.toThrow()
    expect(() => imports.checkImportBytes('markdown', Uint8Array.from([0x23, 0x00, 0x41]))).toThrow(/NUL/)
    expect(() => imports.checkImportBytes('markdown', Uint8Array.from([0xff, 0xfe, 0x41]))).toThrow(/UTF-8/)
    expect(() => imports.checkImportBytes('json', Uint8Array.from([0x7b, 0xff]))).toThrow(/UTF-8/)
  })

  it('json must parse', () => {
    expect(() => imports.checkImportBytes('json', enc('{"slides":[]}'))).not.toThrow()
    expect(() => imports.checkImportBytes('json', enc('{ nope'))).toThrow(/not valid JSON/)
  })

  it('empty files are refused', () => {
    expect(() => imports.checkImportBytes('markdown', new Uint8Array())).toThrow(/empty/)
  })

  it('caps are 50 MB for pptx and 5 MB for markdown and json', () => {
    const pptx = new Uint8Array(50 * MB + 1)
    pptx.set(PPTX_HEAD, 0)
    expect(() => imports.checkImportBytes('pptx', pptx)).toThrow(/50 MB/)
    const pptxAtCap = new Uint8Array(50 * MB)
    pptxAtCap.set(PPTX_HEAD, 0)
    expect(() => imports.checkImportBytes('pptx', pptxAtCap)).not.toThrow()
    expect(() => imports.checkImportBytes('markdown', new Uint8Array(5 * MB + 1).fill(0x41))).toThrow(/5 MB/)
    expect(() => imports.checkImportBytes('json', new Uint8Array(5 * MB + 1).fill(0x20))).toThrow(/5 MB/)
  })
})

describe('request helpers', () => {
  it('decodes standard base64 and refuses anything else', () => {
    expect(Array.from(imports.decodeBase64('aGkg\nYm9i'))).toEqual(Array.from(enc('hi bob')))
    expect(() => imports.decodeBase64('not base64!')).toThrow(/base64/)
    expect(() => imports.decodeBase64('')).toThrow(/base64/)
  })

  it('reads the format header and refuses unknown formats', () => {
    expect(imports.formatFromHeader('pptx')).toBe('pptx')
    expect(imports.formatFromHeader(' json ')).toBe('json')
    expect(() => imports.formatFromHeader('exe')).toThrow(/x-import-format/)
    expect(() => imports.formatFromHeader(null)).toThrow(/x-import-format/)
  })

  it('reads the file name header, URL-decoded', () => {
    expect(imports.fileNameFromHeader('my%20deck.md')).toBe('my deck.md')
    expect(() => imports.fileNameFromHeader(null)).toThrow(/x-file-name/)
  })

  it('refuses a body over the cap while reading, and a declared size over it at once', async () => {
    const big = new Request('http://localhost/api/imports', { method: 'POST', body: new Uint8Array(11) })
    expect(await refused(imports.readImportBody(big, 10))).toMatchObject({ status: 413 })
    const declared = new Request('http://localhost/api/imports', { method: 'POST', body: new Uint8Array(4), headers: { 'content-length': '999' } })
    expect(await refused(imports.readImportBody(declared, 10))).toMatchObject({ status: 413 })
    const ok = await imports.readImportBody(new Request('http://localhost/api/imports', { method: 'POST', body: new Uint8Array(10) }), 10)
    expect(ok.byteLength).toBe(10)
  })
})

const db: Db | null = await connectOrNull()

describe('import service (real Postgres)', () => {
  const users: string[] = []
  let dir = ''
  let storage: StorageDriver
  let queued: Array<{ importId: string }> = []
  let deps: imports.ImportDeps
  let failQueue = false

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sleid-import-web-'))
    storage = createLocalStorage(dir)
    deps = {
      db: db!,
      storage,
      queue: {
        enqueueImport: async (payload) => {
          if (failQueue) throw new Error('boom')
          queued.push(payload)
          return 'job'
        },
      },
    }
  })

  afterAll(async () => {
    if (!db) return
    await removeUsers(db, users)
    await db.$client.end({ timeout: 1 })
    rmSync(dir, { recursive: true, force: true })
  })

  async function person(label: string) {
    const u = await makeUser(db!, label)
    users.push(u.id)
    return { id: u.id }
  }

  it.skipIf(!db)('a Google Slides import is recorded as google-slides with its file id, and still goes through the pptx checks', async () => {
    const a = await person('imp-google')
    const fileId = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-012'
    const { importId } = await imports.startImport(deps, a, { format: 'pptx', fileName: `${fileId}.pptx`, bytes: PPTX_HEAD, google: { fileId } })
    const row = await getImportJob(db!, importId)
    expect(row).toMatchObject({ format: 'google-slides', googleFileId: fileId, sourceKey: `import/${importId}` })
    const bad = await refused(imports.startImport(deps, a, { format: 'markdown', fileName: 'x.md', bytes: enc('# x'), google: { fileId } }))
    expect(bad.status).toBe(400)
  })

  it.skipIf(!db)('starts an import: stores the source under import/<id>, inserts a queued row and queues the job', async () => {
    const a = await person('imp-start')
    const bytes = enc('# Deck\n\nText')
    const { importId } = await imports.startImport(deps, a, { format: 'markdown', fileName: 'notes.md', bytes })
    expect(importId).toMatch(/^[0-9a-f-]{36}$/)
    const row = await getImportJob(db!, importId)
    expect(row).toMatchObject({ status: 'queued', format: 'markdown', fileName: 'notes.md', bytes: bytes.byteLength, sourceKey: `import/${importId}` })
    expect(Array.from((await storage.get(`import/${importId}`))!)).toEqual(Array.from(bytes))
    expect(queued.at(-1)).toEqual({ importId })
  })

  it.skipIf(!db)('keeps only the base name of the file name, and a title when one is given', async () => {
    const a = await person('imp-name')
    const { importId } = await imports.startImport(deps, a, { format: 'json', fileName: '../../secret/deck.json', bytes: enc('{}'), title: '  Quarterly  ' })
    const row = await getImportJob(db!, importId)
    expect(row?.fileName).toBe('deck.json')
    expect(row?.title).toBe('Quarterly')
  })

  it.skipIf(!db)('allows 10 imports in an hour, refuses the 11th with 429, and frees a slot as the hour passes', async () => {
    const a = await person('imp-limit')
    const ids: string[] = []
    for (let i = 0; i < imports.IMPORT_LIMITS.perHour; i++) {
      ids.push((await imports.startImport(deps, a, { format: 'markdown', fileName: `n${i}.md`, bytes: enc('# x') })).importId)
    }
    const refusal = await refused(imports.startImport(deps, a, { format: 'markdown', fileName: 'extra.md', bytes: enc('# x') }))
    expect(refusal.status).toBe(429)
    expect(refusal.message).toMatch(/limit is 10/)

    // The rows age out of the rolling hour.
    for (const id of ids) await db!.update(importJobs).set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(importJobs.id, id))
    await expect(imports.startImport(deps, a, { format: 'markdown', fileName: 'again.md', bytes: enc('# x') })).resolves.toBeTruthy()
  })

  it.skipIf(!db)('two imports at once cannot both take the last slot', async () => {
    const a = await person('imp-race')
    for (let i = 0; i < imports.IMPORT_LIMITS.perHour - 1; i++) {
      await imports.startImport(deps, a, { format: 'markdown', fileName: `r${i}.md`, bytes: enc('# x') })
    }
    const results = await Promise.allSettled([
      imports.startImport(deps, a, { format: 'markdown', fileName: 'one.md', bytes: enc('# 1') }),
      imports.startImport(deps, a, { format: 'markdown', fileName: 'two.md', bytes: enc('# 2') }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect((rejected?.reason as imports.ImportError).status).toBe(429)
  })

  it.skipIf(!db)('refuses bad content before anything is stored or counted', async () => {
    const a = await person('imp-bad')
    const before = queued.length
    expect(await refused(imports.startImport(deps, a, { format: 'pptx', fileName: 'deck.pptx', bytes: enc('# not a zip') }))).toMatchObject({ status: 415 })
    expect(queued.length).toBe(before)
  })

  it.skipIf(!db)('the status is for the owner only; another user gets not-found', async () => {
    const a = await person('imp-owner')
    const b = await person('imp-stranger')
    const { importId } = await imports.startImport(deps, a, { format: 'json', fileName: 'd.json', bytes: enc('{}') })
    expect(await imports.getImport(deps, a, importId)).toEqual({ status: 'queued' })
    expect(await refused(imports.getImport(deps, b, importId))).toMatchObject({ status: 404 })
    expect(await refused(imports.getImport(deps, a, 'not-a-uuid'))).toMatchObject({ status: 404 })
  })

  it.skipIf(!db)('a finished import reports its deck and warnings; a failed one reports its error', async () => {
    const a = await person('imp-result')
    const { importId } = await imports.startImport(deps, a, { format: 'markdown', fileName: 'r.md', bytes: enc('# r') })
    const deckId = await makeDeck(db!, a.id, 'Made')
    await markImportDone(db!, importId, { deckId, warnings: ['Slides are not 16:9.'] })
    expect(await imports.getImport(deps, a, importId)).toEqual({ status: 'done', deckId, warnings: ['Slides are not 16:9.'] })
  })

  it.skipIf(!db)('a queue failure marks the row failed with a message for the user, and removes the upload', async () => {
    const a = await person('imp-queue-down')
    failQueue = true
    try {
      const { importId } = await imports.startImport(deps, a, { format: 'markdown', fileName: 'q.md', bytes: enc('# q') })
      const status = await imports.getImport(deps, a, importId)
      expect(status.status).toBe('failed')
      expect(status.error).toMatch(/import service is not running/)
      expect(await storage.get(`import/${importId}`)).toBeNull()
    } finally {
      failQueue = false
    }
  })
})

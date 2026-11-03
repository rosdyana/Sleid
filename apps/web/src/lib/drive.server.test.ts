// DriveExporter against a local fake of the Drive v3 export endpoint. Real Google is not reachable from the tests.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ImportError } from './import.server'
import { PPTX_MIME, RECONNECT_DRIVE, createDriveExporter, driveStatusError } from './drive.server'

const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 40 }, (_, i) => i)])
const FILE = 'okFileId1234567890'
const seen: Array<{ url: string; auth: string | undefined }> = []

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? ''
  seen.push({ url, auth: req.headers.authorization })
  const id = decodeURIComponent(url.split('/')[4] ?? '')
  if (!url.startsWith('/drive/v3/files/')) {
    res.writeHead(404).end()
    return
  }
  if (id === FILE) {
    res.writeHead(200, { 'content-type': PPTX_MIME, 'content-length': String(PK.byteLength) })
    res.end(PK)
  } else if (id === 'forbiddenFile123') {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 403, message: 'The user does not have sufficient permissions for this file.' } }))
  } else if (id === 'declaredBigFile1') {
    res.writeHead(200, { 'content-length': '5000' })
    res.end(Buffer.alloc(5000, 1))
  } else if (id === 'streamedBigFile1') {
    // No content-length: the body is chunked, so only the streaming cap can stop it.
    res.writeHead(200, { 'content-type': PPTX_MIME })
    res.write(Buffer.alloc(800, 2))
    res.end(Buffer.alloc(800, 2))
  } else if (id === 'htmlNotZipFile1') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>not a pptx</html>')
  } else if (id === 'missingFile12345') {
    res.writeHead(404).end()
  } else if (id === 'busyFile1234567') {
    res.writeHead(503).end()
  } else {
    res.writeHead(400).end()
  }
}

describe('DriveExporter (fake Drive server)', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer(handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('exports the file as PPTX with the bearer token and the PPTX mime type', async () => {
    const exporter = createDriveExporter({ baseUrl })
    const bytes = await exporter.exportPptx(FILE, 'token-abc')
    expect(Buffer.from(bytes).equals(PK)).toBe(true)
    const call = seen.at(-1)!
    expect(call.url).toBe(`/drive/v3/files/${FILE}/export?mimeType=${PPTX_MIME}`)
    expect(call.auth).toBe('Bearer token-abc')
  })

  it('a 403 becomes the "reconnect Google Drive" error, with status 403', async () => {
    const exporter = createDriveExporter({ baseUrl })
    const err = await exporter.exportPptx('forbiddenFile123', 'token').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).status).toBe(403)
    expect((err as ImportError).message).toBe(RECONNECT_DRIVE)
    expect((err as ImportError).message).toMatch(/reconnect google drive/i)
  })

  it('a file over the cap is refused when Drive declares its size', async () => {
    const exporter = createDriveExporter({ baseUrl, maxBytes: 1000 })
    const err = await exporter.exportPptx('declaredBigFile1', 'token').catch((e: unknown) => e)
    expect((err as ImportError).status).toBe(413)
    expect((err as ImportError).message).toMatch(/limited to/)
  })

  it('a file over the cap is refused while streaming, when there is no length', async () => {
    const exporter = createDriveExporter({ baseUrl, maxBytes: 1000 })
    const err = await exporter.exportPptx('streamedBigFile1', 'token').catch((e: unknown) => e)
    expect((err as ImportError).status).toBe(413)
  })

  it('an export that is not a zip is refused with 415', async () => {
    const exporter = createDriveExporter({ baseUrl })
    const err = await exporter.exportPptx('htmlNotZipFile1', 'token').catch((e: unknown) => e)
    expect((err as ImportError).status).toBe(415)
  })

  it('a 404, a 503 and a refused connection each get a clear message', async () => {
    const exporter = createDriveExporter({ baseUrl })
    expect((await exporter.exportPptx('missingFile12345', 't').catch((e: unknown) => e)) as ImportError).toMatchObject({ status: 404 })
    expect(((await exporter.exportPptx('busyFile1234567', 't').catch((e: unknown) => e)) as ImportError).message).toMatch(/busy/)
    const down = createDriveExporter({ baseUrl: 'http://127.0.0.1:1' })
    const err = await down.exportPptx(FILE, 't').catch((e: unknown) => e)
    expect((err as ImportError).status).toBe(502)
  })

  it('refuses a file id that is not a Drive id before any request', async () => {
    const before = seen.length
    const exporter = createDriveExporter({ baseUrl })
    const err = await exporter.exportPptx('../../etc', 't').catch((e: unknown) => e)
    expect((err as ImportError).status).toBe(400)
    expect(seen.length).toBe(before)
  })
})

describe('driveStatusError', () => {
  it('maps the statuses the user can act on', () => {
    expect(driveStatusError(401).message).toBe(RECONNECT_DRIVE)
    expect(driveStatusError(403).message).toBe(RECONNECT_DRIVE)
    expect(driveStatusError(404).status).toBe(404)
    expect(driveStatusError(400).status).toBe(415)
    expect(driveStatusError(500).status).toBe(502)
  })
})

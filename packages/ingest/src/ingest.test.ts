import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { extractFile, detectFileKind, sheetsToTables } from './extract.ts'
import { htmlToText, cleanText, stripMarkup } from './sanitize.ts'
import { chunkText } from './chunk.ts'
import { rankBm25 } from './bm25.ts'
import { buildIngested, chunksOf, relevantChunks } from './source.ts'
import { fetchPublicUrl, fetchPublicImage, extractUrl, PUBLIC_URL_POLICY } from './url.ts'
import { IngestError, LIMITS } from './limits.ts'

const enc = (s: string) => new TextEncoder().encode(s)

describe('extractors', () => {
  it('reads a CSV into a table with numeric cells as numbers', async () => {
    const r = await extractFile({ fileName: 'bills.csv', bytes: enc('Month,Before,After\nJan,120000,80000\nFeb,118000,76000\n') })
    expect(r.kind).toBe('csv')
    expect(r.tables[0]!.columns).toEqual(['Month', 'Before', 'After'])
    expect(r.tables[0]!.rows).toEqual([
      ['Jan', 120000, 80000],
      ['Feb', 118000, 76000],
    ])
    expect(r.text).toContain('Columns: Month, Before, After')
  })

  it('reads an XLSX written with SheetJS, first sheets only', async () => {
    const wb = XLSX.utils.book_new()
    for (let i = 0; i < 7; i++) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Value'], [`row${i}`, i * 10]]), `S${i}`)
    }
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
    const r = await extractFile({ fileName: 'book.xlsx', bytes })
    expect(r.tables).toHaveLength(5)
    expect(r.tables[1]!.rows[0]).toEqual(['row1', 10])
    expect(r.warnings.join(' ')).toContain('first 5 sheets')
  })

  it('cuts a sheet to 200 rows', () => {
    const rows = [['Id', 'Value'], ...Array.from({ length: 250 }, (_, i) => [i, i])]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Big')
    const { tables, warnings } = sheetsToTables(wb)
    expect(tables[0]!.rows).toHaveLength(LIMITS.maxRows)
    expect(tables[0]!.truncated).toBe(true)
    expect(warnings.join(' ')).toContain('cut to 200 rows')
  })

  it('reads a PDF generated with pdf-lib', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 200])
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    page.drawText('Solar panels cut bakery bills', { x: 20, y: 150, size: 18, font })
    page.drawText('Monthly savings were 34 percent', { x: 20, y: 110, size: 14, font })
    const bytes = await pdf.save()
    const r = await extractFile({ fileName: 'report.pdf', bytes })
    expect(r.kind).toBe('pdf')
    expect(r.text).toContain('Solar panels cut bakery bills')
  })

  it('reads a DOCX built as a minimal OOXML zip', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jakarta bakeries save power</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph &amp; more</w:t></w:r></w:p></w:body></w:document>')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const r = await extractFile({ fileName: 'memo.docx', bytes })
    expect(r.kind).toBe('docx')
    expect(r.text).toContain('Jakarta bakeries save power')
    expect(r.text).toContain('Second paragraph & more')
  })

  it('reads a PPTX: slide text and speaker notes', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Cover line</a:t></a:r></a:p></p:sld>')
    zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Second </a:t></a:r><a:r><a:t>slide</a:t></a:r></a:p></p:sld>')
    zip.file('ppt/notesSlides/notesSlide2.xml', '<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:notes>')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const r = await extractFile({ fileName: 'deck.pptx', bytes })
    expect(r.text).toContain('Slide 1:\nCover line')
    expect(r.text).toContain('Slide 2:\nSecond slide')
    expect(r.text).toContain('Notes for slide 2:\nSay hello')
  })

  it('keeps text files as they are, without markup or scripts', async () => {
    const r = await extractFile({ fileName: 'notes.md', bytes: enc('# Title\n<script>alert(1)</script>Body <b>bold</b> text') })
    expect(r.text).not.toContain('alert')
    expect(r.text).not.toContain('<b>')
    expect(r.text).toContain('Body')
  })

  it('lists an image by name and reads no text from it', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
    const r = await extractFile({ fileName: 'roof.png', bytes: png })
    expect(r.kind).toBe('image')
    expect(r.text).toBe('')
    expect(r.images).toEqual([{ fileName: 'roof.png', mime: 'image/png', bytes: 10 }])
  })

  it('refuses unknown types and files whose bytes do not match the name', async () => {
    expect(() => detectFileKind('run.exe', enc('MZ'))).toThrow(IngestError)
    expect(() => detectFileKind('report.pdf', enc('not a pdf'))).toThrow(/does not match/)
    expect(() => detectFileKind('table.csv', new Uint8Array([0x50, 0x00, 0x01]))).toThrow(/does not match/)
  })

  it('refuses a file over 20 MB before reading it', async () => {
    const big = new Uint8Array(LIMITS.maxFileBytes + 1)
    await expect(extractFile({ fileName: 'big.txt', bytes: big })).rejects.toMatchObject({ code: 'too-large' })
  })
})

describe('sanitising and sizes', () => {
  it('drops scripts, styles and frames from HTML, keeps the article text', () => {
    const html = `<html><head><title>Solar Facts</title><style>p{color:red}</style><script>steal()</script></head>
      <body><article><h1>Solar</h1><p>Solar power grows fast in Indonesia.</p><iframe src="https://evil.example"></iframe>
      <p>Panels cut bills for bakeries in Jakarta.</p></article><nav>menu links</nav></body></html>`
    const r = htmlToText(html, 'fallback')
    expect(r.title).toBe('Solar Facts')
    expect(r.text).toContain('Solar power grows fast in Indonesia.')
    expect(r.text).toContain('Panels cut bills for bakeries in Jakarta.')
    expect(r.text).not.toContain('steal')
    expect(r.text).not.toContain('evil.example')
    expect(r.text).not.toContain('color:red')
  })

  it('strips control characters and collapses blank runs', () => {
    expect(cleanText('a\u0007b\r\n\r\n\r\n\r\nc   d')).toBe('ab\n\nc d')
    expect(stripMarkup('x<script>bad()</script>y<img src=z>')).toBe('x y')
  })

  it('caps each source at 60k characters and reports the cut', () => {
    const s = buildIngested({ kind: 'file', title: 'Long', fileName: 'long.txt', text: 'word '.repeat(20000) })
    expect(s.text.length).toBe(LIMITS.maxSourceChars)
    expect(s.truncated).toBe(true)
    expect(s.warnings.join(' ')).toContain('cut to 60,000 characters')
  })

  it('chunks on paragraphs at about 6k characters', () => {
    const chunks = chunkText(`${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}\n\n${'c'.repeat(100)}`)
    // 4000 and 4100 characters: the second paragraph does not fit with the first, so two chunks.
    expect(chunks.length).toBe(2)
    expect(chunks.every((c) => c.length <= LIMITS.chunkChars)).toBe(true)
    expect(chunkText('x'.repeat(13000)).map((c) => c.length)).toEqual([6000, 6000, 1000])
  })
})

describe('BM25 ranking', () => {
  it('puts the chunk that matches the query first', () => {
    const ranked = rankBm25('solar panels bakeries', ['cats and dogs', 'bakeries buy solar panels', 'weather report'], (s) => s, 2)
    expect(ranked[0]!.item).toBe('bakeries buy solar panels')
    expect(ranked).toHaveLength(1)
  })

  it('falls back to the first chunks when nothing matches', () => {
    const ranked = rankBm25('zebra', ['one', 'two', 'three'], (s) => s, 2)
    expect(ranked.map((r) => r.item)).toEqual(['one', 'two'])
  })

  it('ranks a source with its title for the slide query', () => {
    const sources = [
      { id: 's1', ingested: buildIngested({ kind: 'file', title: 'Budget', text: 'Quarterly budget numbers.' }) },
      { id: 's2', ingested: buildIngested({ kind: 'url', title: 'Solar grants', url: 'https://x.example', text: 'Grants for rooftop solar in Jakarta.' }) },
    ]
    const top = relevantChunks('rooftop solar grants', chunksOf(sources), 1)
    expect(top[0]!.sourceId).toBe('s2')
  })
})

describe('URL fetch', () => {
  let server: Server
  let base = ''
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<html><head><title>Local page</title></head><body><article><p>A small local page about solar.</p></article></body></html>')
      }
      if (req.url === '/redirect-local') {
        res.writeHead(302, { location: '/page' })
        return res.end()
      }
      if (req.url === '/redirect-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
        return res.end()
      }
      if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' })
        return res.end()
      }
      if (req.url === '/zip') {
        res.writeHead(200, { 'content-type': 'application/zip' })
        return res.end('PK')
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        const chunk = 'x'.repeat(64 * 1024)
        let sent = 0
        const pump = () => {
          while (sent < 3 * 1024 * 1024) {
            sent += chunk.length
            if (!res.write(chunk)) return res.once('drain', pump)
          }
          res.end()
        }
        return pump()
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  // Test-only: the local server is on loopback, so the policy allows private addresses here. Link-local is still refused.
  const testPolicy = { allowPrivate: true }

  it('refuses loopback with the production policy (SSRF)', async () => {
    await expect(fetchPublicUrl(`${base}/page`)).rejects.toMatchObject({ code: 'blocked' })
  })

  it('reads an HTML page through the test policy and extracts its text', async () => {
    const fetched = await fetchPublicUrl(`${base}/page`, { policy: testPolicy })
    const r = await extractUrl(fetched, 'fallback')
    expect(r.title).toBe('Local page')
    expect(r.text).toContain('A small local page about solar.')
  })

  it('follows a redirect to a permitted address, and checks it again', async () => {
    const fetched = await fetchPublicUrl(`${base}/redirect-local`, { policy: testPolicy })
    expect(fetched.url).toBe(`${base}/page`)
  })

  it('refuses a redirect to the metadata address even when private addresses are allowed', async () => {
    await expect(fetchPublicUrl(`${base}/redirect-metadata`, { policy: testPolicy })).rejects.toMatchObject({ code: 'blocked' })
  })

  it('stops after the redirect limit', async () => {
    await expect(fetchPublicUrl(`${base}/loop`, { policy: testPolicy, maxRedirects: 3 })).rejects.toThrow(/redirected more than 3 times/)
  })

  it('refuses a content type that is not read', async () => {
    await expect(fetchPublicUrl(`${base}/zip`, { policy: testPolicy })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('cuts off a body over the size cap', async () => {
    await expect(fetchPublicUrl(`${base}/big`, { policy: testPolicy, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: 'too-large' })
  })

  it('the production policy refuses private names', () => {
    expect(PUBLIC_URL_POLICY.allowPrivate).toBe(false)
  })
})

describe('image fetch', () => {
  const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9])
  let server: Server
  let base = ''
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/logo.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG_1X1.byteLength) })
        return res.end(PNG_1X1)
      }
      if (req.url === '/page-as-image') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<html><body>not an image</body></html>')
      }
      if (req.url === '/png-named-jpeg') {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(JPEG_HEADER)
      }
      if (req.url === '/big-png') {
        // A PNG signature followed by padding, larger than the 1 KB cap used below.
        const body = Buffer.concat([PNG_1X1, Buffer.alloc(4096, 0x20)])
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.byteLength) })
        return res.end(body)
      }
      if (req.url === '/redirect-logo') {
        res.writeHead(302, { location: '/logo.png' })
        return res.end()
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const testPolicy = { allowPrivate: true }

  it('fetches a PNG and returns its type and bytes', async () => {
    const image = await fetchPublicImage(`${base}/logo.png`, { policy: testPolicy })
    expect(image.mime).toBe('image/png')
    expect(image.url).toBe(`${base}/logo.png`)
    expect(Buffer.from(image.body).equals(PNG_1X1)).toBe(true)
  })

  it('follows a redirect to the image, and checks it again', async () => {
    const image = await fetchPublicImage(`${base}/redirect-logo`, { policy: testPolicy })
    expect(image.url).toBe(`${base}/logo.png`)
  })

  it('refuses text/html', async () => {
    await expect(fetchPublicImage(`${base}/page-as-image`, { policy: testPolicy })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('refuses a PNG content type whose bytes are a JPEG', async () => {
    await expect(fetchPublicImage(`${base}/png-named-jpeg`, { policy: testPolicy })).rejects.toThrow(/does not match its declared type \(image\/png\)/)
  })

  it('refuses an image over the size cap', async () => {
    await expect(fetchPublicImage(`${base}/big-png`, { policy: testPolicy, maxBytes: 1024 })).rejects.toMatchObject({ code: 'too-large' })
  })

  it('refuses loopback with the production policy (SSRF)', async () => {
    await expect(fetchPublicImage(`${base}/logo.png`)).rejects.toMatchObject({ code: 'blocked' })
  })
})

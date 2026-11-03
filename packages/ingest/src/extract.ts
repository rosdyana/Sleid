// Text and tables from uploaded files. Every extractor works on bytes in memory and returns plain text;
// nothing is executed, and nothing is fetched from the files' own links.
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { cleanText, stripMarkup } from './sanitize.ts'
import { IngestError, LIMITS } from './limits.ts'

export type FileKind = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'text' | 'image'

export interface ExtractedTable {
  name: string
  columns: string[]
  rows: Array<Array<string | number | null>>
  /** True when the sheet had more rows than were kept. */
  truncated: boolean
}

export interface ImageRef {
  fileName: string
  mime: string
  bytes: number
}

export interface ExtractedFile {
  kind: FileKind
  title: string
  text: string
  tables: ExtractedTable[]
  images: ImageRef[]
  warnings: string[]
}

const EXTENSIONS: Record<string, FileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
  csv: 'csv',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
}

/** The kind from the file name, checked against the first bytes. Unknown or mismatched files are refused. */
export function detectFileKind(fileName: string, bytes: Uint8Array): FileKind {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const kind = EXTENSIONS[ext]
  if (!kind) throw new IngestError('unsupported', `"${fileName}" is not a supported file type. Use PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, PNG or JPG.`)
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1')
  const isZip = head.startsWith('PK')
  const ok =
    kind === 'pdf' ? head.startsWith('%PDF') :
    kind === 'docx' || kind === 'pptx' || kind === 'xlsx' ? isZip :
    kind === 'image' ? isPng(bytes) || isJpeg(bytes) :
    !isBinary(bytes)
  if (!ok) throw new IngestError('invalid', `"${fileName}" does not match its file type.`)
  return kind
}

function isPng(b: Uint8Array): boolean {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}
function isJpeg(b: Uint8Array): boolean {
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}
function isBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 2048)
  for (let i = 0; i < n; i++) if (b[i] === 0) return true
  return false
}

export function mimeForKind(kind: FileKind, fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (kind === 'image') return ext === 'png' ? 'image/png' : 'image/jpeg'
  return (
    {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv',
      text: 'text/plain',
    } as Record<string, string>
  )[kind]!
}

export function assertFileSize(bytes: Uint8Array, fileName: string): void {
  if (bytes.byteLength > LIMITS.maxFileBytes) {
    throw new IngestError('too-large', `"${fileName}" is larger than ${LIMITS.maxFileBytes / (1024 * 1024)} MB.`)
  }
}

export function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').slice(0, 200)
}

/** Decodes the XML text runs of a slide or notes part, one line per paragraph. */
export function xmlParagraphs(xml: string): string[] {
  const out: string[] = []
  for (const para of xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) ?? []) {
    const runs = [...para.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1] ?? ''))
    const line = runs.join('').trim()
    if (line) out.push(line)
  }
  return out
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf')
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: true })
  return typeof text === 'string' ? text : (text as string[]).join('\n\n')
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return result.value
}

async function extractPptx(bytes: Uint8Array): Promise<{ text: string; warnings: string[] }> {
  const zip = await JSZip.loadAsync(bytes)
  const numbered = (name: RegExp) =>
    Object.keys(zip.files)
      .filter((f) => name.test(f))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0))
  const slides = numbered(/^ppt\/slides\/slide\d+\.xml$/)
  const notes = numbered(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)
  if (slides.length === 0) throw new IngestError('invalid', 'The presentation has no slides.')
  const parts: string[] = []
  for (let i = 0; i < slides.length; i++) {
    const lines = xmlParagraphs(await zip.files[slides[i]!]!.async('string'))
    parts.push(`Slide ${i + 1}:\n${lines.join('\n')}`)
  }
  for (const name of notes) {
    const lines = xmlParagraphs(await zip.files[name]!.async('string'))
    // notesSlideN belongs to slide N.
    const number = name.match(/(\d+)\.xml$/)?.[1] ?? '?'
    if (lines.length) parts.push(`Notes for slide ${number}:\n${lines.join('\n')}`)
  }
  return { text: parts.join('\n\n'), warnings: [] }
}

function toNumber(value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const s = String(value).trim()
  const n = Number(s.replace(/,/g, ''))
  return s !== '' && /^-?[\d.,]+%?$/.test(s) && Number.isFinite(n) ? n : s
}

/** First sheets only, first rows only. Numeric cells become numbers. */
export function sheetsToTables(workbook: XLSX.WorkBook): { tables: ExtractedTable[]; warnings: string[] } {
  const warnings: string[] = []
  const names = workbook.SheetNames.slice(0, LIMITS.maxSheets)
  if (workbook.SheetNames.length > names.length) warnings.push(`Only the first ${names.length} sheets were read.`)
  const tables: ExtractedTable[] = []
  for (const name of names) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false })
    if (raw.length === 0) continue
    const header = (raw[0] ?? []).map((h, i) => (h === null || h === undefined || String(h).trim() === '' ? `Column ${i + 1}` : String(h).trim()))
    const body = raw.slice(1, 1 + LIMITS.maxRows).map((row) => header.map((_, i) => toNumber(row[i])))
    tables.push({ name, columns: header, rows: body, truncated: raw.length - 1 > LIMITS.maxRows })
    if (raw.length - 1 > LIMITS.maxRows) warnings.push(`Sheet "${name}" was cut to ${LIMITS.maxRows} rows.`)
  }
  return { tables, warnings }
}

function tableSummary(tables: ExtractedTable[]): string {
  return tables
    .map((t) => {
      const head = `Table "${t.name}" (${t.rows.length} rows${t.truncated ? ', cut' : ''}). Columns: ${t.columns.join(', ')}.`
      const sample = t.rows.slice(0, 5).map((r) => r.map((c) => (c === null ? '' : String(c))).join(' | '))
      return [head, ...sample].join('\n')
    })
    .join('\n\n')
}

async function extractSpreadsheet(bytes: Uint8Array): Promise<{ tables: ExtractedTable[]; text: string; warnings: string[] }> {
  const workbook = XLSX.read(bytes, { type: 'array', cellFormula: false, cellHTML: false })
  const { tables, warnings } = sheetsToTables(workbook)
  if (tables.length === 0) throw new IngestError('invalid', 'The spreadsheet has no data.')
  return { tables, text: tableSummary(tables), warnings }
}

/**
 * Extracts text and tables from a file. The text is cleaned but not yet capped; the caller uses `buildSource`
 * to cap and chunk it.
 */
export async function extractFile(input: { fileName: string; bytes: Uint8Array }): Promise<ExtractedFile> {
  const { fileName, bytes } = input
  assertFileSize(bytes, fileName)
  const kind = detectFileKind(fileName, bytes)
  const title = baseName(fileName)
  const warnings: string[] = []
  switch (kind) {
    case 'pdf':
      return { kind, title, text: cleanText(await extractPdf(bytes)), tables: [], images: [], warnings }
    case 'docx':
      return { kind, title, text: cleanText(await extractDocx(bytes)), tables: [], images: [], warnings }
    case 'pptx': {
      const r = await extractPptx(bytes)
      return { kind, title, text: cleanText(r.text), tables: [], images: [], warnings: r.warnings }
    }
    case 'xlsx':
    case 'csv': {
      const r = await extractSpreadsheet(bytes)
      return { kind, title, text: cleanText(r.text), tables: r.tables, images: [], warnings: r.warnings }
    }
    case 'text': {
      const raw = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
      return { kind, title, text: stripMarkup(raw), tables: [], images: [], warnings }
    }
    case 'image':
      // No OCR. The image is listed by name and can be used as an image placeholder.
      return {
        kind,
        title,
        text: '',
        tables: [],
        images: [{ fileName: title, mime: mimeForKind(kind, title), bytes: bytes.byteLength }],
        warnings: ['Images are not read as text. The file name is listed as an image reference.'],
      }
  }
}

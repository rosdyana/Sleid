// Pure export contract, shared by the editor (browser), the web server and the worker.
// No Node or database imports here, so the browser bundle can use it.
import { z } from 'zod'

export const EXPORT_FORMATS = ['pdf', 'png', 'jpg', 'pptx', 'html', 'markdown', 'json'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]
export const EXPORT_STATUSES = ['queued', 'running', 'done', 'failed'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]

export const EXPORT_SCALES = [0.5, 1, 2] as const

const PdfOptions = z.object({
  /** One extra page per slide that has speaker notes (reveal showNotes: 'separate-page'). */
  includeNotes: z.boolean().default(false),
  includeHidden: z.boolean().default(false),
})

const VisualOptions = z.object({
  /** Export only this slide (one image, not a zip). Omit for every visible slide. */
  slideId: z.string().min(1).max(100).optional(),
  scale: z.union([z.literal(0.5), z.literal(1), z.literal(2)]).default(1),
  includeHidden: z.boolean().default(false),
})

const Empty = z.object({})

const deckId = z.uuid()

/** What the editor sends to start an export. Each format takes its own options. */
export const StartExportSchema = z.discriminatedUnion('format', [
  z.object({ deckId, format: z.literal('pdf'), options: PdfOptions.prefault({}) }),
  z.object({ deckId, format: z.enum(['png', 'jpg']), options: VisualOptions.prefault({}) }),
  z.object({ deckId, format: z.literal('pptx'), options: Empty.prefault({}) }),
  z.object({ deckId, format: z.literal('html'), options: Empty.prefault({}) }),
  z.object({ deckId, format: z.literal('markdown'), options: Empty.prefault({}) }),
  z.object({ deckId, format: z.literal('json'), options: Empty.prefault({}) }),
])
export type StartExportInput = z.input<typeof StartExportSchema>
export type StartExportParsed = z.output<typeof StartExportSchema>

/** Payload of a queued export job. The worker loads the row for everything else. */
export const ExportJobPayloadSchema = z.object({ exportId: z.uuid() })
export type ExportJobPayload = z.infer<typeof ExportJobPayloadSchema>

export interface FormatFile {
  extension: string
  contentType: string
}

/** File type of each format. PNG and JPG are zipped when there is more than one slide. */
export function formatFile(format: ExportFormat, multiple = false): FormatFile {
  switch (format) {
    case 'pdf':
      return { extension: 'pdf', contentType: 'application/pdf' }
    case 'pptx':
      return { extension: 'pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    case 'html':
      return { extension: 'html.zip', contentType: 'application/zip' }
    case 'markdown':
      return { extension: 'md', contentType: 'text/markdown; charset=utf-8' }
    case 'json':
      return { extension: 'sleid.json', contentType: 'application/json; charset=utf-8' }
    case 'png':
    case 'jpg':
      if (multiple) return { extension: `${format}.zip`, contentType: 'application/zip' }
      return { extension: format, contentType: format === 'png' ? 'image/png' : 'image/jpeg' }
  }
}

/** A file name that is safe on every OS: no path separators or control characters, at most 80 characters. */
export function safeFileBase(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim()
  return cleaned || 'deck'
}

export function exportFileName(title: string, format: ExportFormat, multiple = false, slideNumber?: number): string {
  const base = safeFileBase(title)
  if (slideNumber !== undefined) {
    const ext = formatFile(format).extension
    return `${base} - slide ${slideNumber}.${ext}`
  }
  return `${base}.${formatFile(format, multiple).extension}`
}

/** Content-Disposition for a download. ASCII fallback plus RFC 5987 filename* for the real name. */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

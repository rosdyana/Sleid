// Reading and checking a deck: get_deck (outline, compact or json), lint_deck, the renders (one slide, a contact sheet, or
// several slides) and the export link.
import JSZip from 'jszip'
import { z } from 'zod'
import { StartExportSchema, createExportJob, issueExportLink } from '@sleid/db'
import { lintDeck, type Issue } from '@sleid/compose'
import { ToolError } from '../errors.ts'
import { asText, deckIdField, enqueueExport, slideRef, waitForExport, type Output, type ServerContext } from '../call.ts'
import { outlineOf, pngSize, resolveSlide, selectSlides } from '../compile.ts'
import { compactDeck } from '../compact.ts'
import type { McpDeps } from '../deps.ts'

const EXPORT_FORMAT_MAP = { pdf: 'pdf', pptx: 'pptx', png: 'png', html: 'html', md: 'markdown', json: 'json' } as const
/** Slides per call in render_deck slides mode. */
const MAX_RENDER_SLIDES = 10
/** Contact sheets take longer than one slide, so they get this many times the render timeout. */
const SHEET_TIMEOUT_FACTOR = 3

const slideIdsField = z.array(z.string().min(1).max(100)).min(1).max(40).optional()

/** The PNG bytes of a finished export, with its size, or a tool error when it failed or is missing. */
async function finishedPng(deps: McpDeps, exportId: string, timeoutMs: number, what: string): Promise<{ bytes: Uint8Array; width: number | null; height: number | null }> {
  const row = await waitForExport(deps, exportId, timeoutMs)
  if (row.status === 'failed') throw new ToolError(`The ${what} could not be rendered: ${row.error ?? 'unknown error'}`)
  if (row.status !== 'done') throw new ToolError(`The ${what} took longer than ${Math.round(timeoutMs / 1000)} seconds. It is still queued, so try again in a moment.`)
  const bytes = await deps.exportStorage.get(exportId)
  if (!bytes) throw new ToolError(`The ${what} finished but its file is missing. Try again.`)
  const size = pngSize(bytes)
  return { bytes, width: size?.width ?? null, height: size?.height ?? null }
}

export function registerInspectTools(ctx: ServerContext): void {
  const { tool, deps, principal } = ctx

  tool(
    'get_deck',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'Read a deck. format "outline" (default) lists each slide by 0-based index with its id, layout, title, notes and every element (id, type, position, short text). format "compact" is the whole deck as JSON with the defaults left out and text as markdown (**bold**, "- " bullets), images and icon paths summarised, and repeated text styles, shape paints and image sources in the styles, paints and images tables at its top (elements refer to them by key; an animation reads "effect/order"): the best format to read a built deck. format "json" is the full deck document. slideIds or range {from, to} (0-based, inclusive) read only some of the slides; the indexes stay the deck\'s indexes. includeVectors keeps the icon paths in compact.',
      shape: {
        deckId: deckIdField,
        format: z.enum(['outline', 'json', 'compact']).default('outline'),
        slideIds: z.array(z.string().min(1).max(100)).max(100).optional(),
        range: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
        includeVectors: z.boolean().optional(),
      },
    },
    async (args, call) => {
      const deck = await call.read(args.deckId)
      const selection = { slideIds: args.slideIds, range: args.range }
      if (args.format === 'compact') {
        return { content: [{ type: 'text', text: JSON.stringify(compactDeck(deck, { ...selection, includeVectors: args.includeVectors })) }] }
      }
      if (args.format === 'json') {
        const chosen = args.slideIds || args.range ? { ...deck, slides: selectSlides(deck, selection).map((p) => p.slide) } : deck
        return asText(chosen)
      }
      return asText(outlineOf(deck, selection))
    },
  )

  tool(
    'lint_deck',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'Check a deck for what a reader would see: text that overflows its box, text that overlaps text or a picture, elements off the slide, low-contrast text, images and charts without alt text, and missing secondary-language lines. ok is true when there are no errors and no warnings (info is not a failure). Each issue has its slideId, elementId and a fix. Run it after building, and fix what it reports.',
      shape: {
        deckId: deckIdField,
        slideIds: z.array(z.string().min(1).max(100)).max(100).optional().describe('Only these slides. Default: all.'),
      },
    },
    async (args, call) => {
      const deck = await call.read(args.deckId)
      const issues: Issue[] = lintDeck(deck, { slideIds: args.slideIds })
      const counts = { error: 0, warning: 0, info: 0 }
      for (const issue of issues) counts[issue.severity] += 1
      return asText({ ok: counts.error + counts.warning === 0, counts, issues })
    },
  )

  tool(
    'render_slide',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'Render one slide to a PNG and return it as an image, so you can check the layout. Give slideId or index. Waits up to 30 seconds for the render.',
      shape: {
        deckId: deckIdField,
        ...slideRef,
        scale: z.union([z.literal(0.5), z.literal(1), z.literal(2)]).optional().describe('1 is 1920 by 1080. Default 1.'),
      },
    },
    async (args, call) => {
      const deck = await call.read(args.deckId)
      const slide = resolveSlide(deck, args)
      const index = deck.slides.findIndex((s) => s.id === slide.id)
      const parsed = StartExportSchema.parse({ deckId: args.deckId, format: 'png', options: { slideId: slide.id, scale: args.scale ?? 1 } })
      const exportId = await createExportJob(deps.db, { deckId: args.deckId, userId: principal.userId, format: 'png', options: parsed.options as Record<string, unknown> })
      await enqueueExport(deps, exportId)
      const row = await waitForExport(deps, exportId, deps.renderTimeoutMs)
      if (row.status === 'failed') throw new ToolError(`The slide could not be rendered: ${row.error ?? 'unknown error'}`)
      if (row.status !== 'done') throw new ToolError('The render took longer than 30 seconds. It is still queued, so try render_slide again in a moment.')
      const bytes = await deps.exportStorage.get(exportId)
      if (!bytes) throw new ToolError('The render finished but its file is missing. Try again.')
      const size = pngSize(bytes)
      return {
        content: [
          { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify({ slideId: slide.id, slideIndex: index, width: size?.width ?? null, height: size?.height ?? null, exportId }) },
        ],
      }
    },
  )

  tool(
    'render_deck',
    {
      scope: 'decks:read',
      readOnly: true,
      description:
        'See the deck as pictures. mode "sheet" (default) returns one contact sheet image with every slide (or slideIds), in columns of the given width (default 4). mode "slides" returns one PNG per slide (slideIds, up to 10; default the first 10), each at half size, with a text list of which picture is which slide. Use it after lint_deck to check the layout. Waits up to about 90 seconds for a sheet and 30 for slides.',
      shape: {
        deckId: deckIdField,
        slideIds: slideIdsField,
        mode: z.enum(['sheet', 'slides']).default('sheet'),
        columns: z.number().int().min(1).max(8).optional(),
      },
    },
    async (args, call): Promise<Output> => {
      const deck = await call.read(args.deckId)
      if (args.mode === 'sheet') {
        const chosen = selectSlides(deck, { slideIds: args.slideIds })
        const exportId = await createExportJob(deps.db, {
          deckId: args.deckId,
          userId: principal.userId,
          format: 'png',
          options: { contactSheet: true, columns: args.columns ?? 4, ...(args.slideIds ? { slideIds: args.slideIds } : {}) },
        })
        await enqueueExport(deps, exportId)
        const png = await finishedPng(deps, exportId, deps.renderTimeoutMs * SHEET_TIMEOUT_FACTOR, 'contact sheet')
        return {
          content: [
            { type: 'image', data: Buffer.from(png.bytes).toString('base64'), mimeType: 'image/png' },
            {
              type: 'text',
              text: JSON.stringify({ mode: 'sheet', exportId, width: png.width, height: png.height, columns: args.columns ?? 4, slides: chosen.map((p) => ({ slideIndex: p.index, slideId: p.slide.id })) }),
            },
          ],
        }
      }

      const chosen = args.slideIds ? selectSlides(deck, { slideIds: args.slideIds }) : deck.slides.slice(0, MAX_RENDER_SLIDES).map((slide, index) => ({ slide, index }))
      if (chosen.length > MAX_RENDER_SLIDES) throw new ToolError(`slides mode renders at most ${MAX_RENDER_SLIDES} slides per call. Give fewer slideIds, or use mode sheet.`)
      if (chosen.length === 0) throw new ToolError('The deck has no slides to render.')
      const ids = chosen.map((p) => p.slide.id)
      const exportId = await createExportJob(deps.db, {
        deckId: args.deckId,
        userId: principal.userId,
        format: 'png',
        options: { slideIds: ids, scale: 0.5 },
      })
      await enqueueExport(deps, exportId)
      const row = await waitForExport(deps, exportId, deps.renderTimeoutMs)
      if (row.status === 'failed') throw new ToolError(`The slides could not be rendered: ${row.error ?? 'unknown error'}`)
      if (row.status !== 'done') throw new ToolError('The render took longer than 30 seconds. It is still queued, so try render_deck again in a moment.')
      const bytes = await deps.exportStorage.get(exportId)
      if (!bytes) throw new ToolError('The render finished but its file is missing. Try again.')
      const files = await pictures(bytes)
      const content: Output['content'] = []
      const list: Array<{ slideIndex: number; slideId: string; file: string }> = []
      files.forEach((file) => {
        // A single slide comes back as one PNG (no zip, no number in the name): it is the one that was asked for.
        const number = files.length === 1 ? chosen[0]!.index + 1 : Number(/(\d+)\.png$/.exec(file.name)?.[1] ?? 0)
        const slide = deck.slides[number - 1]
        if (!slide) return
        content.push({ type: 'image', data: Buffer.from(file.bytes).toString('base64'), mimeType: 'image/png' })
        list.push({ slideIndex: number - 1, slideId: slide.id, file: file.name })
      })
      content.push({ type: 'text', text: JSON.stringify({ mode: 'slides', exportId, slides: list }) })
      return { content }
    },
  )

  tool(
    'export_deck',
    {
      scope: 'exports',
      description:
        'Start an export: pdf, pptx, png (one PNG per slide, zipped when there are several), html, md or json. Returns a one-time download URL valid for 15 minutes. GET it: 409 means still rendering, so try again shortly. A finished file downloads once.',
      shape: {
        deckId: deckIdField,
        format: z.enum(['pdf', 'pptx', 'png', 'html', 'md', 'json']),
      },
    },
    async (args, call) => {
      await call.role(args.deckId, 'viewer')
      const format = EXPORT_FORMAT_MAP[args.format]
      const exportId = await createExportJob(deps.db, { deckId: args.deckId, userId: principal.userId, format, options: {} })
      const link = await issueExportLink(deps.db, exportId)
      await enqueueExport(deps, exportId)
      return asText({
        exportId,
        format: args.format,
        status: 'queued',
        downloadUrl: `${deps.publicUrl}/api/exports/${exportId}/file?token=${link.secret}`,
        expiresAt: link.expiresAt.toISOString(),
        note: 'The link is single-use and valid for 15 minutes. Do not share it.',
      })
    },
  )
}

/** The PNG files of a render: the bytes as they are when it is one PNG, or each entry of the zip, in name order. */
async function pictures(bytes: Uint8Array): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  if (pngSize(bytes)) return [{ name: 'slide.png', bytes }]
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files).filter((n) => n.endsWith('.png')).sort()
  const out: Array<{ name: string; bytes: Uint8Array }> = []
  for (const name of names) out.push({ name, bytes: await zip.file(name)!.async('uint8array') })
  return out
}

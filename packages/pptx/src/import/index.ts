// PPTX to a Sleid deck. Pure: no database, no network. Images stay as data URLs; the
// caller moves them into the asset store when it saves the deck.
import { createDeck, DeckSchema, newId, summariseIssues, type Deck, type Slide } from '@sleid/model'
import { parseTheme, toDeckTheme, type ParsedTheme } from './theme.ts'
import { convertSlide, fitFor, readNotes, type Fit, type SlideEnv } from './slide.ts'
import { attr, child, childrenNamed, firstDescendant, numAttr, textOf, type XNode } from './xml.ts'
import { readPart, relationshipsOf, relOfType, type Relationships } from './package.ts'
import { DEFAULT_IMPORT_LIMITS, openPackage, PptxImportError, type ImportLimits, type PackageFiles } from './zip.ts'

export { DEFAULT_IMPORT_LIMITS, PptxImportError, type ImportLimits } from './zip.ts'

/** Largest picture or background the importer keeps. Same cap as the editor's image upload. */
export const MAX_IMPORT_IMAGE_BYTES = 10 * 1024 * 1024

export interface PptxToDeckOptions {
  /** Deck title. Defaults to the file's title property, then the first slide's title. */
  title?: string
  /** Tests lower these to exercise the caps. */
  limits?: Partial<ImportLimits>
  maxImageBytes?: number
}

export interface PptxToDeckResult {
  deck: Deck
  warnings: string[]
}

const DEFAULT_EMU = { cx: 12192000, cy: 6858000 }

async function layoutInfo(files: PackageFiles, slideRels: Relationships): Promise<{ root: XNode; rels: Relationships } | undefined> {
  const rel = relOfType(slideRels, '/slideLayout')
  if (!rel) return undefined
  const root = await readPart(files, rel.target)
  if (!root) return undefined
  return { root, rels: await relationshipsOf(files, rel.target) }
}

async function masterInfo(files: PackageFiles, layoutRels: Relationships): Promise<{ root: XNode; rels: Relationships } | undefined> {
  const rel = relOfType(layoutRels, '/slideMaster')
  if (!rel) return undefined
  const root = await readPart(files, rel.target)
  if (!root) return undefined
  return { root, rels: await relationshipsOf(files, rel.target) }
}

async function themeOf(files: PackageFiles, masterRels: Relationships): Promise<ParsedTheme | undefined> {
  const rel = relOfType(masterRels, '/theme')
  if (!rel) return undefined
  const root = await readPart(files, rel.target)
  return root ? parseTheme(root) : undefined
}

function titleOf(slide: Omit<Slide, 'id'>): string {
  const el = slide.elements.find((e) => e.type === 'text' && e.role === 'title')
  if (!el || el.type !== 'text') return ''
  return (el.content.content ?? [])
    .map((p) => (p.content ?? []).map((n) => (n.type === 'text' ? (n.text ?? '') : '')).join(''))
    .join(' ')
    .trim()
    .slice(0, 200)
}

/** The deck for a PPTX file. Throws PptxImportError for a file it cannot read at all. */
export async function pptxToDeck(buf: Uint8Array, options: PptxToDeckOptions = {}): Promise<PptxToDeckResult> {
  const limits: ImportLimits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits }
  const files = await openPackage(buf, limits)
  const warnings: string[] = []

  const presentation = await readPart(files, 'ppt/presentation.xml')
  if (!presentation) {
    throw new PptxImportError('This zip file is not a PowerPoint presentation (ppt/presentation.xml is missing).')
  }
  const presRels = await relationshipsOf(files, 'ppt/presentation.xml')

  const sz = firstDescendant(presentation, 'sldSz')
  const cx = numAttr(sz, 'cx') ?? DEFAULT_EMU.cx
  const cy = numAttr(sz, 'cy') ?? DEFAULT_EMU.cy
  if (cx <= 0 || cy <= 0) throw new PptxImportError('The presentation has an invalid slide size.')
  const fit: Fit = fitFor(cx, cy)
  if (Math.abs(cx / cy - 16 / 9) > 0.01) {
    const inches = (v: number) => (Math.round((v / 914400) * 100) / 100).toString()
    warnings.push(
      `The slides are ${inches(cx)} × ${inches(cy)} in, not 16:9. They were fitted and centred on the 1920 × 1080 canvas.`,
    )
  }

  const slideParts: string[] = []
  for (const sldId of childrenNamed(child(presentation, 'sldIdLst'), 'sldId')) {
    const rel = presRels.get(attr(sldId, 'r:id') ?? '')
    if (rel && !rel.external) slideParts.push(rel.target)
  }
  if (slideParts.length === 0) throw new PptxImportError('The presentation has no slides.')

  // The theme comes from the first slide's master. Slides without one keep the default.
  const firstRels = await relationshipsOf(files, slideParts[0]!)
  const firstLayout = await layoutInfo(files, firstRels)
  const firstMaster = firstLayout ? await masterInfo(files, firstLayout.rels) : undefined
  const parsedTheme = firstMaster ? await themeOf(files, firstMaster.rels) : undefined
  const theme = toDeckTheme(parsedTheme)

  const env: SlideEnv = {
    files,
    fit,
    theme,
    parsedTheme,
    maxImageBytes: options.maxImageBytes ?? MAX_IMPORT_IMAGE_BYTES,
    warnings,
  }

  const slides: Omit<Slide, 'id'>[] = []
  for (let i = 0; i < slideParts.length; i++) {
    const part = slideParts[i]!
    const root = await readPart(files, part)
    if (!root) {
      warnings.push(`Slide ${i + 1} is missing from the file, so it was left out.`)
      continue
    }
    const rels = await relationshipsOf(files, part)
    const layout = await layoutInfo(files, rels)
    const master = layout ? await masterInfo(files, layout.rels) : undefined
    const notes = await readNotes(files, rels, env)
    const result = await convertSlide(root, rels, layout, master, env, i + 1, notes)
    slides.push(result.slide)
  }

  const core = await readPart(files, 'docProps/core.xml')
  const coreTitle = core ? textOf(firstDescendant(core, 'title')).trim() : ''
  const firstTitle = slides.map(titleOf).find((t) => t.length > 0) ?? ''
  const title = (options.title ?? (coreTitle || firstTitle || 'Imported presentation')).slice(0, 200)

  const base = createDeck(title)
  const candidate: Deck = {
    ...base,
    title,
    theme,
    slides: slides.map((s) => ({ ...s, id: newId() })),
  }
  const parsed = DeckSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new PptxImportError(`The presentation could not be converted: ${summariseIssues(parsed.error.issues)}`)
  }
  return { deck: parsed.data, warnings }
}

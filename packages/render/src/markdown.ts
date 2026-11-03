// Reveal-style Markdown export and import. Covers the basic content only:
// titles, paragraphs, bullet and numbered lists, headings in the body, bold,
// italic, code, links, images, code and Mermaid fences, pipe tables, and Note:
// speaker notes. Charts export as tables and import back as table elements.
// Slide backgrounds, transitions, animations and positions are not kept.
import {
  DeckSchema,
  DEFAULT_THEME,
  cloneTheme,
  createDeck,
  createSlide,
  newId,
  type Deck,
  type Element,
  type RichMark,
  type RichNode,
  type RichText,
  type Slide,
  type Theme,
} from '@sleid/model'
import { safeHref } from './html.ts'

// ---------------------------------------------------------------------------
// Deck to Markdown
// ---------------------------------------------------------------------------

export function deckToMarkdown(deck: Deck): string {
  return `${deck.slides.map(slideToMarkdown).join('\n\n---\n\n')}\n`
}

function slideToMarkdown(slide: Slide): string {
  const blocks: string[] = []
  const elements = [...slide.elements].sort((a, b) => a.z - b.z)
  for (const el of elements) {
    switch (el.type) {
      case 'text':
        if (el.role === 'title') {
          const title = inlineOf(el.content?.content ?? [])
          if (title) blocks.push(`# ${title}`)
        } else {
          blocks.push(...richBlocks(el.content))
        }
        break
      case 'shape':
        if (el.text) blocks.push(...richBlocks(el.text))
        break
      case 'chart':
        blocks.push(tableMarkdown(el.data.columns, el.data.rows.map((r) => r.map((c) => (c === null ? '' : String(c))))))
        break
      case 'table':
        if (el.rows.length > 0) blocks.push(tableMarkdown(el.rows[0] ?? [], el.rows.slice(1)))
        break
      case 'code':
        blocks.push(`\`\`\`${el.language}\n${el.code}\n\`\`\``)
        break
      case 'diagram':
        blocks.push(`\`\`\`mermaid\n${el.source}\n\`\`\``)
        break
      case 'image':
        if (el.src) blocks.push(`![${el.alt ?? ''}](${el.src})`)
        break
      case 'embed':
        blocks.push(`[${el.url}](${el.url})`)
        break
    }
  }
  const notes = slide.notes.trim()
  if (notes) blocks.push(`Note: ${notes}`)
  // Empty blocks (for example an empty list) would leave stray blank lines behind.
  return blocks.filter((b) => b.trim() !== '').join('\n\n')
}

function richBlocks(doc: RichText | undefined): string[] {
  if (!doc) return []
  return (doc.content ?? []).flatMap(blockOf)
}

function blockOf(node: RichNode): string[] {
  switch (node.type) {
    case 'paragraph': {
      const text = inlineOf(node.content ?? [])
      return text ? [text] : []
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 2), 2), 6)
      return [`${'#'.repeat(level)} ${inlineOf(node.content ?? [])}`]
    }
    case 'bulletList':
      return [listMarkdown(node, 0, false)]
    case 'orderedList':
      return [listMarkdown(node, 0, true)]
    case 'blockquote':
      return [inlineOf(node.content ?? []).split('\n').map((l) => `> ${l}`).join('\n')]
    case 'codeBlock':
      return [`\`\`\`\n${inlineOf(node.content ?? [], false)}\n\`\`\``]
    default:
      return []
  }
}

function listMarkdown(list: RichNode, depth: number, ordered: boolean): string {
  const lines: string[] = []
  ;(list.content ?? []).forEach((item, index) => {
    const marker = ordered ? `${index + 1}.` : '-'
    const indent = '  '.repeat(depth)
    const children = item.content ?? []
    const text = children
      .filter((c) => c.type === 'paragraph' || c.type === 'heading')
      .map((c) => inlineOf(c.content ?? []))
      .filter(Boolean)
      .join(' ')
    lines.push(`${indent}${marker} ${text}`)
    for (const child of children) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        lines.push(listMarkdown(child, depth + 1, child.type === 'orderedList'))
      }
    }
  })
  return lines.join('\n')
}

// Inline text with bold, italic, code and link marks. Other marks are dropped.
function inlineOf(nodes: RichNode[], trim = true): string {
  const text = nodes
    .map((node) => {
      if (node.type === 'text') return markText(node.text ?? '', node.marks ?? [])
      if (node.type === 'hardBreak') return ' '
      if (node.content) return inlineOf(node.content)
      return ''
    })
    .join('')
  return trim ? text.trim() : text
}

function markText(text: string, marks: RichMark[]): string {
  if (marks.some((m) => m.type === 'code')) return `\`${text}\``
  let out = text
  for (const mark of marks) {
    if (mark.type === 'bold') out = `**${out}**`
    if (mark.type === 'italic') out = `*${out}*`
    if (mark.type === 'link') {
      const href = safeHref(mark.attrs.href)
      if (href) out = `[${out}](${href})`
    }
  }
  return out
}

function tableMarkdown(header: string[], rows: string[][]): string {
  const cell = (c: string) => c.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const width = Math.max(header.length, ...rows.map((r) => r.length), 1)
  const pad = (cells: string[]) => Array.from({ length: width }, (_, i) => cell(cells[i] ?? ''))
  const head = `| ${pad(header).join(' | ')} |`
  const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${pad(r).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

// ---------------------------------------------------------------------------
// Markdown to deck
// ---------------------------------------------------------------------------

export interface MarkdownImportOptions {
  // Deck title. Defaults to the first slide's title, then "Untitled deck".
  title?: string
  theme?: Theme
}

// Slides are split on lines that are exactly "---". Empty blocks still make a
// slide, so the slide count survives a round trip.
export function markdownToDeck(md: string, options: MarkdownImportOptions = {}): Deck {
  const theme = cloneTheme(options.theme ?? DEFAULT_THEME)
  const front = frontMatter(md.replace(/\r\n/g, '\n'))
  const blocks = splitSlides(front.body)
  const slides = blocks.map((block) => parseSlide(block, theme))
  const firstTitle = slides.map(titleOf).find((t) => t.length > 0)
  const base = createDeck(options.title ?? front.title ?? firstTitle ?? 'Untitled deck')
  return DeckSchema.parse({ ...base, theme, slides })
}

// A `title:` line in a front-matter block at the top of the file names the deck. The block is
// only taken as front matter when every line in it is `key: value`. Otherwise it is slide content.
function frontMatter(md: string): { title?: string; body: string } {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(md)
  if (!match) return { body: md }
  const fields = (match[1] ?? '').split('\n')
  if (!fields.every((line) => line.trim() === '' || /^[A-Za-z_][\w-]*:/.test(line.trim()))) return { body: md }
  const titleLine = fields.map((line) => /^title:\s*(.*)$/.exec(line.trim())).find((m) => m !== null)
  const title = titleLine?.[1]?.trim().replace(/^["']|["']$/g, '').trim()
  return { title: title || undefined, body: md.slice(match[0].length) }
}

// Slides are split on lines that are exactly "---" or "--" (a vertical separator flattens into the
// same sequence). A file with no separator is split on its level 1 and 2 headings instead, so a
// plain Markdown document becomes one slide per section. A file with neither stays one slide.
function splitSlides(text: string): string[] {
  if (/^(?:---|--)[ \t]*$/m.test(text)) return text.split(/^(?:---|--)[ \t]*$/m)
  const lines = text.split('\n')
  const blocks: string[][] = []
  let fenced = false
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced
    const heading = !fenced && /^(#{1,2})\s+\S/.exec(line)
    if (heading) {
      // A level 2 heading becomes the slide's title, the same as a level 1 heading.
      blocks.push([line.replace(/^##\s+/, '# ')])
    } else {
      if (blocks.length === 0) blocks.push([])
      blocks[blocks.length - 1]!.push(line)
    }
  }
  const hasHeading = lines.some((line) => /^#{1,2}\s+\S/.test(line))
  if (!hasHeading) return [text]
  return blocks.map((b) => b.join('\n'))
}

function titleOf(slide: Slide): string {
  const title = slide.elements.find((e): e is Extract<Element, { type: 'text' }> => e.type === 'text' && e.role === 'title')
  return title ? plainText(title.content.content ?? []) : ''
}

function plainText(nodes: RichNode[]): string {
  return nodes
    .map((n) => (n.type === 'text' ? (n.text ?? '') : n.content ? plainText(n.content) : ''))
    .join('')
    .trim()
}

const BODY_X = 120
const BODY_Y = 272
const BODY_W = 1680
const BODY_H = 728

function parseSlide(block: string, theme: Theme): Slide {
  const lines = trimBlankLines(block.split('\n'))
  const slide = createSlide('title-content', theme)

  let title: RichNode[] | undefined
  const bodyNodes: RichNode[] = []
  const extras: Element[] = []
  const notesLines: string[] = []
  let inNotes = false

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (inNotes) {
      notesLines.push(line)
      i++
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const noteMatch = /^Note:\s?(.*)$/.exec(line)
    if (noteMatch) {
      inNotes = true
      notesLines.push(noteMatch[1] ?? '')
      i++
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      if (level === 1 && title === undefined) {
        title = parseInline(heading[2] ?? '')
      } else {
        bodyNodes.push({ type: 'heading', attrs: { level: Math.max(level, 1) }, content: parseInline(heading[2] ?? '') })
      }
      i++
      continue
    }

    const fence = /^```\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i++
      }
      i++ // closing fence
      const lang = fence[1] ?? ''
      if (lang === 'mermaid') extras.push(makeElement({ type: 'diagram', source: body.join('\n') }))
      else extras.push(makeElement({ type: 'code', code: body.join('\n'), language: lang }))
      continue
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line.trim())
    if (image) {
      extras.push(makeElement({ type: 'image', src: image[2] ?? '', fit: 'contain', alt: image[1] ?? '' }))
      i++
      continue
    }

    const embed = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(line.trim())
    if (embed && embed[1] === embed[2]) {
      extras.push(makeElement({ type: 'embed', url: embed[2] ?? '' }))
      i++
      continue
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1] ?? '')) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = [header]
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(splitRow(lines[i] ?? ''))
        i++
      }
      const width = Math.max(...rows.map((r) => r.length))
      const normalized = rows.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? ''))
      extras.push(makeElement({ type: 'table', rows: normalized, header: true }))
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: RichNode[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push(listItem(String(lines[i]).replace(/^\s*[-*+]\s+/, '')))
        i++
      }
      bodyNodes.push({ type: 'bulletList', content: items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: RichNode[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push(listItem(String(lines[i]).replace(/^\s*\d+[.)]\s+/, '')))
        i++
      }
      bodyNodes.push({ type: 'orderedList', content: items })
      continue
    }

    // Paragraph: consecutive plain lines, with a leading "> " stripped.
    const para: string[] = []
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,6}\s|```|!\[|\s*[-*+]\s|\s*\d+[.)]\s|Note:)/.test(lines[i] ?? '') &&
      !(lines[i] ?? '').trim().startsWith('|')
    ) {
      para.push((lines[i] ?? '').replace(/^>\s?/, ''))
      i++
    }
    if (para.length > 0) bodyNodes.push({ type: 'paragraph', content: parseInline(para.join(' ')) })
  }

  const notes = trimTrailingBlank(notesLines).join('\n')
  const elements = slide.elements.map((el) => ({ ...el }))
  const titleEl = elements.find((e) => e.type === 'text' && e.role === 'title')
  const bodyEl = elements.find((e) => e.type === 'text' && e.role === 'body')

  if (titleEl?.type === 'text') {
    titleEl.content = { type: 'doc', content: [{ type: 'paragraph', content: title ?? [] }] }
  }

  // Body text and extra blocks share the body area, one slot each.
  const hasBody = bodyNodes.length > 0
  const slots = extras.length + (hasBody ? 1 : 0)
  const slotH = slots > 0 ? BODY_H / slots : BODY_H
  let y = BODY_Y
  const kept = elements.filter((e) => e !== bodyEl)
  if (bodyEl?.type === 'text') {
    if (hasBody) {
      bodyEl.content = { type: 'doc', content: bodyNodes }
      bodyEl.x = BODY_X
      bodyEl.y = y
      bodyEl.w = BODY_W
      bodyEl.h = slotH
      y += slotH
      kept.push(bodyEl)
    }
  }
  extras.forEach((el, index) => {
    const positioned = { ...el, x: BODY_X, y, w: BODY_W, h: slotH, z: kept.length + index } as Element
    y += slotH
    kept.push(positioned)
  })

  return {
    ...slide,
    notes,
    elements: kept.map((el, index) => ({ ...el, z: index }) as Element),
  }
}

function listItem(text: string): RichNode {
  return { type: 'listItem', content: [{ type: 'paragraph', content: parseInline(text) }] }
}

// Builds a new element with a fresh id. Layout is set by the caller.
function makeElement(partial: Record<string, unknown>): Element {
  return {
    id: newId(),
    x: 0,
    y: 0,
    w: BODY_W,
    h: BODY_H,
    rotation: 0,
    z: 0,
    locked: false,
    opacity: 1,
    ...partial,
  } as unknown as Element
}

// Minimal inline parser: **bold**, *italic*, `code`, [text](url).
export function parseInline(text: string): RichNode[] {
  const re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g
  const out: RichNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  const push = (value: string, marks?: RichMark[]) => {
    if (value === '') return
    out.push(marks ? { type: 'text', text: value, marks } : { type: 'text', text: value })
  }
  while ((match = re.exec(text)) !== null) {
    push(text.slice(last, match.index))
    if (match[1] !== undefined) push(match[1], [{ type: 'bold' }])
    else if (match[2] !== undefined) push(match[2], [{ type: 'italic' }])
    else if (match[3] !== undefined) push(match[3], [{ type: 'code' }])
    else if (match[4] !== undefined) {
      const href = safeHref(match[5])
      if (href) push(match[4], [{ type: 'link', attrs: { href } }])
      else push(match[4])
    }
    last = match.index + match[0].length
  }
  push(text.slice(last))
  return out
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)
}

// Splits a pipe row on unescaped pipes, and unescapes \|.
function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '\\' && body[i + 1] === '|') {
      current += '|'
      i++
    } else if (ch === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current.trim())
  return cells
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start++
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--
  return lines.slice(start, end)
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--
  // Notes start after "Note:", so a leading blank line is kept only if it was written.
  return lines.slice(0, end)
}


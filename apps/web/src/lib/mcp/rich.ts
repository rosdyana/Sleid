// Plain, markdown-ish text to the rich-text document that text boxes store. Used by add_slide and update_text.
// Supported: one paragraph per line, a line starting with "- " is a bullet (consecutive bullets form one list),
// **bold** and *italic*. Anything else is literal text. Blank lines are skipped.
import type { RichText } from '@sleid/model'

type Inline = { type: 'text'; text: string; marks?: Array<{ type: 'bold' } | { type: 'italic' }> }
type Block = { type: 'paragraph'; content?: Inline[] } | { type: 'bulletList'; content: Array<{ type: 'listItem'; content: Array<{ type: 'paragraph'; content?: Inline[] }> }> }

// Markers count only at word edges, so 2*3*4 stays literal. Bold is tried first.
const INLINE = /(?<![\w*])\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*(?![\w*])|(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g

function inline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) })
    if (m[1] !== undefined) out.push({ type: 'text', text: m[1], marks: [{ type: 'bold' }] })
    else out.push({ type: 'text', text: m[2] ?? '', marks: [{ type: 'italic' }] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out.filter((node) => node.text.length > 0)
}

function paragraph(text: string): { type: 'paragraph'; content?: Inline[] } {
  const content = inline(text)
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
}

/** Markdown-ish text to a rich-text doc. Always at least one paragraph, so the box stays editable. */
export function markdownToRich(source: string): RichText {
  const blocks: Block[] = []
  let bullets: Array<{ type: 'listItem'; content: Array<{ type: 'paragraph'; content?: Inline[] }> }> | null = null
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const bullet = /^\s*-\s+(.*)$/.exec(line)
    if (bullet) {
      bullets ??= []
      bullets.push({ type: 'listItem', content: [paragraph(bullet[1] ?? '')] })
      continue
    }
    if (bullets) {
      blocks.push({ type: 'bulletList', content: bullets })
      bullets = null
    }
    if (line.trim() === '') continue
    blocks.push(paragraph(line.trim()))
  }
  if (bullets) blocks.push({ type: 'bulletList', content: bullets })
  if (blocks.length === 0) blocks.push({ type: 'paragraph' })
  return { type: 'doc', content: blocks } as unknown as RichText
}

/** A single-paragraph rich-text doc for a title. Line breaks become spaces. */
export function plainToRich(text: string): RichText {
  const single = text.replace(/\s*\n\s*/g, ' ').trim()
  return { type: 'doc', content: single ? [{ type: 'paragraph', content: [{ type: 'text', text: single }] }] : [{ type: 'paragraph' }] } as unknown as RichText
}

/** The plain text of a rich-text doc, one line per paragraph or list item. For outlines and summaries. */
export function richToPlain(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[] }
  if (n.type === 'text') return n.text ?? ''
  const children = Array.isArray(n.content) ? n.content : []
  if (n.type === 'doc' || n.type === 'bulletList' || n.type === 'orderedList') {
    return children.map((c) => richToPlain(c)).filter((s) => s.length > 0).join('\n')
  }
  return children.map((c) => richToPlain(c)).join('')
}

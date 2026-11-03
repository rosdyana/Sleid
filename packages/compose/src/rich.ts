// Rich-text doc builders. The node shapes are the ones the rich-text model and the renderer read (see @sleid/model RichNode).
import type { RichMark, RichNode, RichText } from '@sleid/model'

/** One paragraph with plain text, optionally with marks on the whole run. Line breaks become spaces. */
export function para(text: string, marks?: RichMark[]): RichNode {
  const single = text.replace(/\s*\n\s*/g, ' ').trim()
  if (!single) return { type: 'paragraph' }
  return { type: 'paragraph', content: [{ type: 'text', text: single, ...(marks ? { marks } : {}) }] }
}

/** A bullet list, one list item per string. */
export function bullets(items: string[]): RichNode {
  return {
    type: 'bulletList',
    content: items.map((text) => ({ type: 'listItem', content: [para(text)] })),
  }
}

/** A rich-text doc from block nodes. Always at least one block, so the box stays editable. */
export function doc(...blocks: RichNode[]): RichText {
  const content = blocks.length > 0 ? blocks : [{ type: 'paragraph' } as RichNode]
  return { type: 'doc', content } as RichText
}

/** The plain text of a rich-text node: one line per paragraph or list item. */
export function plainText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[] }
  if (n.type === 'text') return n.text ?? ''
  const children = Array.isArray(n.content) ? n.content : []
  if (n.type === 'doc' || n.type === 'bulletList' || n.type === 'orderedList') {
    return children.map((c) => plainText(c)).filter((s) => s.length > 0).join('\n')
  }
  return children.map((c) => plainText(c)).join('')
}

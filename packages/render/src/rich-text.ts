// Rich text (ProseMirror-style JSON) to HTML. Text is escaped, links are
// filtered by protocol, and unknown node types render as their children.
import type { RichMark, RichNode, RichText } from '@sleid/model'
import { escapeHtml, safeColor, safeFontFamily, safeHref, safeLength, safeSignedLength } from './html.ts'

export function richTextToHtml(doc: RichText | RichNode | null | undefined): string {
  if (!doc) return ''
  return renderNodes(doc.content ?? [])
}

function renderNodes(nodes: RichNode[]): string {
  return nodes.map(renderNode).join('')
}

function renderNode(node: RichNode): string {
  const inner = () => renderNodes(node.content ?? [])
  switch (node.type) {
    case 'text':
      return applyMarks(escapeHtml(node.text ?? ''), node.marks ?? [])
    case 'paragraph':
      return `<p>${inner() || '<br>'}</p>`
    case 'heading': {
      const level = clampLevel(node.attrs?.level)
      return `<h${level}>${inner()}</h${level}>`
    }
    case 'bulletList':
      return `<ul>${inner()}</ul>`
    case 'orderedList':
      return `<ol>${inner()}</ol>`
    case 'listItem':
      return `<li>${inner()}</li>`
    case 'blockquote':
      return `<blockquote>${inner()}</blockquote>`
    case 'codeBlock':
      return `<pre><code>${inner()}</code></pre>`
    case 'hardBreak':
      return '<br>'
    case 'horizontalRule':
      return '<hr>'
    default:
      // Unknown node: keep its text and children, drop the wrapper.
      if (typeof node.text === 'string') return applyMarks(escapeHtml(node.text), node.marks ?? [])
      return inner()
  }
}

function clampLevel(level: unknown): number {
  const n = typeof level === 'number' ? Math.round(level) : 1
  return Math.min(Math.max(n, 1), 6)
}

function applyMarks(html: string, marks: RichMark[]): string {
  let out = html
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        out = `<strong>${out}</strong>`
        break
      case 'italic':
        out = `<em>${out}</em>`
        break
      case 'underline':
        out = `<u>${out}</u>`
        break
      case 'strike':
        out = `<s>${out}</s>`
        break
      case 'code':
        out = `<code>${out}</code>`
        break
      case 'link': {
        const href = safeHref(mark.attrs.href)
        // A link with an unsafe href becomes plain text.
        if (href) out = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${out}</a>`
        break
      }
      case 'textStyle': {
        const css = textStyleCss(mark.attrs)
        if (css) out = `<span style="${escapeHtml(css)}">${out}</span>`
        break
      }
    }
  }
  return out
}

function textStyleCss(attrs: {
  color?: string | null
  fontSize?: string | null
  fontFamily?: string | null
  fontWeight?: string | number | null
  letterSpacing?: string | null
}): string {
  const parts: string[] = []
  if (attrs.color) parts.push(`color:${safeColor(attrs.color, '')}`)
  const size = safeLength(attrs.fontSize ?? undefined)
  if (size) parts.push(`font-size:${size}`)
  const family = safeFontFamily(attrs.fontFamily ?? undefined)
  if (family) parts.push(`font-family:${family}`)
  // M10. A weight is a 100-900 number, or the keyword 'bold' or 'normal'. Anything else is left out.
  // The editor stores weights read from HTML as strings ("650"), so a three-digit string counts as a number.
  const weight = typeof attrs.fontWeight === 'string' && /^\d{3}$/.test(attrs.fontWeight) ? Number(attrs.fontWeight) : attrs.fontWeight
  if (typeof weight === 'number' && Number.isInteger(weight) && weight >= 100 && weight <= 900) parts.push(`font-weight:${weight}`)
  else if (weight === 'bold' || weight === 'normal') parts.push(`font-weight:${weight}`)
  const spacing = safeSignedLength(attrs.letterSpacing ?? undefined)
  if (spacing) parts.push(`letter-spacing:${spacing}`)
  return parts.filter((p) => !p.endsWith(':')).join(';')
}

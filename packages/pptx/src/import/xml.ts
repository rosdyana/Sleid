// XML to a small tree. Entities are not expanded by the parser: a DOCTYPE is refused outright,
// and the five predefined entities and numeric references are decoded here.
import { XMLParser } from 'fast-xml-parser'
import { SyntaxValidator } from 'fast-xml-validator'
import { PptxImportError } from './zip.ts'

export interface XNode {
  /** Qualified name as written, for example `a:p`. `#text` for text nodes. */
  name: string
  attrs: Record<string, string>
  children: XNode[]
  /** Decoded text of a `#text` node. */
  text: string
}

const TEXT = '#text'

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  htmlEntities: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  allowBooleanAttributes: true,
})

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ''
      return String.fromCodePoint(code)
    }
    return NAMED[body] ?? whole
  })
}

/** Parses one part and returns its document element. `part` names the part in the error message. */
export function parseXml(xml: string, part: string): XNode {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new PptxImportError(`The file contains a DTD or entity declaration in ${part}, which is refused.`)
  }
  try {
    SyntaxValidator.validate(xml)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'syntax error'
    throw new PptxImportError(`The PowerPoint file is damaged: ${part} is not well-formed XML (${reason}).`)
  }
  let raw: unknown
  try {
    raw = parser.parse(xml)
  } catch {
    throw new PptxImportError(`The PowerPoint file is damaged: ${part} could not be parsed.`)
  }
  const doc = convert(raw).find((n) => n.name !== TEXT)
  if (!doc) throw new PptxImportError(`The PowerPoint file is damaged: ${part} has no root element.`)
  return doc
}

type RawItem = Record<string, unknown>

function convert(items: unknown): XNode[] {
  if (!Array.isArray(items)) return []
  const out: XNode[] = []
  for (const item of items as RawItem[]) {
    const key = Object.keys(item).find((k) => k !== ':@')
    if (!key) continue
    if (key === TEXT) {
      out.push({ name: TEXT, attrs: {}, children: [], text: decodeEntities(String(item[TEXT] ?? '')) })
      continue
    }
    const attrs: Record<string, string> = {}
    const rawAttrs = (item[':@'] ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(rawAttrs)) {
      attrs[k.startsWith('@_') ? k.slice(2) : k] = decodeEntities(String(v))
    }
    out.push({ name: key, attrs, children: convert(item[key]), text: '' })
  }
  return out
}

/** The local part of a qualified name: `a:p` gives `p`. */
export function local(name: string): string {
  const i = name.indexOf(':')
  return i >= 0 ? name.slice(i + 1) : name
}

export function kids(node: XNode | undefined): XNode[] {
  return node ? node.children.filter((c) => c.name !== TEXT) : []
}

/** Direct children with this local name. */
export function childrenNamed(node: XNode | undefined, name: string): XNode[] {
  return kids(node).filter((c) => local(c.name) === name)
}

/** The first direct child with this local name. */
export function child(node: XNode | undefined, name: string): XNode | undefined {
  return childrenNamed(node, name)[0]
}

/** Every descendant with this local name, in document order. */
export function descendants(node: XNode | undefined, name: string): XNode[] {
  const out: XNode[] = []
  const walk = (n: XNode) => {
    for (const c of kids(n)) {
      if (local(c.name) === name) out.push(c)
      walk(c)
    }
  }
  if (node) walk(node)
  return out
}

/** The first descendant with this local name, or undefined. */
export function firstDescendant(node: XNode | undefined, name: string): XNode | undefined {
  return descendants(node, name)[0]
}

/** All text under a node, with paragraph breaks ignored. */
export function textOf(node: XNode | undefined): string {
  if (!node) return ''
  if (node.name === TEXT) return node.text
  return node.children.map(textOf).join('')
}

export function attr(node: XNode | undefined, name: string): string | undefined {
  if (!node) return undefined
  return node.attrs[name]
}

export function numAttr(node: XNode | undefined, name: string): number | undefined {
  const v = attr(node, name)
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

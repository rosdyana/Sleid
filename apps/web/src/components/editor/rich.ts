// Helpers for text element content (ProseMirror-style JSON, see schema.ts).
import type { RichMark, RichNode, RichText } from '@sleid/model'

export type MarkName = 'bold' | 'italic' | 'underline' | 'strike'

export function emptyRich(): RichText {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/** Plain text to paragraphs, one per line. */
export function plainToRich(text: string): RichText {
  const lines = text.split('\n')
  return {
    type: 'doc',
    content: lines.map((line) => (line.length > 0 ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  }
}

function blockText(node: RichNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(blockText).join('')
}

/** Paragraphs back to plain text, one line per block. */
export function richToPlain(doc: RichText | RichNode | null | undefined): string {
  if (!doc) return ''
  return (doc.content ?? []).map(blockText).join('\n')
}

function withMarks(node: RichNode, mutate: (marks: RichMark[]) => RichMark[]): RichNode {
  const next: RichNode = { ...node }
  if (node.type === 'text') {
    const marks = mutate([...(node.marks ?? [])])
    if (marks.length > 0) next.marks = marks
    else delete next.marks
  }
  if (node.content) next.content = node.content.map((child) => withMarks(child, mutate))
  return next
}

/** Adds or removes one mark on every text node. */
export function setMarkEverywhere(doc: RichText, mark: MarkName, on: boolean): RichText {
  const mutate = (marks: RichMark[]) => {
    const rest = marks.filter((m) => m.type !== mark)
    return on ? [...rest, { type: mark } as RichMark] : rest
  }
  return withMarks(doc as RichNode, mutate) as RichText
}

/** Removes marks and text styles everywhere. */
export function clearMarksEverywhere(doc: RichText): RichText {
  return withMarks(doc as RichNode, () => []) as RichText
}

/** Whether a mark is present on every text node (used to show toolbar state). */
export function markOnEverything(doc: RichText | undefined, mark: MarkName): boolean {
  let any = false
  let all = true
  const walk = (node: RichNode) => {
    if (node.type === 'text') {
      any = true
      if (!(node.marks ?? []).some((m) => m.type === mark)) all = false
    }
    for (const child of node.content ?? []) walk(child)
  }
  if (doc) walk(doc as RichNode)
  return any && all
}

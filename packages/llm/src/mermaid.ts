// Cheap server-side check of Mermaid source. It is not a parser: it checks that the first
// statement starts with a diagram keyword from an allowlist, and it refuses script-like content.
// The browser renders with securityLevel 'strict' as a second layer.
export const MERMAID_KEYWORDS = [
  'graph',
  'flowchart',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'journey',
  'quadrantChart',
] as const

export const MERMAID_MAX_CHARS = 6000

export type MermaidCheck = { ok: true; keyword: string } | { ok: false; reason: string }

export function validateMermaid(source: string): MermaidCheck {
  const text = source.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  if (text.length === 0) return { ok: false, reason: 'the diagram is empty' }
  if (text.length > MERMAID_MAX_CHARS) return { ok: false, reason: `the diagram is longer than ${MERMAID_MAX_CHARS} characters` }
  if (/javascript:|<script|on[a-z]+\s*=/i.test(text)) return { ok: false, reason: 'the diagram contains script-like content' }
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('%%'))
  if (!first) return { ok: false, reason: 'the diagram has no statements' }
  const keyword = /^([A-Za-z][A-Za-z0-9-]*)/.exec(first)?.[1] ?? ''
  if (!(MERMAID_KEYWORDS as readonly string[]).includes(keyword)) {
    return { ok: false, reason: `the first line must start with one of: ${MERMAID_KEYWORDS.join(', ')}` }
  }
  return { ok: true, keyword }
}

/** The Mermaid source without a code fence, if the model added one. */
export function cleanMermaid(source: string): string {
  return source.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
}

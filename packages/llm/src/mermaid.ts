// Mermaid source checks for AI-written diagrams. Four layers, cheapest first: the size cap, a script
// check, the keyword of the first statement, and Mermaid's own parser (mermaid.parse) run in Node.
// The parser needs a DOM at import time (DOMPurify), so a small happy-dom window is installed only
// while mermaid is imported, and removed afterwards.

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
/** The parser is synchronous, so a timeout stops the wait, not the parse. The size cap bounds the work. */
export const MERMAID_PARSE_TIMEOUT_MS = 5000

export type MermaidCheck = { ok: true } | { ok: false; message: string; line?: number }

interface MermaidParser {
  parse(text: string): Promise<unknown>
}

const DOM_GLOBALS = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DOMParser', 'getComputedStyle', 'MutationObserver', 'Event', 'CustomEvent'] as const

async function importMermaidParser(): Promise<MermaidParser> {
  const g = globalThis as unknown as Record<string, unknown>
  const added: string[] = []
  if (typeof g.window === 'undefined') {
    const { Window } = await import('happy-dom')
    const win = new Window({ url: 'http://localhost/' }) as unknown as Record<string, unknown>
    for (const name of DOM_GLOBALS) {
      if (name in g) continue
      g[name] = name === 'window' ? win : win[name]
      added.push(name)
    }
  }
  try {
    const mod = (await import('mermaid')) as unknown as { default: MermaidParser }
    return mod.default
  } finally {
    for (const name of added) delete g[name]
  }
}

let parserPromise: Promise<MermaidParser | null> | undefined
let warnedKeywordOnly = false

/** The parser, or null when it cannot run in this process. Loaded once. */
function loadParser(): Promise<MermaidParser | null> {
  parserPromise ??= importMermaidParser().catch((err: unknown) => {
    if (!warnedKeywordOnly) {
      warnedKeywordOnly = true
      console.warn(`[assistant] mermaid parser unavailable, checking the keyword only: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  })
  return parserPromise
}

class ParseTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ParseTimeout(`timed out after ${ms} ms`)), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

/** The parser's message, shortened to its useful part: the line and what it expected. */
export function describeParseError(err: unknown): { message: string; line?: number } {
  const raw = err instanceof Error ? err.message : String(err)
  const lines = raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  const lineMatch = /Parse error on line (\d+)/.exec(raw)
  const expecting = lines.find((line) => line.startsWith('Expecting'))
  let message = lineMatch && expecting ? `Parse error on line ${lineMatch[1]}: ${expecting}` : (lines[0] ?? 'the parser rejected the diagram')
  if (message.length > 300) message = `${message.slice(0, 297)}...`
  return { message, ...(lineMatch ? { line: Number(lineMatch[1]) } : {}) }
}

/**
 * Checks Mermaid source. Returns ok when the parser accepts it. If the parser cannot run in this
 * process, only the size, script and keyword checks apply.
 */
export async function validateMermaid(source: string): Promise<MermaidCheck> {
  const text = cleanMermaid(source)
  if (text.length === 0) return { ok: false, message: 'the diagram is empty' }
  if (text.length > MERMAID_MAX_CHARS) return { ok: false, message: `the diagram is longer than ${MERMAID_MAX_CHARS} characters` }
  if (/javascript:|<script|on[a-z]+\s*=/i.test(text)) return { ok: false, message: 'the diagram contains script-like content' }
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('%%'))
  if (!first) return { ok: false, message: 'the diagram has no statements' }
  const keyword = /^([A-Za-z][A-Za-z0-9-]*)/.exec(first)?.[1] ?? ''
  if (!(MERMAID_KEYWORDS as readonly string[]).includes(keyword)) {
    return { ok: false, message: `the first line must start with one of: ${MERMAID_KEYWORDS.join(', ')}` }
  }

  const parser = await loadParser()
  if (!parser) return { ok: true }
  try {
    await withTimeout(parser.parse(text), MERMAID_PARSE_TIMEOUT_MS)
    return { ok: true }
  } catch (err) {
    if (err instanceof ParseTimeout) return { ok: false, message: `the parser did not finish (${err.message})` }
    return { ok: false, ...describeParseError(err) }
  }
}

/** The Mermaid source without a code fence, if the model added one. */
export function cleanMermaid(source: string): string {
  return source.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
}

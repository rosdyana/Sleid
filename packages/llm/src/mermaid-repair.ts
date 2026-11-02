// Deterministic fixer for the most common Mermaid mistake in AI flowcharts: a node written as bare
// words with spaces ("Shop appliances"). Node ids cannot contain spaces, so each such node becomes an
// id with the words joined, and the original text as its label: ShopAppliances[Shop appliances].
// The same text always gets the same id, across lines and across existing bracket definitions.
//
// Scope: flowcharts (graph and flowchart) only. Edge labels (-->|label|), bracketed or quoted labels,
// the statements that are not nodes (style, classDef, click, subgraph, ...), and any line with an
// inline edge label ("A -- text --> B") are left as they are. Source with nothing to fix comes back
// unchanged, so the fixer is idempotent.
import { cleanMermaid } from './mermaid.ts'

const FLOW_KEYWORDS = new Set(['graph', 'flowchart', 'flowchart-elk'])
const STATEMENT_WORDS = new Set([
  'graph',
  'flowchart',
  'flowchart-elk',
  'subgraph',
  'end',
  'direction',
  'style',
  'classdef',
  'class',
  'click',
  'linkstyle',
  'acctitle',
  'accdescr',
])
const RESERVED_IDS = new Set(['end', 'graph', 'flowchart', 'subgraph', 'style', 'class', 'classdef', 'click', 'linkstyle', 'direction', 'default', 'href', 'call'])

// An edge: an optional circle or cross end (only after a space or at the line start, so "Box-->"
// keeps its last letter), the line, the optional arrow head, and an optional |label|.
const EDGE = /(?:(?<=^|\s)[ox])?<?(?:-{2,}|={2,}|-\.+-?)[>xo]?(?:\|[^|\n]*\|)?/g
// An inline edge label written between the line parts: "A -- text --> B". Such lines are not touched.
const INLINE_LABEL = /(?:--|==|-\.)\s+\S/
// Words of letters, digits, underscore, apostrophe or hyphen, at least two of them.
const BARE_MULTI_WORD = /^[\p{L}\p{N}_'-]+(?: [\p{L}\p{N}_'-]+)+$/u
const SINGLE_ID = /^[\p{L}_][\p{L}\p{N}_]*$/u
const BRACKET_DEF = /^([\p{L}_][\p{L}\p{N}_]*)\s*[[({]+\s*"?([^\])}"]*)/u

interface Naming {
  /** Lower-cased label to node id. */
  ids: Map<string, string>
  /** Every id already used, so a generated id never collides with one. */
  taken: Set<string>
}

/** Splits a statement into alternating parts: node text, edge, node text, ... Even indexes are node text. */
function splitEdges(statement: string): string[] {
  const parts: string[] = []
  let last = 0
  for (const match of statement.matchAll(EDGE)) {
    parts.push(statement.slice(last, match.index))
    parts.push(match[0])
    last = match.index + match[0].length
  }
  parts.push(statement.slice(last))
  return parts
}

function isFlowchart(text: string): boolean {
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('%%'))
  const keyword = first ? /^([A-Za-z][A-Za-z0-9-]*)/.exec(first)?.[1] ?? '' : ''
  return FLOW_KEYWORDS.has(keyword)
}

/** Collects the ids and labels already in the diagram, so generated ids avoid them and reuse known labels. */
function collectNaming(lines: string[]): Naming {
  const naming: Naming = { ids: new Map(), taken: new Set() }
  for (const line of lines) {
    if (line.trim().startsWith('%%') || INLINE_LABEL.test(line)) continue
    for (const statement of statementsOf(line)) {
      if (isStatement(statement)) continue
      splitEdges(statement).forEach((part, index) => {
        if (index % 2 === 1) return
        const core = part.trim()
        const def = BRACKET_DEF.exec(core)
        if (def) {
          naming.taken.add(def[1]!)
          const key = def[2]!.trim().replace(/\s+/g, ' ').toLowerCase()
          if (key && !naming.ids.has(key)) naming.ids.set(key, def[1]!)
        } else if (SINGLE_ID.test(core)) {
          naming.taken.add(core)
        }
      })
    }
  }
  return naming
}

/** Statements on a line. A line with brackets, parentheses or quotes is one statement, so ';' inside a label is kept. */
function statementsOf(line: string): string[] {
  return /["[({]/.test(line) ? [line] : line.split(';')
}

function isStatement(statement: string): boolean {
  const word = /^\s*([A-Za-z][\w-]*)/.exec(statement)?.[1]?.toLowerCase()
  return word !== undefined && STATEMENT_WORDS.has(word)
}

function idFor(label: string, naming: Naming): string {
  const key = label.toLowerCase()
  const known = naming.ids.get(key)
  if (known) return known
  const words = label
    .split(' ')
    .map((word) => word.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((word) => word.length > 0)
  let base = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')
  if (!/^[\p{L}_]/u.test(base) || RESERVED_IDS.has(base.toLowerCase())) base = `N${base}`
  let id = base
  for (let n = 2; naming.taken.has(id); n++) id = `${base}${n}`
  naming.taken.add(id)
  naming.ids.set(key, id)
  return id
}

function rewriteStatement(statement: string, naming: Naming): string {
  if (statement.trim() === '' || isStatement(statement)) return statement
  const parts = splitEdges(statement)
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i]!
    const core = part.trim().replace(/\s+/g, ' ')
    if (!BARE_MULTI_WORD.test(core)) continue
    const lead = /^\s*/.exec(part)![0]
    const trail = /\s*$/.exec(part)![0]
    parts[i] = `${lead}${idFor(core, naming)}[${core}]${trail}`
  }
  return parts.join('')
}

/**
 * Returns the source with bare multi-word flowchart nodes given an id and a bracketed label.
 * Returns the input unchanged when there is nothing to fix, and for any diagram that is not a flowchart.
 */
export function repairMermaid(source: string): string {
  const text = cleanMermaid(source)
  if (!isFlowchart(text)) return source
  const lines = text.split('\n')
  const naming = collectNaming(lines)
  let changed = false
  const out = lines.map((line) => {
    if (line.trim().startsWith('%%') || INLINE_LABEL.test(line)) return line
    const rewritten = statementsOf(line)
      .map((statement) => rewriteStatement(statement, naming))
      .join(/["[({]/.test(line) ? '' : ';')
    if (rewritten !== line) changed = true
    return rewritten
  })
  return changed ? out.join('\n') : source
}

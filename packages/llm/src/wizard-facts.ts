// FACTS: figures computed in code from the reference tables, so the model copies a figure instead of working it out.
// For each numeric column: min, max, average, total, first and last. For each pair of columns with the same unit
// (for example "Tagihan sebelum (Rp)" and "Tagihan sesudah (Rp)"): the per-row difference, its average and total,
// and the difference as a share of the first column. The source id is kept apart from the text, so the id's digits
// never count as figures that support a number on a slide.

export interface FactTable {
  /** The reference number the model cites ([n]). */
  number: number
  sourceId: string
  tableIndex: number
  table: { name: string; columns: string[]; rows: Array<Array<string | number | null>> }
}

export interface FactLine {
  number: number
  sourceId: string
  /** The fact in words and figures, without the source id. */
  text: string
}

const MAX_ROW_DIFFERENCES = 12
const MAX_PAIRS_PER_TABLE = 2
const UNIT_WORDS = /\b(Rp|IDR|USD|kWh|kW|MW|GW|kg|%|persen|m2|m²)\s*$/i

/** Formats a figure the way the deck's language writes it (4.175.000 in Indonesian, 4,175,000 in English). */
export function formatFact(value: number, language: string, percent = false): string {
  const locale = language.toLowerCase().startsWith('id') ? 'id-ID' : 'en-US'
  if (percent) return `${(Math.round(value * 10) / 10).toLocaleString(locale, { maximumFractionDigits: 1 })}%`
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  return rounded.toLocaleString(locale, { maximumFractionDigits: 2 })
}

/** The unit a column names: "(Rp)" or a trailing unit word. Columns with the same unit can be subtracted. */
export function unitOf(column: string): string {
  const paren = /\(([^()]{1,12})\)\s*$/.exec(column)
  if (paren) return paren[1]!.trim().toLowerCase()
  const tail = UNIT_WORDS.exec(column)
  return tail ? tail[1]!.toLowerCase() : ''
}

function isNumericColumn(rows: FactTable['table']['rows'], c: number): boolean {
  const cells = rows.map((r) => r[c]).filter((v) => v !== null && v !== '')
  const numbers = cells.filter((v) => typeof v === 'number').length
  return numbers > 0 && numbers >= cells.length / 2
}

/** The facts for one table, one line per numeric column and one per pair of columns that share a unit. */
export function tableFacts(input: FactTable, language: string): FactLine[] {
  const { number, sourceId, tableIndex, table } = input
  const f = (v: number, percent = false) => formatFact(v, language, percent)
  const lines: FactLine[] = []
  const prefix = `Table "${table.name}" (table ${tableIndex})`
  const numericCols = table.columns.map((_, c) => c).filter((c) => isNumericColumn(table.rows, c))
  const valuesOf = (c: number) => table.rows.map((r) => r[c]).filter((v): v is number => typeof v === 'number')

  for (const c of numericCols) {
    const values = valuesOf(c)
    if (values.length === 0) continue
    const sum = values.reduce((a, b) => a + b, 0)
    lines.push({
      number,
      sourceId,
      text: `${prefix}, column "${table.columns[c]}": min ${f(Math.min(...values))}; max ${f(Math.max(...values))}; average ${f(sum / values.length)}; total ${f(sum)}; first ${f(values[0]!)}; last ${f(values[values.length - 1]!)} (${values.length} values).`,
    })
  }

  let pairs = 0
  for (let i = 0; i < numericCols.length && pairs < MAX_PAIRS_PER_TABLE; i++) {
    for (let j = i + 1; j < numericCols.length && pairs < MAX_PAIRS_PER_TABLE; j++) {
      const a = numericCols[i]!
      const b = numericCols[j]!
      const unit = unitOf(table.columns[a]!)
      if (!unit || unit !== unitOf(table.columns[b]!)) continue
      const rows = table.rows.filter((r) => typeof r[a] === 'number' && typeof r[b] === 'number')
      if (rows.length === 0) continue
      const diffs = rows.map((r) => ({ label: String(r[0] ?? ''), d: (r[a] as number) - (r[b] as number) }))
      const sumA = rows.reduce((s, r) => s + (r[a] as number), 0)
      const sumD = diffs.reduce((s, x) => s + x.d, 0)
      const perRow = diffs
        .slice(0, MAX_ROW_DIFFERENCES)
        .map((x) => `${x.label} ${f(x.d)}`)
        .join('; ')
      const share = sumA !== 0 ? `; as a share of "${table.columns[a]}": ${f((sumD / sumA) * 100, true)}` : ''
      lines.push({
        number,
        sourceId,
        text: `${prefix}, difference "${table.columns[a]}" minus "${table.columns[b]}", per row: ${perRow}${diffs.length > MAX_ROW_DIFFERENCES ? '; …' : ''}; average ${f(sumD / diffs.length)}; total ${f(sumD)}${share}.`,
      })
      pairs++
    }
  }
  return lines
}

/** The facts for every table of every reference, in reference order. */
export function allFacts(tables: FactTable[], language: string): FactLine[] {
  return tables.flatMap((t) => tableFacts(t, language))
}

/** The facts a slide may use: those of its own sources, or every source's when the slide names none. */
export function slideFacts(facts: readonly FactLine[], sourceIds: readonly string[], limit = 12): FactLine[] {
  const pool = sourceIds.length ? facts.filter((f) => sourceIds.includes(f.sourceId)) : facts
  return pool.slice(0, limit)
}

/** The FACTS block as the model reads it: one line per fact, with its citation number and source id. */
export function factsBlock(lines: readonly FactLine[]): string {
  return lines.map((l) => `[${l.number}] sourceId ${l.sourceId}: ${l.text}`).join('\n')
}

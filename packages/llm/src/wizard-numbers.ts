// Numeric grounding for the wizard's visible text. Every figure in a title, subtitle or bullet is read from the text
// in both Indonesian ("4.175.000", "4,2 juta") and English ("4,175,000", "4.2 million") notation, and checked against
// the figures in the slide's reference text and FACTS. The tolerance is the rounding the figure itself shows:
// "4,2 juta" is 4,200,000 +/- 50,000, "2.447.000" is +/- 500, "41%" is +/- 0.5 points.
//
// Not checked: years (1900 to 2100), slide counts ("5 slides"), day numbers before a month, and plain integers
// of ten or fewer (ordinals). Those are never counted as invented.

export interface Reading {
  value: number
  /** How far a source figure may be from this reading and still count as the same figure. */
  tolerance: number
}

export interface Figure {
  /** The figure as written, currency, scale and percent sign included. */
  raw: string
  start: number
  end: number
  /** The readings of the separators (a figure with one separator may read two ways, for example "4.175"). */
  readings: Reading[]
  exempt: boolean
}

const SCALE: Record<string, number> = {
  juta: 1e6,
  jt: 1e6,
  million: 1e6,
  millions: 1e6,
  mn: 1e6,
  miliar: 1e9,
  milyar: 1e9,
  billion: 1e9,
  bn: 1e9,
  ribu: 1e3,
  rb: 1e3,
  thousand: 1e3,
}

const FIGURE =
  /(\b(?:Rp|IDR|USD)\.?\s?|US\$\s?|\$\s?|€\s?)?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s?%|\s?persen\b|\s?percent\b)?(?:\s?(juta|jt|miliar|milyar|ribu|rb|millions?|thousand|billion|mn|bn)\b)?/gi
/** Between two figures of a range ("1,6–1,9 juta", "38 to 43%"). */
const RANGE_SEPARATOR = /^\s*(?:[–—-]|to|sampai|hingga)\s*$/i
const MONTH_AFTER = /^\s*(jan|feb|mar|apr|mei|may|jun|jul|agu|agt|aug|sep|okt|oct|nov|des|dec)[a-z]*\b/i
const SLIDE_WORD = /\bslides?\s*$/i
const SLIDE_WORD_AFTER = /^\s*slides?\b/i

interface RawFigure {
  cur?: string | undefined
  num: string
  pct?: string | undefined
  scale?: string | undefined
  start: number
  end: number
  raw: string
}

/** Readings of a digit string with separators: the grouping reading (only when every group after the first has 3 digits) and the decimal reading. */
function readingsOf(num: string): Array<{ value: number; decimals: number }> {
  const marks = [...num.matchAll(/[.,]/g)]
  if (marks.length === 0) return [{ value: Number(num), decimals: 0 }]
  const sameMark = marks.every((m) => m[0] === marks[0]![0])
  const groups = num.split(/[.,]/)
  const grouped = sameMark && groups.slice(1).every((g) => g.length === 3)
  const out: Array<{ value: number; decimals: number }> = []
  if (grouped) out.push({ value: Number(groups.join('')), decimals: 0 })
  // Several identical separators in groups of three can only be thousands, so they have no decimal reading.
  if (!(grouped && marks.length > 1)) {
    const last = marks[marks.length - 1]!.index!
    const intPart = num.slice(0, last).replace(/[.,]/g, '') || '0'
    const frac = num.slice(last + 1)
    out.push({ value: Number(`${intPart}.${frac}`), decimals: frac.length })
  }
  return out
}

function trailingZeros(n: number): number {
  let x = Math.round(Math.abs(n))
  let count = 0
  while (x > 0 && x % 10 === 0 && count < 12) {
    x /= 10
    count++
  }
  return count
}

function buildFigure(text: string, r: RawFigure): Figure {
  const percent = !!r.pct
  const scaleMult = r.scale ? (SCALE[r.scale.toLowerCase()] ?? 1) : 1
  const parsed = readingsOf(r.num)
  const readings: Reading[] = parsed.map(({ value, decimals }) => {
    if (percent) return { value, tolerance: 0.5 }
    const scaled = Number((value * scaleMult).toFixed(6))
    let tolerance: number
    if (decimals > 0) tolerance = 0.5 * Math.pow(10, -decimals) * scaleMult
    else if (scaleMult > 1) tolerance = 0.5 * scaleMult
    else tolerance = value >= 1000 ? 0.5 * Math.pow(10, trailingZeros(value)) : 0.5
    return { value: scaled, tolerance }
  })
  const plain = !r.cur && !r.pct && !r.scale
  const after = text.slice(r.end, r.end + 16)
  const before = text.slice(Math.max(0, r.start - 16), r.start)
  const noSeparator = !/[.,]/.test(r.num)
  const first = parsed[0]!.value
  const yearOrOrdinal = noSeparator && (first <= 10 || (first >= 1900 && first <= 2100))
  const exempt = plain && (yearOrOrdinal || SLIDE_WORD.test(before) || SLIDE_WORD_AFTER.test(after) || MONTH_AFTER.test(after))
  return { raw: r.raw, start: r.start, end: r.end, readings, exempt }
}

/** Every figure in a text, with its readings and tolerance. */
export function parseFigures(text: string): Figure[] {
  const raws: RawFigure[] = []
  for (const m of text.matchAll(FIGURE)) {
    const [whole, cur, num, pct, scale] = m
    raws.push({ cur, num: num!, pct, scale, start: m.index!, end: m.index! + whole.length, raw: whole })
  }
  // A range takes its unit from the figure that has one: "1,6–1,9 juta" is two figures of millions.
  for (let i = 0; i + 1 < raws.length; i++) {
    const a = raws[i]!
    const b = raws[i + 1]!
    if (!RANGE_SEPARATOR.test(text.slice(a.end, b.start))) continue
    for (const k of ['cur', 'pct', 'scale'] as const) {
      if (!a[k] && b[k]) a[k] = b[k]
      if (!b[k] && a[k]) b[k] = a[k]
    }
  }
  return raws.map((r) => buildFigure(text, r))
}

/** Every number a text states, under every reading. These are the figures a title or bullet may repeat. */
export function numbersIn(texts: readonly string[]): number[] {
  return texts.flatMap((t) => parseFigures(t).flatMap((f) => f.readings.map((r) => r.value)))
}

function isSupported(figure: Figure, support: readonly number[]): boolean {
  return figure.readings.some((r) => support.some((v) => Math.abs(v - r.value) <= r.tolerance + 1e-9))
}

/** The checked figures in a text that no supported figure accounts for. */
export function unsupportedFigures(text: string, support: readonly number[]): Figure[] {
  return parseFigures(text).filter((f) => !f.exempt && !isSupported(f, support))
}

/** The text with the word for an estimate after each of the given figures (`bad` must come from the same text). */
export function markUnsupported(text: string, bad: readonly Figure[], word: string): string {
  let out = text
  for (const f of [...bad].sort((a, b) => b.end - a.end)) out = `${out.slice(0, f.end)} (${word})${out.slice(f.end)}`
  return out
}

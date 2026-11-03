// Numeric grounding, label stripping and the placeholder slide, at the level the worker uses them.
import { describe, expect, it } from 'vitest'
import { createDeck, DEFAULT_THEME, type Element, type Op } from '@sleid/model'
import { scriptedProvider } from './testing.ts'
import { allFacts, factsBlock, formatFact, slideFacts, tableFacts, unitOf, type FactLine } from './wizard-facts.ts'
import { stripSourceLabels, estimateWord, placeholderNote } from './wizard-text.ts'
import { chartKeysOf, draftOutline, placeholderSlide, replaceSlideOps, writeWizardSlide, type SlideContext } from './wizard-abilities.ts'
import { Outline, WizardBrief } from './wizard-schema.ts'

const bill = {
  name: 'tagihan-listrik.csv',
  columns: ['Bulan', 'Tagihan sebelum (Rp)', 'Tagihan sesudah (Rp)'],
  rows: [
    ['Jan', 4200000, 2600000],
    ['Feb', 4100000, 2550000],
    ['Mar', 4350000, 2480000],
    ['Apr', 4250000, 2400000],
    ['Mei', 4000000, 2350000],
    ['Jun', 4150000, 2300000],
  ] as Array<Array<string | number | null>>,
}

const billFacts: FactLine[] = tableFacts({ number: 1, sourceId: 's-csv', tableIndex: 0, table: { ...bill, name: bill.name, columns: bill.columns } }, 'id')

const brief = WizardBrief.parse({ prompt: 'Pitch: rooftop solar for bakeries in Jakarta', slideCount: 3, language: 'id' })
const outline = Outline.parse({
  title: 'Solar for bakeries',
  slides: [
    { title: 'Cover', layout: 'title', keyPoints: [], visual: 'none', sourceIds: [] },
    { title: 'Bills', layout: 'title-content', keyPoints: ['Bills fall'], visual: 'none', sourceIds: ['s-csv'] },
    { title: 'Next steps', layout: 'title-content', keyPoints: ['Survey roofs'], visual: 'none', sourceIds: [] },
  ],
})
const slide = { title: 'Bills', layout: 'title-content' as const, keyPoints: ['Bills fall'], visual: 'none' as const, sourceIds: ['s-csv'] }
const context: SlideContext = {
  refs: [{ number: 1, sourceId: 's-csv', title: 'Electricity bills', origin: 'tagihan-listrik.csv' }],
  chunks: [{ number: 1, text: 'Monthly electricity bills before and after solar.' }],
  tables: [],
  facts: billFacts,
}

function replyWith(bullets: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ layout: 'title-content', title: 'Tagihan turun', bullets, notes: 'Tagihan turun [1].', ...extra })
}

function textOf(content: unknown): string {
  const n = content as { text?: string; content?: unknown[] }
  if (typeof n.text === 'string') return n.text
  return (n.content ?? []).map(textOf).join(' ')
}

function slideElements(op: Op | undefined): Element[] {
  if (!op || op.op !== 'addSlide' || !op.slide) throw new Error('expected an addSlide op')
  return (op.slide.elements ?? []) as Element[]
}

describe('FACTS: figures computed from a table', () => {
  it('gives min, max, average, total, first and last per numeric column, with the deck language', () => {
    const before = billFacts.find((f) => f.text.includes('"Tagihan sebelum (Rp)"') && f.text.includes('column'))!
    expect(before.text).toContain('min 4.000.000')
    expect(before.text).toContain('max 4.350.000')
    expect(before.text).toContain('average 4.175.000')
    expect(before.text).toContain('total 25.050.000')
    expect(before.text).toContain('first 4.200.000')
    expect(before.text).toContain('last 4.150.000')
    expect(before.number).toBe(1)
    expect(before.sourceId).toBe('s-csv')
  })

  it('subtracts the two columns that share a unit, per row, with the average and the share of the first column', () => {
    const diff = billFacts.find((f) => f.text.includes('difference'))!
    expect(diff.text).toContain('"Tagihan sebelum (Rp)" minus "Tagihan sesudah (Rp)"')
    expect(diff.text).toContain('Jan 1.600.000')
    expect(diff.text).toContain('Mar 1.870.000')
    expect(diff.text).toContain('total 10.370.000')
    expect(diff.text).toContain('as a share of "Tagihan sebelum (Rp)": 41,4%')
  })

  it('uses English notation for an English deck', () => {
    const lines = tableFacts({ number: 2, sourceId: 's', tableIndex: 0, table: bill }, 'en')
    expect(lines.find((f) => f.text.includes('column "Tagihan sebelum (Rp)"'))!.text).toContain('average 4,175,000')
    expect(lines.find((f) => f.text.includes('difference'))!.text).toContain('41.4%')
  })

  it('does not subtract columns with different units, or text columns', () => {
    const mixed = tableFacts({ number: 1, sourceId: 's', tableIndex: 0, table: { name: 'x', columns: ['Month', 'Bill (Rp)', 'Use (kWh)'], rows: [['Jan', 10, 3], ['Feb', 12, 4]] } }, 'en')
    expect(mixed.some((f) => f.text.includes('difference'))).toBe(false)
    expect(mixed.some((f) => f.text.includes('column "Month"'))).toBe(false)
  })

  it('reads units from a parenthesis or a trailing unit word, and formats values per language', () => {
    expect(unitOf('Tagihan sebelum (Rp)')).toBe('rp')
    expect(unitOf('Pemakaian kWh')).toBe('kwh')
    expect(unitOf('Bulan')).toBe('')
    expect(formatFact(4175000, 'id')).toBe('4.175.000')
    expect(formatFact(4175000, 'en')).toBe('4,175,000')
  })

  it('the FACTS block carries the source id and the citation number, and slideFacts picks the slide own sources first', () => {
    const block = factsBlock(billFacts)
    expect(block).toContain('[1] sourceId s-csv: ')
    expect(slideFacts([...billFacts, { number: 2, sourceId: 'other', text: 'x' }], ['other']).map((f) => f.sourceId)).toEqual(['other'])
    expect(allFacts([{ number: 1, sourceId: 's-csv', tableIndex: 0, table: bill }], 'id').length).toBeGreaterThan(2)
  })
})

describe('numeric claims on a slide are checked against the references and FACTS', () => {
  it('a figure that the first reply invented is corrected once, and the corrected reply is kept', async () => {
    const provider = scriptedProvider([replyWith(['Tagihan Rp3,38 juta']), replyWith(['Tagihan Rp4,2 juta'])])
    const r = await writeWizardSlide({ provider }, { brief, outline, slideIndex: 1, slide, context, theme: DEFAULT_THEME, deck: createDeck('x') })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]!.messages[0]!.content).toContain('Correction:')
    expect(provider.requests[1]!.messages[0]!.content).toContain('Rp3,38 juta')
    const bullets = slideElements(r.ops[0]).flatMap((e) => (e.type === 'text' && e.role === 'body' ? [textOf(e.content)] : []))
    expect(bullets.join(' ')).toContain('Rp4,2 juta')
    expect(bullets.join(' ')).not.toContain('perkiraan')
    expect(r.estimates).toEqual([])
  })

  it('a figure still unsupported after the retry stays on the slide, marked in the deck language, with a note and a warning', async () => {
    const provider = scriptedProvider([replyWith(['Sesudah rata-rata Rp2,08 juta']), replyWith(['Sesudah rata-rata Rp2,08 juta'])])
    const r = await writeWizardSlide({ provider }, { brief, outline, slideIndex: 1, slide, context, theme: DEFAULT_THEME, deck: createDeck('x') })
    expect(provider.requests).toHaveLength(2)
    const body = slideElements(r.ops[0]).find((e) => e.type === 'text' && e.role === 'body') as Extract<Element, { type: 'text' }>
    expect(textOf(body.content)).toContain('Rp2,08 juta (perkiraan)')
    expect(r.estimates).toEqual(['Rp2,08 juta'])
    expect(r.warnings.join(' ')).toContain('marked as estimates')
    const notes = (r.ops[0] as { slide: { notes: string } }).slide.notes
    expect(notes).toContain('Periksa sebelum presentasi')
    expect(notes).toContain('Rp2,08 juta')
  })

  it('an English deck marks the same figure as an estimate', async () => {
    const enBrief = WizardBrief.parse({ prompt: 'x', slideCount: 3, language: 'en' })
    const provider = scriptedProvider([replyWith(['Average Rp2.08 million']), replyWith(['Average Rp2.08 million'])])
    const r = await writeWizardSlide({ provider }, { brief: enBrief, outline, slideIndex: 1, slide, context, theme: DEFAULT_THEME, deck: createDeck('x') })
    const body = slideElements(r.ops[0]).find((e) => e.type === 'text' && e.role === 'body') as Extract<Element, { type: 'text' }>
    expect(textOf(body.content)).toContain('(estimate)')
  })

  it('years, slide counts and small ordinals are never marked', async () => {
    const provider = scriptedProvider([replyWith(['Sejak 2024, 3 tahap, 5 slide'])])
    const r = await writeWizardSlide({ provider }, { brief, outline, slideIndex: 1, slide, context, theme: DEFAULT_THEME, deck: createDeck('x') })
    expect(provider.requests).toHaveLength(1)
    expect(r.estimates).toEqual([])
  })

  it('the figures a slide may state include its FACTS, so a figure from FACTS needs no correction', async () => {
    const provider = scriptedProvider([replyWith(['Selisih rata-rata Rp1,7 juta'])])
    const r = await writeWizardSlide({ provider }, { brief, outline, slideIndex: 1, slide, context, theme: DEFAULT_THEME, deck: createDeck('x') })
    expect(provider.requests).toHaveLength(1)
    expect(r.estimates).toEqual([])
  })

  it('the FACTS block is in the prompt, inside the untrusted data markers', async () => {
    const provider = scriptedProvider([replyWith(['Tagihan Rp4,2 juta'])])
    await writeWizardSlide({ provider }, { brief, outline, slideIndex: 1, slide, context, theme: DEFAULT_THEME, deck: createDeck('x') })
    const user = provider.requests[0]!.messages[0]!.content
    expect(user).toContain('FACTS (figures computed from the references')
    expect(user).toContain('average 4.175.000')
    expect(user.indexOf('average 4.175.000')).toBeGreaterThan(user.indexOf('<<<DECK_CONTENT'))
    expect(provider.requests[0]!.system).toContain('Never invent or estimate a figure')
  })
})

describe('internal labels never reach a visible title or bullet', () => {
  it('strips S-labels, bracketed numbers and ids, and keeps the rest of the words', () => {
    expect(stripSourceLabels('Penghematan dari Data S1')).toBe('Penghematan dari Data')
    expect(stripSourceLabels('S1: data bulanan Rp4,2 juta')).toBe('data bulanan Rp4,2 juta')
    expect(stripSourceLabels('Hemat [S2] dan [1]')).toBe('Hemat dan')
    expect(stripSourceLabels('Sumber 3f2a1b9c-1234-4abc-9def-0123456789ab kini')).toBe('Sumber kini')
    expect(stripSourceLabels('ASEAN dan Rp4,2 juta.')).toBe('ASEAN dan Rp4,2 juta.')
    expect(stripSourceLabels('S1')).toBe('')
  })

  it('a slide written with labels in its title and bullets shows none of them', async () => {
    const provider = scriptedProvider([JSON.stringify({ layout: 'title-content', title: 'Penghematan dari Data S1', bullets: ['S1: data bulanan Rp4,2 juta', 'Lihat [S2]'], notes: 'Catatan [1].' })])
    const r = await writeWizardSlide({ provider }, { brief, outline, slideIndex: 1, slide, context, theme: DEFAULT_THEME, deck: createDeck('x') })
    const visible = slideElements(r.ops[0]).map((e) => (e.type === 'text' ? textOf(e.content) : '')).join(' | ')
    expect(visible).toContain('Penghematan dari Data')
    expect(visible).toContain('data bulanan')
    expect(visible).not.toMatch(/\bS\d\b|\[\d+\]|\[S\d+\]/)
    // The citation stays in the notes.
    expect((r.ops[0] as { slide: { notes: string } }).slide.notes).toContain('[1]')
  })

  it('the outline drops labels from titles and key points, and a title that is only a label gets the slide number', async () => {
    const provider = scriptedProvider([
      JSON.stringify({
        title: 'Solar S1',
        slides: [
          { title: 'Cover', layout: 'title', keyPoints: [], visual: 'none', sourceRefs: [] },
          { title: 'Penghematan dari Data S1', layout: 'title-content', keyPoints: ['S1: data bulanan', 'Hemat [S2]'], visual: 'none', sourceRefs: ['S1'] },
          { title: 'S2', layout: 'title-content', keyPoints: [], visual: 'none', sourceRefs: [] },
        ],
      }),
    ])
    const { outline: drafted } = await draftOutline({ provider }, { brief, references: [{ id: 'ref-1', title: 'Bills', origin: 'bills.csv', summary: 'bills' }] })
    expect(drafted.title).toBe('Solar')
    expect(drafted.slides[1]!.title).toBe('Penghematan dari Data')
    expect(drafted.slides[1]!.keyPoints).toEqual(['data bulanan', 'Hemat'])
    expect(drafted.slides[2]!.title).toBe('Slide 3')
    expect(drafted.slides[1]!.sourceIds).toEqual(['ref-1'])
    expect(provider.requests[0]!.messages[0]!.content).toContain('"Bills" (bills.csv)')
  })
})

describe('the placeholder for a slide the model could not write', () => {
  it('has the outline title, the points as bullets, and a muted note in the deck language', () => {
    const { op, slideId } = placeholderSlide({ slideIndex: 2, title: 'Langkah berikutnya', bullets: ['Survei atap', 'Pasang panel'], theme: DEFAULT_THEME, language: 'id' })
    expect(op.op === 'addSlide' && op.slide?.id).toBe(slideId)
    const elements = slideElements(op)
    const title = elements.find((e) => e.type === 'text' && e.role === 'title') as Extract<Element, { type: 'text' }>
    expect(textOf(title.content)).toBe('Langkah berikutnya')
    const body = elements.find((e) => e.type === 'text' && e.role === 'body') as Extract<Element, { type: 'text' }>
    expect(textOf(body.content)).toContain('Survei atap')
    expect(textOf(body.content)).toContain('Pasang panel')
    const note = elements.find((e) => e.type === 'text' && textOf(e.content).startsWith('Tidak dapat dibuat')) as Extract<Element, { type: 'text' }>
    expect(note).toBeDefined()
    expect(textOf(note.content)).toBe(placeholderNote('id'))
    expect(note.style.color).toBe(DEFAULT_THEME.colors.muted)
    expect(note.style.fontSize!).toBeLessThan(DEFAULT_THEME.sizes.body)
    // The bullets stop above the note.
    expect(body.y + body.h).toBeLessThanOrEqual(note.y)
  })

  it('the note is in English for an English deck', () => {
    const { op } = placeholderSlide({ slideIndex: 0, title: 'Next', bullets: ['A'], theme: DEFAULT_THEME, language: 'en' })
    const texts = slideElements(op).map((e) => (e.type === 'text' ? textOf(e.content) : ''))
    expect(texts).toContain('Could not be generated — use "Retry failed slides" in the banner.')
    expect(estimateWord('en')).toBe('estimate')
    expect(estimateWord('id')).toBe('perkiraan')
  })

  it('a retry replaces the placeholder in place: delete the old slide, then add the new one at the same index', () => {
    const { op } = placeholderSlide({ slideIndex: 1, title: 'x', bullets: [], theme: DEFAULT_THEME, language: 'en' })
    const ops = replaceSlideOps(3, 'old-slide', op)
    expect(ops[0]).toEqual({ op: 'deleteSlide', slideId: 'old-slide' })
    expect(ops[1]).toMatchObject({ op: 'addSlide', index: 3 })
    expect(() => replaceSlideOps(0, 'x', { op: 'deleteSlide', slideId: 'y' } as Op)).toThrow()
  })

  it('chartKeysOf lists the chart data already on a deck, so a retry does not repeat a chart', () => {
    const deck = createDeck('x')
    expect(chartKeysOf(deck).size).toBe(0)
    const chart = { id: 'c', type: 'chart', chartType: 'bar', data: { columns: ['Month', 'Before'], rows: [['Jan', 1]] }, options: {}, x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 0, locked: false, opacity: 1 } as unknown as Element
    deck.slides[0]!.elements.push(chart)
    expect(chartKeysOf(deck).has(JSON.stringify({ columns: ['Month', 'Before'], rows: [['Jan', 1]] }))).toBe(true)
  })
})

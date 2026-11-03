import { describe, expect, it } from 'vitest'
import { markUnsupported, numbersIn, parseFigures, unsupportedFigures } from './wizard-numbers.ts'

/** The figures a text states, as the value of its first reading (the one that matters for these examples). */
function firstValues(text: string): number[] {
  return parseFigures(text).map((f) => f.readings[0]!.value)
}

describe('figures are read in Indonesian and English notation', () => {
  it('reads thousands grouping with dots and with commas', () => {
    expect(firstValues('Rp4.175.000')).toEqual([4175000])
    expect(firstValues('4,175,000')).toEqual([4175000])
    expect(firstValues('Rp 2.447.000')).toEqual([2447000])
  })

  it('reads a decimal comma (Indonesian) and a decimal point (English), with their scale words', () => {
    expect(parseFigures('Rp4,2 juta')[0]!.readings[0]).toEqual({ value: 4200000, tolerance: 50000 })
    expect(parseFigures('4.2 million')[0]!.readings[0]).toEqual({ value: 4200000, tolerance: 50000 })
    expect(parseFigures('Rp1,6 miliar')[0]!.readings[0]!.value).toBe(1600000000)
  })

  it('a range takes the unit of the figure that has one: "1,6–1,9 juta" is two figures of millions', () => {
    const figures = parseFigures('Rp1,6–1,9 juta')
    expect(figures.map((f) => f.readings[0]!.value)).toEqual([1600000, 1900000])
    expect(figures.every((f) => !f.exempt)).toBe(true)
    expect(parseFigures('38–43%').map((f) => f.readings[0]!.value)).toEqual([38, 43])
  })

  it('a figure with one separator and three digits after it reads both ways (4.175 is 4175 or 4.175)', () => {
    expect(parseFigures('4.175')[0]!.readings.map((r) => r.value)).toEqual([4175, 4.175])
  })
})

describe('tolerance is the rounding the figure shows', () => {
  it('4,2 juta covers 4,175,000 (rounding to one decimal of a million), 3,38 juta does not', () => {
    const support = [4175000]
    expect(unsupportedFigures('Tagihan Rp4,2 juta', support)).toEqual([])
    expect(unsupportedFigures('Tagihan Rp3,38 juta', support).map((f) => f.raw)).toEqual(['Rp3,38 juta'])
  })

  it('the averages of the live run: 2,08 juta is not 2,447,000, but 2,4 juta is', () => {
    const support = [4175000, 2446667]
    expect(unsupportedFigures('sesudah rata-rata Rp2,08 juta', support).map((f) => f.raw)).toEqual(['Rp2,08 juta'])
    expect(unsupportedFigures('sesudah rata-rata Rp2,4 juta', support)).toEqual([])
    expect(unsupportedFigures('sesudah rata-rata Rp2.447.000', support)).toEqual([])
  })

  it('a grouped whole number may be rounded to its trailing zeros, but no further', () => {
    expect(unsupportedFigures('Rp4.200.000', [4175000])).toEqual([])
    expect(unsupportedFigures('Rp4.400.000', [4175000]).map((f) => f.raw)).toEqual(['Rp4.400.000'])
  })

  it('percentages are within half a point', () => {
    expect(unsupportedFigures('hemat 41%', [41.4])).toEqual([])
    expect(unsupportedFigures('hemat 45%', [41.4]).map((f) => f.raw)).toEqual(['45%'])
  })

  it('a figure from a computed difference is supported when it is rounded to the shown precision', () => {
    // 4,175,000 - 2,446,667 = 1,728,333: "Rp1,7 juta" is that figure rounded, "Rp1,6 juta" is not.
    expect(unsupportedFigures('hemat Rp1,7 juta', [1728333])).toEqual([])
    expect(unsupportedFigures('hemat Rp1,6 juta', [1728333]).map((f) => f.raw)).toEqual(['Rp1,6 juta'])
  })
})

describe('exempt figures are never counted', () => {
  it('years, slide counts, small ordinals and day numbers before a month are exempt', () => {
    const exempt = (t: string) => parseFigures(t).every((f) => f.exempt)
    expect(exempt('Sejak 2024')).toBe(true)
    expect(exempt('2100')).toBe(true)
    expect(exempt('3 bakeries')).toBe(true)
    expect(exempt('10 poin')).toBe(true)
    expect(exempt('5 slides')).toBe(true)
    expect(exempt('slide 7')).toBe(true)
    expect(exempt('15 Mei 2026')).toBe(true)
    // A number with a currency, a scale, a percent sign or a separator is checked.
    expect(exempt('Rp5')).toBe(false)
    expect(exempt('5 juta')).toBe(false)
    expect(exempt('5%')).toBe(false)
    expect(exempt('1,5')).toBe(false)
  })

  it('an unsupported year or small ordinal is not reported', () => {
    expect(unsupportedFigures('Tahun 2030 dan 3 tahap', [])).toEqual([])
  })
})

describe('marking estimates', () => {
  it('appends the word after each unsupported figure, and leaves supported ones alone', () => {
    const text = 'Tagihan Rp3,38 juta, sekarang Rp4,2 juta.'
    const bad = unsupportedFigures(text, [4175000])
    expect(markUnsupported(text, bad, 'perkiraan')).toBe('Tagihan Rp3,38 juta (perkiraan), sekarang Rp4,2 juta.')
    expect(markUnsupported('Hemat 41% dan 45%', unsupportedFigures('Hemat 41% dan 45%', [41.4]), 'estimate')).toBe('Hemat 41% dan 45% (estimate)')
  })

  it('numbersIn gives every reading of every figure in the texts', () => {
    expect(numbersIn(['Rp4,2 juta', 'Tabel: 2.000 kWh'])).toEqual(expect.arrayContaining([4200000, 2000]))
  })
})

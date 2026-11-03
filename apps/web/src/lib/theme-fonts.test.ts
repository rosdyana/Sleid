import { describe, expect, it } from 'vitest'
import { MAX_FONT_IMPORTS, parseFontImports } from './theme-fonts.ts'

describe('parseFontImports (M10)', () => {
  it('keeps families with axis lists, and splits on commas between families', () => {
    expect(parseFontImports('Inter:wght@400;600;700, Noto Sans TC')).toEqual({ kept: ['Inter:wght@400;600;700', 'Noto Sans TC'], dropped: [] })
  })

  it('keeps a comma inside an axis list with its family', () => {
    expect(parseFontImports('Roboto:ital,wght@0,400;1,700').kept).toEqual(['Roboto:ital,wght@0,400;1,700'])
  })

  it('drops values that are not Google Fonts families, without dropping the rest', () => {
    const r = parseFontImports('javascript:alert(1), <b>x</b>, Inter')
    expect(r.kept).toEqual(['Inter'])
    expect(r.dropped).toHaveLength(1)
  })

  it('removes duplicates and drops families beyond the limit', () => {
    const many = Array.from({ length: MAX_FONT_IMPORTS + 2 }, (_, i) => `Font ${i}`).join(', ')
    const r = parseFontImports(`Inter, Inter, ${many}`)
    expect(r.kept).toHaveLength(MAX_FONT_IMPORTS)
    expect(r.kept[0]).toBe('Inter')
    expect(r.dropped.length).toBeGreaterThan(0)
  })
})

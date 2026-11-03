import { describe, expect, it } from 'vitest'
import { attachmentDisposition, exportFileName, formatFile, safeFileBase, StartExportSchema } from './export-spec.ts'

const deckId = '0f3c9a52-1b2c-4d5e-8f90-a1b2c3d4e5f6'

describe('StartExportSchema', () => {
  it('fills in defaults per format', () => {
    const pdf = StartExportSchema.parse({ deckId, format: 'pdf' })
    expect(pdf.options).toEqual({ includeNotes: false, includeHidden: false })
    const png = StartExportSchema.parse({ deckId, format: 'png' })
    expect(png.options).toEqual({ scale: 1, includeHidden: false })
    expect(StartExportSchema.parse({ deckId, format: 'pptx' }).options).toEqual({})
  })

  it('rejects an unknown format, a bad scale, a bad deck id and options that belong to another format', () => {
    expect(() => StartExportSchema.parse({ deckId, format: 'docx' })).toThrow()
    expect(() => StartExportSchema.parse({ deckId, format: 'png', options: { scale: 3 } })).toThrow()
    expect(() => StartExportSchema.parse({ deckId: 'nope', format: 'pdf' })).toThrow()
    expect(() => StartExportSchema.parse({ deckId, format: 'pptx', options: { includeNotes: true } })).not.toThrow()
  })
})

describe('file names', () => {
  it('strips path separators, control characters and leading dots', () => {
    expect(safeFileBase('Q3/plan: "final" <v2>')).toBe('Q3 plan final v2')
    // Separators are gone, so no path can be built from the name.
    expect(safeFileBase('../../etc/passwd')).toBe('.. etc passwd')
    expect(safeFileBase('   ')).toBe('deck')
    expect(safeFileBase('a'.repeat(200))).toHaveLength(80)
  })

  it('names files by format, zipping PNG and JPG when there is more than one slide', () => {
    expect(exportFileName('Deck', 'pdf')).toBe('Deck.pdf')
    expect(exportFileName('Deck', 'png')).toBe('Deck.png')
    expect(exportFileName('Deck', 'png', true)).toBe('Deck.png.zip')
    expect(exportFileName('Deck', 'jpg', true)).toBe('Deck.jpg.zip')
    expect(exportFileName('Deck', 'html')).toBe('Deck.html.zip')
    expect(exportFileName('Deck', 'json')).toBe('Deck.sleid.json')
    expect(exportFileName('Deck', 'png', false, 3)).toBe('Deck - slide 3.png')
    expect(formatFile('pptx').contentType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
  })

  it('builds a Content-Disposition with an ASCII fallback and the real name', () => {
    expect(attachmentDisposition('Café "plan".pdf')).toBe(`attachment; filename="Caf_ _plan_.pdf"; filename*=UTF-8''Caf%C3%A9%20%22plan%22.pdf`)
  })
})

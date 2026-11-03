import { describe, expect, it } from 'vitest'
import { formatForFileName } from './import-format'

describe('formatForFileName (a first guess; the server checks the bytes)', () => {
  it('reads the three upload formats, in any letter case', () => {
    expect(formatForFileName('Deck.PPTX')).toBe('pptx')
    expect(formatForFileName('notes.md')).toBe('markdown')
    expect(formatForFileName('notes.Markdown')).toBe('markdown')
    expect(formatForFileName('deck.json')).toBe('json')
  })

  it('is null for anything else, including a .txt and a name with no extension', () => {
    expect(formatForFileName('readme.txt')).toBeNull()
    expect(formatForFileName('deck.pptx.txt')).toBeNull()
    expect(formatForFileName('pptx')).toBeNull()
    expect(formatForFileName('')).toBeNull()
  })
})

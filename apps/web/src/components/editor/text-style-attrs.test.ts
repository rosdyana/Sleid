import { describe, expect, it } from 'vitest'
import { richTextToHtml } from '@sleid/render'
import { parseWeight, TEXT_STYLE_ATTRS } from './text-style-attrs.ts'

const el = (style: Record<string, string>) => ({ style }) as unknown as HTMLElement

describe('text style mark attributes (M10)', () => {
  it('parses weights as numbers 100-900 or the keywords, and drops anything else', () => {
    expect(parseWeight('650')).toBe(650)
    expect(parseWeight('600')).toBe(600)
    expect(parseWeight('bold')).toBe('bold')
    expect(parseWeight('normal')).toBe('normal')
    expect(parseWeight('50')).toBeNull()
    expect(parseWeight('1000')).toBeNull()
    expect(parseWeight('')).toBeNull()
  })

  it('reads size, family, weight and spacing from the span style', () => {
    expect(TEXT_STYLE_ATTRS.fontSize.parseHTML(el({ fontSize: '24px' }))).toBe('24px')
    expect(TEXT_STYLE_ATTRS.fontFamily.parseHTML(el({ fontFamily: 'Georgia, serif' }))).toBe('Georgia, serif')
    expect(TEXT_STYLE_ATTRS.fontWeight.parseHTML(el({ fontWeight: '650' }))).toBe(650)
    expect(TEXT_STYLE_ATTRS.letterSpacing.parseHTML(el({ letterSpacing: '0.05em' }))).toBe('0.05em')
    expect(TEXT_STYLE_ATTRS.letterSpacing.parseHTML(el({}))).toBeNull()
  })

  it('writes each set attribute back as a style entry, and nothing for unset ones', () => {
    expect(TEXT_STYLE_ATTRS.fontWeight.renderHTML({ fontWeight: 600 })).toEqual({ style: 'font-weight: 600' })
    expect(TEXT_STYLE_ATTRS.letterSpacing.renderHTML({ letterSpacing: '0.1em' })).toEqual({ style: 'letter-spacing: 0.1em' })
    expect(TEXT_STYLE_ATTRS.fontWeight.renderHTML({ fontWeight: null })).toEqual({})
  })

  it('a parsed weight is drawn by the renderer', () => {
    const html = richTextToHtml({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: [{ type: 'textStyle', attrs: { fontWeight: parseWeight('650') } }] }] }],
    })
    expect(html).toContain('font-weight:650')
  })
})

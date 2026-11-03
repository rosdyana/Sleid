import { describe, expect, it } from 'vitest'
import { createDeck, applyOps, deckToYDoc, yDocToDeck, type Deck, type Op } from '@sleid/model'
import { brandConstraintFor, colourToHex, constrainOpsToBrand, fontFamilies, isNeutral, nearestPaletteColor, parseColour, snapColor } from './brand-constraint.ts'
import { describeDeck } from './context.ts'
import { generateTheme } from './abilities/generate-theme.ts'
import { LlmError } from './errors.ts'
import type { AbilityEnv } from './abilities/common.ts'

const PALETTE = ['#ffffff', '#101820', '#0055cc', '#00aa66', '#dd7700', '#8844aa', '#f0f4ff', '#556677']
const CONSTRAINT = { palette: PALETTE, headingFont: 'Georgia, serif', bodyFont: 'Helvetica, sans-serif' }

describe('colour helpers', () => {
  it('parses six and three digit hex, and refuses anything else', () => {
    expect(parseColour('#0055CC')).toEqual([0, 0x55, 0xcc])
    expect(parseColour('#abc')).toEqual([0xaa, 0xbb, 0xcc])
    expect(parseColour('red')).toBeNull()
    expect(parseColour('rgb(1, 2, 3)')).toBeNull()
    expect(colourToHex([0, 85, 204])).toBe('#0055cc')
  })

  it('treats black, white and greys as neutral', () => {
    expect(isNeutral([0, 0, 0])).toBe(true)
    expect(isNeutral([255, 255, 255])).toBe(true)
    expect(isNeutral([119, 119, 119])).toBe(true)
    expect(isNeutral([200, 40, 40])).toBe(false)
  })

  it('finds the nearest palette colour, and keeps the palette order on ties', () => {
    expect(nearestPaletteColor([10, 80, 200], PALETTE)).toBe('#0055cc')
    expect(nearestPaletteColor([120, 120, 130], ['#000000', '#ffffff'])).toBe('#000000')
  })
})

describe('snapColor', () => {
  it('keeps a palette colour, in either case and in short form', () => {
    expect(snapColor('#0055CC', PALETTE)).toBeNull()
    expect(snapColor('#fff', PALETTE)).toBeNull()
  })

  it('keeps neutrals that are not in the palette', () => {
    expect(snapColor('#000000', PALETTE)).toBeNull()
    expect(snapColor('#808080', PALETTE)).toBeNull()
  })

  it('snaps an off-palette colour to the nearest palette colour', () => {
    expect(snapColor('#1060d0', PALETTE)).toBe('#0055cc')
    expect(snapColor('#e8b000', PALETTE)).toBe('#dd7700')
  })

  it('leaves values it cannot judge alone', () => {
    expect(snapColor('crimson', PALETTE)).toBeNull()
  })
})

describe('fontFamilies', () => {
  it('compares family lists without quotes, case or extra spaces', () => {
    expect(fontFamilies(`"Georgia",  SERIF`)).toBe(fontFamilies('Georgia, serif'))
    expect(fontFamilies('Inter')).not.toBe(fontFamilies('Georgia, serif'))
  })
})

describe('constrainOpsToBrand', () => {
  it('snaps an element colour and reports the change', () => {
    const ops: Op[] = [{ op: 'updateElement', slideId: 's1', elementId: 'e1', patch: { fill: '#1060d0', stroke: '#000000' } } as Op]
    const out = constrainOpsToBrand(ops, CONSTRAINT)
    expect(out.ops[0]).toMatchObject({ patch: { fill: '#0055cc', stroke: '#000000' } })
    expect(out.warnings).toEqual(['Colour #1060d0 was changed to the brand colour #0055cc.'])
  })

  it('snaps colours inside a theme and replaces off-kit fonts, role by role', () => {
    const ops: Op[] = [
      {
        op: 'setTheme',
        theme: {
          colors: { accent: '#e8b000', background: '#ffffff' },
          fonts: { heading: 'Comic Sans MS', body: 'Inter', mono: 'Courier' },
        },
      } as Op,
    ]
    const out = constrainOpsToBrand(ops, CONSTRAINT)
    expect(out.ops[0]).toMatchObject({
      theme: { colors: { accent: '#dd7700', background: '#ffffff' }, fonts: { heading: 'Georgia, serif', body: 'Helvetica, sans-serif', mono: 'Helvetica, sans-serif' } },
    })
    expect(out.warnings).toEqual(
      expect.arrayContaining(['Font "Comic Sans MS" was replaced with the brand font "Georgia, serif".', 'Font "Inter" was replaced with the brand font "Helvetica, sans-serif".']),
    )
  })

  it('uses the heading font for titles and the body font for other text, inside rich text too', () => {
    const ops: Op[] = [
      {
        op: 'addElement',
        slideId: 's1',
        element: {
          type: 'text',
          role: 'title',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          rotation: 0,
          locked: false,
          opacity: 1,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { fontFamily: 'Impact' } }] }] }] },
          style: { fontFamily: 'Impact', align: 'left', valign: 'top' },
        },
      } as unknown as Op,
    ]
    const out = constrainOpsToBrand(ops, CONSTRAINT)
    const el = (out.ops[0] as { element: { style: { fontFamily: string }; content: { content: Array<{ content: Array<{ marks: Array<{ attrs: { fontFamily: string } }> }> }> } } }).element
    expect(el.style.fontFamily).toBe('Georgia, serif')
    expect(el.content.content[0]!.content[0]!.marks[0]!.attrs.fontFamily).toBe('Georgia, serif')
  })

  it('keeps kit fonts and reports nothing when everything is on-brand', () => {
    const ops: Op[] = [{ op: 'setTheme', theme: { fonts: { heading: 'Georgia, serif', body: 'Helvetica, sans-serif' } } } as Op]
    const out = constrainOpsToBrand(ops, CONSTRAINT)
    expect(out.ops).toEqual(ops)
    expect(out.warnings).toEqual([])
  })

  it('keeps every id, and the input is not changed', () => {
    const ops: Op[] = [{ op: 'updateElement', slideId: 's1', elementId: 'e1', patch: { fill: '#1060d0' } } as Op]
    const before = JSON.stringify(ops)
    const out = constrainOpsToBrand(ops, CONSTRAINT)
    expect(JSON.stringify(ops)).toBe(before)
    expect(out.ops[0]).toMatchObject({ op: 'updateElement', slideId: 's1', elementId: 'e1' })
  })

  it('the snapped ops still apply to a deck with the kit theme', () => {
    const deck = kitDeck()
    const doc = deckToYDoc(deck)
    const out = constrainOpsToBrand([{ op: 'setTitle', title: 'Snapped' } as Op, { op: 'setTheme', theme: { colors: { accent: '#e8b000' } } } as Op], CONSTRAINT)
    applyOps(doc, out.ops)
    expect(yDocToDeck(doc).theme.colors.accent).toBe('#dd7700')
  })
})

function kitDeck(): Deck {
  const deck = createDeck('Kit')
  return {
    ...deck,
    theme: { ...deck.theme, colors: { ...deck.theme.colors, accent: '#0055cc' } },
    brand: {
      brandKitId: 'kit-1',
      palette: { background: '#ffffff', accent: '#0055cc', text: '#101820' },
      fonts: { heading: 'Georgia, serif', body: 'Helvetica, sans-serif' },
    },
  }
}

describe('brandConstraintFor', () => {
  it('is null for a deck without a kit', () => {
    expect(brandConstraintFor(createDeck('Plain'))).toBeNull()
  })

  it('reads the frozen palette and fonts, without duplicates', () => {
    expect(brandConstraintFor(kitDeck())).toEqual({
      palette: ['#ffffff', '#0055cc', '#101820'],
      headingFont: 'Georgia, serif',
      bodyFont: 'Helvetica, sans-serif',
    })
  })

  it('ignores a palette that is not hex, and gives up when nothing is left', () => {
    const deck = kitDeck()
    deck.brand = { brandKitId: 'k', palette: { accent: 'crimson' } }
    expect(brandConstraintFor(deck)).toBeNull()
  })
})

describe('prompt and theme rules', () => {
  it('the deck description states the kit palette and fonts', () => {
    const text = describeDeck(kitDeck()).text
    expect(text).toContain('Brand kit: use only these colours #ffffff #0055cc #101820')
    expect(text).toContain('heading Georgia, serif, body Helvetica, sans-serif')
  })

  it('the description has no brand line without a kit', () => {
    expect(describeDeck(createDeck('Plain')).text).not.toContain('Brand kit')
  })

  it('generateTheme is refused on a deck with a kit, before any model call', async () => {
    const env = { provider: {} as never, deck: kitDeck() } as AbilityEnv
    await expect(generateTheme(env, { prompt: 'dark theme' })).rejects.toBeInstanceOf(LlmError)
    await expect(generateTheme(env, { prompt: 'dark theme' })).rejects.toThrow(/brand kit/)
  })
})

describe('fontFamilies with the constraint font stacks', () => {
  it('matches the stacks the kit stores', () => {
    expect(fontFamilies(CONSTRAINT.headingFont)).toBe('georgia,serif')
    expect(fontFamilies(CONSTRAINT.bodyFont)).toBe('helvetica,sans-serif')
  })
})


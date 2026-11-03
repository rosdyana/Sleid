import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, type ShapeElement, type TextElement, type VectorElement } from '@sleid/model'
import { boxRadius, boxShapeStyle, scaledShadow, shapeSvgPaint, textBoxStyle, textStyleMarkCss, visibleVectorPaths, vectorPathProps, vectorViewBox, imageWrapStyle } from './element-style.ts'

const theme = BUILT_IN_THEMES[0]!
const base = { id: 'a', x: 0, y: 0, w: 100, h: 100, rotation: 0, z: 1, locked: false, opacity: 1 }

function text(over: Partial<TextElement> = {}, style: Partial<TextElement['style']> = {}): TextElement {
  return {
    ...base,
    type: 'text',
    content: { type: 'doc', content: [] },
    style: { align: 'left', valign: 'top', ...style },
    ...over,
  } as TextElement
}

function shape(over: Partial<ShapeElement>): ShapeElement {
  return { ...base, type: 'shape', shape: 'rect', fill: '#ff0000', stroke: '#000000', strokeWidth: 2, ...over } as ShapeElement
}

describe('text box style (M10)', () => {
  it('uses the body font, or the heading font for a title, when the element has none', () => {
    expect(textBoxStyle(text(), theme, 1).fontFamily).toBe(`${theme.fonts.body}, sans-serif`)
    expect(textBoxStyle(text({ role: 'title' }), theme, 1).fontFamily).toBe(`${theme.fonts.heading}, sans-serif`)
  })

  it('keeps an element font when it has one', () => {
    expect(textBoxStyle(text({}, { fontFamily: 'Georgia' }), theme, 1).fontFamily).toBe('Georgia, sans-serif')
  })

  it('line height is normal when unset', () => {
    expect(textBoxStyle(text(), theme, 1).lineHeight).toBe('normal')
    expect(textBoxStyle(text({}, { lineHeight: 1.4 }), theme, 1).lineHeight).toBe(1.4)
  })

  it('scales the shadow and passes weight, spacing and case through', () => {
    const style = textBoxStyle(text({ shadow: { x: 2, y: 4, blur: 6, color: '#000' } }, { fontWeight: 700, letterSpacing: 0.1, textTransform: 'uppercase' }), theme, 0.5)
    expect(style.textShadow).toBe('1px 2px 3px #000')
    expect(style.fontWeight).toBe(700)
    expect(style.letterSpacing).toBe('0.1em')
    expect(style.textTransform).toBe('uppercase')
  })
})

describe('shape box style (M10)', () => {
  it('a roundRect without a radius keeps the legacy 12% corner, and a set radius is scaled', () => {
    expect(boxRadius(shape({ shape: 'roundRect' }), 1)).toBe('12%')
    expect(boxRadius(shape({ shape: 'roundRect', radius: 20 }), 0.5)).toBe('10px')
    expect(boxRadius(shape({ shape: 'ellipse' }), 1)).toBe('50%')
  })

  it('draws the border inside the box, scaled, with the dash style', () => {
    const s = boxShapeStyle(shape({ strokeDash: 'dashed' }), 0.5)
    expect(s.boxSizing).toBe('border-box')
    expect(s.border).toBe('1px dashed #000000')
    expect(s.backgroundColor).toBe('#ff0000')
  })

  it('uses the gradient as the background when there is one', () => {
    const s = boxShapeStyle(shape({ gradient: { type: 'linear', angle: 90, stops: [{ color: '#fff', at: 0 }, { color: '#000', at: 1 }] } }), 1)
    expect(s.background).toBe('linear-gradient(90deg, #fff 0%, #000 100%)')
    expect(s.backgroundColor).toBeUndefined()
  })

  it('scales a box shadow with its spread', () => {
    expect(scaledShadow({ x: 0, y: 8, blur: 24, spread: 4, color: 'rgba(0,0,0,0.1)' }, 0.5)).toBe('0px 4px 12px 2px rgba(0,0,0,0.1)')
    expect(boxShapeStyle(shape({ shadow: { x: 0, y: 8, blur: 24, color: 'rgba(0,0,0,0.1)' } }), 0.5).boxShadow).toBe('0px 4px 12px 0px rgba(0,0,0,0.1)')
  })

  it('SVG shapes take the first gradient stop as the fill and a drop shadow filter', () => {
    const p = shapeSvgPaint(shape({ shape: 'star', gradient: { type: 'radial', stops: [{ color: '#111', at: 0 }, { color: '#222', at: 1 }] }, shadow: { x: 1, y: 2, blur: 3, color: '#000' } }), 1)
    expect(p.fill).toBe('#111')
    expect(p.filter).toBe('drop-shadow(1px 2px 3px #000)')
  })
})

describe('image wrapper and vector (M10)', () => {
  it('an image radius is scaled and clips, and its shadow is scaled', () => {
    const w = imageWrapStyle({ ...base, type: 'image', src: '', fit: 'cover', radius: 40, shadow: { x: 0, y: 4, blur: 8, color: '#000' } } as never, 0.5)
    expect(w.borderRadius).toBe('20px')
    expect(w.overflow).toBe('hidden')
    expect(w.boxShadow).toBe('0px 2px 4px 0px #000')
  })

  it('vector output matches the renderer attributes and skips paths that fail the d check', () => {
    const el = {
      ...base,
      type: 'vector',
      viewBox: { x: 0, y: 0, w: 10, h: 10 },
      preserveAspectRatio: false,
      paths: [
        { d: 'M0 0L10 10', fill: 'none', stroke: '#000', strokeWidth: 2, lineCap: 'round', opacity: 0.5 },
        { d: '<script>', fill: '#000', stroke: 'none', strokeWidth: 0 },
      ],
    } as unknown as VectorElement
    expect(vectorViewBox(el)).toBe('0 0 10 10')
    const paths = visibleVectorPaths(el)
    expect(paths).toHaveLength(1)
    expect(vectorPathProps(paths[0]!)).toEqual({ d: 'M0 0L10 10', fill: 'transparent', stroke: '#000', strokeWidth: 2, strokeLinecap: 'round', opacity: 0.5 })
  })
})

describe('text style mark (M10)', () => {
  it('accepts a number, a three-digit numeric string, or a keyword weight', () => {
    expect(textStyleMarkCss({ fontWeight: 650 }).fontWeight).toBe(650)
    expect(textStyleMarkCss({ fontWeight: '650' }).fontWeight).toBe(650)
    expect(textStyleMarkCss({ fontWeight: 'bold' }).fontWeight).toBe('bold')
    expect(textStyleMarkCss({ fontWeight: '50' }).fontWeight).toBeUndefined()
    expect(textStyleMarkCss({ letterSpacing: '0.05em' }).letterSpacing).toBe('0.05em')
  })
})

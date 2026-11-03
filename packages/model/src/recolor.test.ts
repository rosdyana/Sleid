import { describe, expect, it } from 'vitest'
import { colorKey, recolorSlideElements, tokenColorMap, type Element } from './index.ts'

const base = { id: 'e', rotation: 0, locked: false, opacity: 1, x: 0, y: 0, w: 100, h: 100, z: 0 }

function textEl(color: string | undefined, marks: Array<{ type: 'textStyle'; attrs: { color: string } }> = []): Element {
  return {
    ...base,
    type: 'text',
    style: { align: 'left', valign: 'top', ...(color === undefined ? {} : { color }) },
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain' },
            { type: 'text', text: 'marked', marks },
            { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'deep', marks }] }] }] },
          ],
        },
      ],
    },
  } as Element
}

describe('colorKey', () => {
  it('normalises case, short hex, and opaque rgb to hex', () => {
    expect(colorKey(' #ABC ')).toBe('#aabbcc')
    expect(colorKey('#1A73E8')).toBe('#1a73e8')
    expect(colorKey('rgb(26, 115, 232)')).toBe('#1a73e8')
    expect(colorKey('rgba(26,115,232,1)')).toBe('#1a73e8')
  })

  it('keeps a translucent colour as written (lower case)', () => {
    expect(colorKey('rgba(26,115,232,0.5)')).toBe('rgba(26,115,232,0.5)')
    expect(colorKey('RGBA(255,255,255,0.06)')).toBe('rgba(255,255,255,0.06)')
  })
})

describe('recolorSlideElements', () => {
  it('replaces the text colour and every textStyle mark at any depth', () => {
    const el = textEl('#202124', [{ type: 'textStyle', attrs: { color: '#202124' } }])
    const [out] = recolorSlideElements([el], { '#202124': '#f5f7fa' })
    expect(out).toMatchObject({ style: { color: '#f5f7fa' } })
    const para = (out as Extract<Element, { type: 'text' }>).content.content![0]!
    expect(para.content![1]!.marks![0]).toEqual({ type: 'textStyle', attrs: { color: '#f5f7fa' } })
    // paragraph > bulletList > listItem > paragraph > text (the list is the third child of the first paragraph)
    const list = para.content![2] as unknown as { content: Array<{ content: Array<{ content: Array<{ marks: unknown[] }> }> }> }
    const deep = list.content[0]!.content[0]!.content[0]!
    expect(deep.marks[0]).toEqual({ type: 'textStyle', attrs: { color: '#f5f7fa' } })
  })

  it('matches colours by colorKey, so a short hex in the element still matches', () => {
    const [out] = recolorSlideElements([textEl('#AAA')], { '#aaaaaa': '#000000' })
    expect(out).toMatchObject({ style: { color: '#000000' } })
  })

  it('changes only exact matches', () => {
    const [out] = recolorSlideElements([textEl('#202125')], { '#202124': '#f5f7fa' })
    expect(out).toMatchObject({ style: { color: '#202125' } })
  })

  it('does not change the input', () => {
    const el = textEl('#202124')
    const before = JSON.stringify(el)
    recolorSlideElements([el], { '#202124': '#f5f7fa' })
    expect(JSON.stringify(el)).toBe(before)
  })

  it('returns the elements unchanged when the map is empty', () => {
    const el = textEl('#202124')
    expect(recolorSlideElements([el], {})).toEqual([el])
  })

  it('recolours shape fill, stroke, gradient stops and the rich text inside a shape', () => {
    const shape: Element = {
      ...base,
      type: 'shape',
      shape: 'rect',
      fill: '#0b57d0',
      stroke: '#0b57d0',
      strokeWidth: 1,
      gradient: {
        type: 'linear',
        stops: [
          { color: '#0b57d0', at: 0 },
          { color: '#ffffff', at: 1 },
        ],
      },
      text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { color: '#0b57d0' } }] }] }] },
    }
    const [out] = recolorSlideElements([shape], { '#0b57d0': '#8ab4f8' })
    const s = out as Extract<Element, { type: 'shape' }>
    expect(s.fill).toBe('#8ab4f8')
    expect(s.stroke).toBe('#8ab4f8')
    expect(s.gradient!.stops.map((st) => st.color)).toEqual(['#8ab4f8', '#ffffff'])
    expect(JSON.stringify(s.text)).toContain('"color":"#8ab4f8"')
  })

  it('recolours vector path fill and stroke', () => {
    const vector: Element = {
      ...base,
      type: 'vector',
      viewBox: { x: 0, y: 0, w: 24, h: 24 },
      paths: [
        { d: 'M0 0L1 1', fill: '#202124', stroke: 'none', strokeWidth: 0 },
        { d: 'M0 0L2 2', fill: 'none', stroke: '#202124', strokeWidth: 2 },
      ],
      preserveAspectRatio: true,
    }
    const [out] = recolorSlideElements([vector], { '#202124': '#f5f7fa' })
    const v = out as Extract<Element, { type: 'vector' }>
    expect(v.paths.map((p) => p.fill)).toEqual(['#f5f7fa', 'none'])
    expect(v.paths.map((p) => p.stroke)).toEqual(['none', '#f5f7fa'])
  })

  it('recolours chart series colours and table style values that are colours', () => {
    const chart: Element = {
      ...base,
      type: 'chart',
      chartType: 'bar',
      data: { columns: ['k', 'v'], rows: [['a', 1]] },
      options: { legend: true, colors: ['#0b57d0', '#188038'] },
    }
    const table: Element = {
      ...base,
      type: 'table',
      rows: [['a']],
      header: true,
      style: { headerFill: '#0b57d0', rowGap: 4 },
    }
    const [c, t] = recolorSlideElements([chart, table], { '#0b57d0': '#8ab4f8' })
    expect((c as Extract<Element, { type: 'chart' }>).options.colors).toEqual(['#8ab4f8', '#188038'])
    expect((t as Extract<Element, { type: 'table' }>).style).toEqual({ headerFill: '#8ab4f8', rowGap: 4 })
  })
})

describe('tokenColorMap', () => {
  it('maps each old colour to the new one, and skips pairs that are already equal', () => {
    expect(tokenColorMap({ text: '#000000', muted: '#111111' }, { text: '#000000', muted: '#222222' })).toEqual({ '#111111': '#222222' })
  })

  it('gives a shared old colour to the first key in order', () => {
    expect(tokenColorMap({ text: '#777777', muted: '#777777' }, { text: '#ffffff', muted: '#000000' })).toEqual({ '#777777': '#ffffff' })
  })

  it('leaves a shared colour alone when the first key does not change it', () => {
    // text keeps #777777, so the muted token's change must not capture the text colour.
    expect(tokenColorMap({ text: '#777777', muted: '#777777' }, { text: '#777777', muted: '#000000' })).toEqual({})
  })
})

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyOps, BUILT_IN_THEMES, createDeck, deckToYDoc, deriveDarkVariant, OpError, yDocToDeck, type Deck } from './index.ts'

function setup(): { doc: Y.Doc; deck: Deck } {
  const deck = createDeck('Ops')
  return { doc: deckToYDoc(deck), deck }
}

const rectElement = (overrides: Record<string, unknown> = {}) => ({
  type: 'shape',
  shape: 'rect',
  x: 10,
  y: 20,
  w: 100,
  h: 50,
  rotation: 0,
  locked: false,
  opacity: 1,
  fill: '#ff0000',
  stroke: '#000000',
  strokeWidth: 2,
  ...overrides,
})

const firstSlideId = (doc: Y.Doc) => yDocToDeck(doc).slides[0]!.id

describe('applyOps: slides', () => {
  it('addSlide appends by default, uses the layout placeholders, and returns the id', () => {
    const { doc } = setup()
    const { results } = applyOps(doc, [{ op: 'addSlide', layout: 'title-content' }])
    const deck = yDocToDeck(doc)
    expect(deck.slides).toHaveLength(2)
    const added = deck.slides[1]!
    expect(results).toEqual([{ ok: true, id: added.id }])
    expect(added.layout).toBe('title-content')
    expect(added.elements.map((e) => e.id)).toEqual([`${added.id}-0`, `${added.id}-1`])
    expect(added.elements.map((e) => e.type)).toEqual(['text', 'text'])
  })

  it('addSlide honours index and an explicit slide body', () => {
    const { doc } = setup()
    const { results } = applyOps(doc, [
      { op: 'addSlide', index: 0, layout: 'blank', slide: { id: 'first', notes: 'hi', elements: [rectElement({ id: 'r1' })] } },
    ])
    const deck = yDocToDeck(doc)
    expect(results[0]).toEqual({ ok: true, id: 'first' })
    expect(deck.slides[0]).toMatchObject({ id: 'first', notes: 'hi', layout: 'blank' })
    expect(deck.slides[0]!.elements[0]!.id).toBe('r1')
  })

  it('deleteSlide removes the slide', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    applyOps(doc, [{ op: 'deleteSlide', slideId: id }])
    expect(yDocToDeck(doc).slides).toHaveLength(0)
  })

  it('duplicateSlide inserts a copy after the source with new ids', () => {
    const { doc } = setup()
    const src = firstSlideId(doc)
    applyOps(doc, [{ op: 'addElement', slideId: src, element: rectElement({ id: 'r1' }) }])
    const { results } = applyOps(doc, [{ op: 'duplicateSlide', slideId: src, newSlideId: 'copy' }])
    const deck = yDocToDeck(doc)
    expect(results[0]).toEqual({ ok: true, id: 'copy' })
    expect(deck.slides.map((s) => s.id)).toEqual([src, 'copy'])
    const [orig, copy] = deck.slides
    expect(copy!.elements).toHaveLength(orig!.elements.length)
    expect(copy!.elements[0]!.id).not.toBe(orig!.elements[0]!.id)
    expect(copy!.elements[0]).toMatchObject({ type: 'text' })
  })

  it('moveSlide puts the slide at the final index', () => {
    const { doc } = setup()
    applyOps(doc, [
      { op: 'addSlide', layout: 'blank', slide: { id: 'b' } },
      { op: 'addSlide', layout: 'blank', slide: { id: 'c' } },
    ])
    const first = firstSlideId(doc)
    applyOps(doc, [{ op: 'moveSlide', slideId: first, toIndex: 2 }])
    expect(yDocToDeck(doc).slides.map((s) => s.id)).toEqual(['b', 'c', first])
    applyOps(doc, [{ op: 'moveSlide', slideId: first, toIndex: 99 }])
    expect(yDocToDeck(doc).slides.map((s) => s.id)).toEqual(['b', 'c', first])
  })

  it('updateSlide patches meta fields and clears optional ones with null', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    applyOps(doc, [{ op: 'addSection', id: 'sec', name: 'Intro' }])
    applyOps(doc, [
      { op: 'updateSlide', slideId: id, patch: { sectionId: 'sec', transition: 'fade', hidden: true, background: { type: 'color', value: '#123456' } } },
    ])
    let slide = yDocToDeck(doc).slides[0]!
    expect(slide).toMatchObject({ sectionId: 'sec', transition: 'fade', hidden: true, background: { type: 'color', value: '#123456' } })
    applyOps(doc, [{ op: 'updateSlide', slideId: id, patch: { sectionId: null, background: null } }])
    slide = yDocToDeck(doc).slides[0]!
    expect(slide.sectionId).toBeUndefined()
    expect(slide.background).toBeUndefined()
  })

  it('setNotes writes the speaker notes', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    applyOps(doc, [{ op: 'setNotes', slideId: id, notes: 'say this' }])
    expect(yDocToDeck(doc).slides[0]!.notes).toBe('say this')
  })
})

describe('applyOps: elements', () => {
  it('addElement assigns an id and a z above the current top', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    const { results } = applyOps(doc, [{ op: 'addElement', slideId: id, element: rectElement() }])
    const added = yDocToDeck(doc).slides[0]!.elements.find((e) => e.id === results[0]!.id)
    expect(added).toMatchObject({ type: 'shape', x: 10 })
    const topZ = Math.max(...yDocToDeck(doc).slides[0]!.elements.map((e) => e.z))
    expect(added!.z).toBe(topZ)
  })

  it('updateElement deep-merges the patch and keeps untouched fields', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    applyOps(doc, [{ op: 'addElement', slideId: id, element: rectElement({ id: 'r1', animation: { effect: 'fade-in', order: 0 } }) }])
    applyOps(doc, [{ op: 'updateElement', slideId: id, elementId: 'r1', patch: { x: 500, animation: { order: 3 }, alt: 'box' } }])
    const el = yDocToDeck(doc).slides[0]!.elements.find((e) => e.id === 'r1')
    expect(el).toMatchObject({ x: 500, y: 20, alt: 'box', animation: { effect: 'fade-in', order: 3 }, fill: '#ff0000' })
  })

  it('updateElement with null deletes an optional field', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    applyOps(doc, [{ op: 'addElement', slideId: id, element: rectElement({ id: 'r1', alt: 'x' }) }])
    applyOps(doc, [{ op: 'updateElement', slideId: id, elementId: 'r1', patch: { alt: null } }])
    expect(yDocToDeck(doc).slides[0]!.elements.find((e) => e.id === 'r1')!.alt).toBeUndefined()
  })

  it('updateElement replaces chart data as a whole', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    const chart = {
      id: 'c1',
      type: 'chart',
      chartType: 'bar',
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      rotation: 0,
      locked: false,
      opacity: 1,
      z: 0,
      data: { columns: ['k', 'v'], rows: [['a', 1]] },
      options: { legend: false },
    }
    applyOps(doc, [{ op: 'addElement', slideId: id, element: chart }])
    applyOps(doc, [
      {
        op: 'updateElement',
        slideId: id,
        elementId: 'c1',
        patch: { data: { columns: ['k', 'v', 'w'], rows: [['a', 1, 2], ['b', 3, 4]] } },
      },
    ])
    const el = yDocToDeck(doc).slides[0]!.elements.find((e) => e.id === 'c1')
    expect(el).toMatchObject({ type: 'chart', data: { columns: ['k', 'v', 'w'], rows: [['a', 1, 2], ['b', 3, 4]] } })
  })

  it('updateElement rejects changing id or type, and unknown fields', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    applyOps(doc, [{ op: 'addElement', slideId: id, element: rectElement({ id: 'r1' }) }])
    expect(() => applyOps(doc, [{ op: 'updateElement', slideId: id, elementId: 'r1', patch: { id: 'other' } }])).toThrow(OpError)
    expect(() => applyOps(doc, [{ op: 'updateElement', slideId: id, elementId: 'r1', patch: { type: 'text' } }])).toThrow(OpError)
    expect(() => applyOps(doc, [{ op: 'updateElement', slideId: id, elementId: 'r1', patch: { bogus: 1 } }])).toThrow(/unknown field/)
  })

  it('deleteElement removes the element', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    const before = yDocToDeck(doc).slides[0]!.elements.length
    applyOps(doc, [{ op: 'deleteElement', slideId: id, elementId: yDocToDeck(doc).slides[0]!.elements[0]!.id }])
    expect(yDocToDeck(doc).slides[0]!.elements).toHaveLength(before - 1)
  })

  it('reorderElement moves z front, back, forward and backward', () => {
    const { doc } = setup()
    const id = "rz"
    applyOps(doc, [{ op: 'addSlide', layout: 'blank', slide: { id } }, 
      { op: 'addElement', slideId: id, element: rectElement({ id: 'a', z: 1 }) },
      { op: 'addElement', slideId: id, element: rectElement({ id: 'b', z: 2 }) },
      { op: 'addElement', slideId: id, element: rectElement({ id: 'c', z: 3 }) },
    ])
    const slideElements = () => yDocToDeck(doc).slides.find((s) => s.id === id)!.elements
    const zOf = (elementId: string) => slideElements().find((e) => e.id === elementId)!.z
    const ordered = () => [...slideElements()].sort((p, q) => p.z - q.z).map((e) => e.id)

    applyOps(doc, [{ op: 'reorderElement', slideId: id, elementId: 'a', z: 'front' }])
    expect(ordered().at(-1)).toBe('a')
    applyOps(doc, [{ op: 'reorderElement', slideId: id, elementId: 'a', z: 'back' }])
    expect(ordered()[0]).toBe('a')
    applyOps(doc, [{ op: 'reorderElement', slideId: id, elementId: 'a', z: 'forward' }])
    // a: 1 -> 2 (swapped with b), b: 2 -> 1
    expect(zOf('a')).toBe(2)
    expect(zOf('b')).toBe(1)
    applyOps(doc, [{ op: 'reorderElement', slideId: id, elementId: 'c', z: 'backward' }])
    // c: 3 -> 2 (swapped with a, which was the nearest below), a: 2 -> 3
    expect(zOf('c')).toBe(2)
    expect(zOf('a')).toBe(3)
  })
})

describe('applyOps: theme, title, sections', () => {
  it('setTheme merges a partial theme and keeps other tokens', () => {
    const { doc, deck } = setup()
    applyOps(doc, [{ op: 'setTheme', theme: { colors: { accent: '#00ff00' }, radius: 4 } }])
    const theme = yDocToDeck(doc).theme
    expect(theme.colors.accent).toBe('#00ff00')
    expect(theme.colors.text).toBe(deck.theme.colors.text)
    expect(theme.radius).toBe(4)
    expect(theme.fonts).toEqual(deck.theme.fonts)
  })

  it('setTheme rejects a result that fails validation', () => {
    const { doc } = setup()
    expect(() => applyOps(doc, [{ op: 'setTheme', theme: { sizes: { title: -1 } } }])).toThrow(OpError)
  })

  it('setTitle changes the title', () => {
    const { doc } = setup()
    applyOps(doc, [{ op: 'setTitle', title: 'Renamed' }])
    expect(yDocToDeck(doc).title).toBe('Renamed')
  })

  it('addSection, renameSection and deleteSection work, and deleteSection clears slide links', () => {
    const { doc } = setup()
    const slideId = firstSlideId(doc)
    const { results } = applyOps(doc, [{ op: 'addSection', name: 'Part 1', index: 0 }])
    const sectionId = results[0]!.id!
    applyOps(doc, [
      { op: 'renameSection', sectionId, name: 'Part one' },
      { op: 'updateSlide', slideId, patch: { sectionId } },
    ])
    expect(yDocToDeck(doc).sections).toEqual([{ id: sectionId, name: 'Part one' }])
    applyOps(doc, [{ op: 'deleteSection', sectionId }])
    const deck = yDocToDeck(doc)
    expect(deck.sections).toEqual([])
    expect(deck.slides[0]!.sectionId).toBeUndefined()
  })
})

describe('applyOps: invalid targets and no partial apply', () => {
  it('reports the failing op index and reason', () => {
    const { doc } = setup()
    const id = firstSlideId(doc)
    try {
      applyOps(doc, [{ op: 'setTitle', title: 'ok' }, { op: 'deleteElement', slideId: id, elementId: 'nope' }])
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(OpError)
      expect((err as OpError).opIndex).toBe(1)
      expect((err as OpError).opName).toBe('deleteElement')
      expect((err as OpError).reason).toMatch(/element not found/)
    }
  })

  it('a batch with a bad op applies nothing, and fires no update event', () => {
    const { doc, deck } = setup()
    const id = firstSlideId(doc)
    let updates = 0
    doc.on('update', () => updates++)
    const batch = [
      { op: 'setTitle', title: 'should not stick' },
      { op: 'addSlide', layout: 'blank' },
      { op: 'addElement', slideId: id, element: rectElement({ id: 'r1' }) },
      { op: 'updateElement', slideId: 'missing-slide', elementId: 'r1', patch: { x: 1 } },
    ]
    expect(() => applyOps(doc, batch)).toThrow(OpError)
    expect(updates).toBe(0)
    expect(yDocToDeck(doc)).toEqual(deck)
  })

  it('an invalid op shape is rejected at parse time', () => {
    const { doc } = setup()
    expect(() => applyOps(doc, [{ op: 'explode' }])).toThrow(/deck-op 0 \(explode\)/)
    expect(() => applyOps(doc, [{ op: 'addElement', slideId: 's', element: { type: 'shape' } }])).toThrow(OpError)
  })

  it('an addElement with a duplicate id fails and leaves the slide alone', () => {
    const { doc, deck } = setup()
    const id = firstSlideId(doc)
    applyOps(doc, [{ op: 'addElement', slideId: id, element: rectElement({ id: 'r1' }) }])
    const before = yDocToDeck(doc)
    expect(() => applyOps(doc, [{ op: 'addElement', slideId: id, element: rectElement({ id: 'r1' }) }])).toThrow(/already exists/)
    expect(yDocToDeck(doc)).toEqual(before)
    expect(before.slides[0]!.elements.length).toBe(deck.slides[0]!.elements.length + 1)
  })

  it('a deleted slide cannot be addressed by a later op in the same batch', () => {
    const { doc, deck } = setup()
    const id = firstSlideId(doc)
    expect(() =>
      applyOps(doc, [
        { op: 'deleteSlide', slideId: id },
        { op: 'setNotes', slideId: id, notes: 'gone' },
      ]),
    ).toThrow(/slide not found/)
    expect(yDocToDeck(doc)).toEqual(deck)
  })

  it('an addSlide that refers to a missing section fails', () => {
    const { doc } = setup()
    expect(() => applyOps(doc, [{ op: 'addSlide', layout: 'blank', slide: { sectionId: 'nope' } }])).toThrow(/section not found/)
  })

  it('a batch can address what an earlier op in the same batch created', () => {
    const { doc } = setup()
    const { results } = applyOps(doc, [
      { op: 'addSlide', layout: 'blank', slide: { id: 'new' } },
      { op: 'addElement', slideId: 'new', element: rectElement({ id: 'r9' }) },
      { op: 'setNotes', slideId: 'new', notes: 'built in one batch' },
    ])
    expect(results.map((r) => r.ok)).toEqual([true, true, true])
    const slide = yDocToDeck(doc).slides.find((s) => s.id === 'new')!
    expect(slide.elements.map((e) => e.id)).toEqual(['r9'])
    expect(slide.notes).toBe('built in one batch')
  })
})

describe('applyOps: M10 fields', () => {
  it('duplicateSlide gives each copy the source key, or the source id when it has none (M10)', () => {
    const { doc } = setup()
    const src = firstSlideId(doc)
    applyOps(doc, [
      { op: 'addElement', slideId: src, element: rectElement({ id: 'plain' }) },
      { op: 'addElement', slideId: src, element: rectElement({ id: 'hero-src', animateKey: 'hero' }) },
    ])
    applyOps(doc, [{ op: 'duplicateSlide', slideId: src, newSlideId: 'copy' }])
    const [orig, copy] = yDocToDeck(doc).slides
    const plainCopy = copy!.elements.find((e) => e.id !== 'plain' && e.id !== 'hero-src' && e.type === 'shape' && e.animateKey === 'plain')
    const heroCopy = copy!.elements.find((e) => e.animateKey === 'hero')
    expect(plainCopy).toBeDefined()
    expect(heroCopy).toBeDefined()
    // The source keeps its own keys: none for the plain element, so it matches the copy through its id.
    expect(orig!.elements.find((e) => e.id === 'plain')!.animateKey).toBeUndefined()
    expect(orig!.elements.find((e) => e.id === 'hero-src')!.animateKey).toBe('hero')
  })

  it('duplicateSlide leaves a copy without a key when the source id cannot be a reveal key', () => {
    const { doc } = setup()
    const src = firstSlideId(doc)
    applyOps(doc, [{ op: 'addElement', slideId: src, element: rectElement({ id: 'has.dot' }) }])
    const { results } = applyOps(doc, [{ op: 'duplicateSlide', slideId: src, newSlideId: 'copy2' }])
    expect(results[0]).toEqual({ ok: true, id: 'copy2' })
    const copy = yDocToDeck(doc).slides.find((s) => s.id === 'copy2')!
    expect(copy.elements.some((e) => e.animateKey !== undefined && e.animateKey.includes('.'))).toBe(false)
  })

  it('updateElement writes the new fields, replaces paths whole, and removes a gradient on null', () => {
    const { doc } = setup()
    const src = firstSlideId(doc)
    applyOps(doc, [
      { op: 'addElement', slideId: src, element: rectElement({ id: 's1', gradient: { type: 'linear', stops: [{ color: '#000000', at: 0 }, { color: '#ffffff', at: 1 }] } }) },
      {
        op: 'addElement',
        slideId: src,
        element: {
          type: 'vector',
          id: 'v1',
          x: 0,
          y: 0,
          w: 100,
          h: 100,
          rotation: 0,
          locked: false,
          opacity: 1,
          viewBox: { x: 0, y: 0, w: 24, h: 24 },
          paths: [{ d: 'M0 0L1 1', fill: '#000000', stroke: 'none', strokeWidth: 0 }],
          preserveAspectRatio: true,
        },
      },
    ])
    applyOps(doc, [
      { op: 'updateElement', slideId: src, elementId: 'v1', patch: { paths: [{ d: 'M2 2L3 3', fill: '#ff0000', stroke: 'none', strokeWidth: 0 }] } },
      { op: 'updateElement', slideId: src, elementId: 's1', patch: { gradient: null, radius: 8, animateKey: 'key-1', shadow: { x: 1, y: 1, blur: 2, color: '#000000' } } },
    ])
    const deck = yDocToDeck(doc)
    const els = deck.slides[0]!.elements
    expect(els.find((e) => e.id === 'v1')).toMatchObject({ paths: [{ d: 'M2 2L3 3', fill: '#ff0000' }] })
    expect(els.find((e) => e.id === 's1')).toMatchObject({ radius: 8, animateKey: 'key-1', shadow: { blur: 2 } })
    expect(els.find((e) => e.id === 's1')).not.toHaveProperty('gradient')
  })

  it('rejects a vector path whose d has characters outside the path grammar', () => {
    const { doc } = setup()
    const src = firstSlideId(doc)
    expect(() =>
      applyOps(doc, [
        {
          op: 'addElement',
          slideId: src,
          element: {
            type: 'vector',
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            rotation: 0,
            locked: false,
            opacity: 1,
            viewBox: { x: 0, y: 0, w: 1, h: 1 },
            paths: [{ d: 'M0 0" onload="x', fill: '#000000', stroke: 'none', strokeWidth: 0 }],
            preserveAspectRatio: true,
          },
        },
      ]),
    ).toThrow(OpError)
  })
})

describe('applyOps: M11 variants, theme recolour and deck options', () => {
  const textColours = (doc: Y.Doc, slideId: string) =>
    yDocToDeck(doc)
      .slides.find((s) => s.id === slideId)!
      .elements.map((e) => (e.type === 'text' ? e.style.color : undefined))

  it('setDeckOptions sets and clears the secondary language', () => {
    const { doc } = setup()
    applyOps(doc, [{ op: 'setDeckOptions', secondaryLanguage: 'id-ID' }])
    expect(yDocToDeck(doc).secondaryLanguage).toBe('id-ID')
    applyOps(doc, [{ op: 'setDeckOptions', secondaryLanguage: null }])
    expect(yDocToDeck(doc)).not.toHaveProperty('secondaryLanguage')
  })

  it('setDeckOptions refuses a value that is not a language tag', () => {
    const { doc } = setup()
    expect(() => applyOps(doc, [{ op: 'setDeckOptions', secondaryLanguage: 'english please' }])).toThrow(OpError)
  })

  it('setTheme to Midnight recolours the title slide that createDeck built with Sheets colours', () => {
    const { doc } = setup()
    const midnight = BUILT_IN_THEMES.find((t) => t.name === 'Midnight')!
    applyOps(doc, [{ op: 'setTheme', theme: midnight }])
    const title = yDocToDeck(doc).slides[0]!
    const colourOf = (role: 'title' | 'subtitle') => {
      const el = title.elements.find((e) => e.type === 'text' && e.role === role)
      return el?.type === 'text' ? el.style.color : undefined
    }
    expect(colourOf('title')).toBe(midnight.colors.text)
    expect(colourOf('subtitle')).toBe(midnight.colors.muted)
  })

  it('setBrandKit recolours the existing slides with the kit palette', () => {
    const { doc } = setup()
    const kit = BUILT_IN_THEMES.find((t) => t.name === 'Warm Paper')!
    applyOps(doc, [{ op: 'setBrandKit', brandKitId: 'kit-1', theme: kit }])
    const title = yDocToDeck(doc).slides[0]!
    expect(title.elements.find((e) => e.type === 'text' && e.role === 'title')).toMatchObject({ style: { color: kit.colors.text } })
  })

  it('addSlide with variant dark puts the dark colours on its placeholders and sets the dark background', () => {
    const { doc } = setup()
    const dark = deriveDarkVariant(yDocToDeck(doc).theme)
    applyOps(doc, [{ op: 'addSlide', layout: 'title', slide: { id: 'dk', variant: 'dark' } }])
    const slide = yDocToDeck(doc).slides.find((s) => s.id === 'dk')!
    expect(slide).toMatchObject({ variant: 'dark', background: dark.background })
    expect(textColours(doc, 'dk')).toEqual([dark.text, dark.muted])
  })

  it('addSlide without a variant stays light: no background, the theme colours', () => {
    const { doc } = setup()
    const theme = yDocToDeck(doc).theme
    applyOps(doc, [{ op: 'addSlide', layout: 'title', slide: { id: 'lt' } }])
    const slide = yDocToDeck(doc).slides.find((s) => s.id === 'lt')!
    expect(slide.variant).toBeUndefined()
    expect(slide.background).toBeUndefined()
    expect(textColours(doc, 'lt')).toEqual([theme.colors.text, theme.colors.muted])
  })

  it('updateSlide to dark and back restores the light colours and removes the dark background', () => {
    const { doc } = setup()
    const theme = yDocToDeck(doc).theme
    const dark = deriveDarkVariant(theme)
    applyOps(doc, [{ op: 'addSlide', layout: 'title-content', slide: { id: 'tog' } }])
    const light = textColours(doc, 'tog')
    expect(light).toEqual([theme.colors.text, theme.colors.text])

    applyOps(doc, [{ op: 'updateSlide', slideId: 'tog', patch: { variant: 'dark' } }])
    expect(yDocToDeck(doc).slides.find((s) => s.id === 'tog')).toMatchObject({ variant: 'dark', background: dark.background })
    expect(textColours(doc, 'tog')).toEqual([dark.text, dark.text])

    applyOps(doc, [{ op: 'updateSlide', slideId: 'tog', patch: { variant: 'light' } }])
    const back = yDocToDeck(doc).slides.find((s) => s.id === 'tog')!
    expect(back.variant).toBe('light')
    expect(back.background).toBeUndefined()
    expect(textColours(doc, 'tog')).toEqual(light)
  })

  it('updateSlide to dark keeps an explicit background from the patch', () => {
    const { doc } = setup()
    applyOps(doc, [{ op: 'addSlide', layout: 'blank', slide: { id: 'bg' } }])
    applyOps(doc, [{ op: 'updateSlide', slideId: 'bg', patch: { variant: 'dark', background: { type: 'color', value: '#101820' } } }])
    expect(yDocToDeck(doc).slides.find((s) => s.id === 'bg')).toMatchObject({ variant: 'dark', background: { type: 'color', value: '#101820' } })
  })

  it('setTheme moves a dark slide to the new dark variant and to the new background when it had the old one', () => {
    const { doc } = setup()
    applyOps(doc, [{ op: 'addSlide', layout: 'title', slide: { id: 'dk2', variant: 'dark' } }])
    const midnight = BUILT_IN_THEMES.find((t) => t.name === 'Midnight')!
    applyOps(doc, [{ op: 'setTheme', theme: midnight }])
    const slide = yDocToDeck(doc).slides.find((s) => s.id === 'dk2')!
    expect(slide.background).toEqual(midnight.dark!.background)
    expect(textColours(doc, 'dk2')).toEqual([midnight.dark!.text, midnight.dark!.muted])
  })
})

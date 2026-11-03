// Placement of new elements: free space, empty placeholders, and the new-slide fallback.
// Fixtures are real layouts from the model package, filled or left empty.
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, layoutElements, type Element, type SlideLayout } from '@sleid/model'
import { richFromParagraphs } from './context.ts'
import { CHART_ASPECT, DIAGRAM_ASPECT, findPlacement, isEmptyTextBox, MIN_HEIGHT, MIN_WIDTH, overlapsBox, boxOf, type Box } from './placement.ts'
import { SAFE_MARGIN } from './layout-guard.ts'

/** A slide's placeholders for a layout. Filled ones get text, empty ones keep their empty paragraph. */
function layoutWith(layout: SlideLayout, filled: Array<'title' | 'subtitle' | 'body'>): Element[] {
  return layoutElements(layout, DEFAULT_THEME, (i) => `${layout}-${i}`).map((el) => {
    if (el.type !== 'text' || !el.role || !filled.includes(el.role)) return el
    return { ...el, content: richFromParagraphs([`Filled ${el.role} text that is not empty`]) } as Element
  })
}

function box(id: string, x: number, y: number, w: number, h: number, filled = true): Element {
  return {
    id,
    type: 'text',
    role: 'body',
    x,
    y,
    w,
    h,
    rotation: 0,
    locked: false,
    opacity: 1,
    z: 0,
    style: { fontFamily: 'Inter', fontSize: 40, color: '#000000', align: 'left', valign: 'top' },
    content: filled ? richFromParagraphs(['Some words']) : richFromParagraphs([]),
  } as unknown as Element
}

const SAFE = { x: SAFE_MARGIN, y: SAFE_MARGIN, w: 1920 - 2 * SAFE_MARGIN, h: 1080 - 2 * SAFE_MARGIN }

/** The invariants every placement must keep, whatever the fixture. */
function expectSafePlacement(elements: Element[], placed: NonNullable<ReturnType<typeof findPlacement>>, aspect: number): void {
  const b: Box = placed.box
  expect(b.x).toBeGreaterThanOrEqual(SAFE.x)
  expect(b.y).toBeGreaterThanOrEqual(SAFE.y)
  expect(b.x + b.w).toBeLessThanOrEqual(SAFE.x + SAFE.w)
  expect(b.y + b.h).toBeLessThanOrEqual(SAFE.y + SAFE.h)
  expect(b.w).toBeGreaterThanOrEqual(MIN_WIDTH)
  expect(b.h).toBeGreaterThanOrEqual(MIN_HEIGHT)
  // The aspect ratio only seeds the search; the box then grows into the free space, so it is never
  // smaller than the minimum box of that aspect.
  expect(b.w).toBeGreaterThanOrEqual(Math.min(SAFE.w, Math.max(MIN_WIDTH, MIN_HEIGHT * aspect)))
  for (const el of elements) {
    if (isEmptyTextBox(el)) {
      // Covered empty placeholders are listed for deletion; uncovered ones stay.
      expect(placed.placeholderIds.includes(el.id), `placeholder ${el.id}`).toBe(overlapsBox(b, boxOf(el)))
    } else {
      expect(overlapsBox(b, boxOf(el)), `non-empty ${el.id} must not be covered`).toBe(false)
      expect(placed.placeholderIds).not.toContain(el.id)
    }
  }
}

describe('isEmptyTextBox', () => {
  it('is true for text boxes with no words, and false for anything with text or another type', () => {
    const [title] = layoutWith('title-content', [])
    expect(isEmptyTextBox(title!)).toBe(true)
    expect(isEmptyTextBox(layoutWith('title-content', ['title'])[0]!)).toBe(false)
    expect(isEmptyTextBox({ id: 'img', type: 'image', x: 0, y: 0, w: 10, h: 10, rotation: 0, locked: false, opacity: 1, z: 0, src: '', fit: 'cover' } as unknown as Element)).toBe(false)
  })
})

describe('findPlacement', () => {
  it('empty slide: the whole safe area, from the top', () => {
    const placed = findPlacement([], DIAGRAM_ASPECT)!
    expect(placed.placeholderIds).toEqual([])
    expect(placed.box.y).toBe(SAFE.y)
    expect(placed.box.x).toBeGreaterThanOrEqual(SAFE.x)
    expect(placed.box.w).toBe(SAFE.w)
    expectSafePlacement([], placed, DIAGRAM_ASPECT)
  })

  it('empty slide with a chart: the chart fills the whole safe area', () => {
    const placed = findPlacement([], CHART_ASPECT)!
    expect(placed.box).toEqual(SAFE)
    expectSafePlacement([], placed, CHART_ASPECT)
  })

  it('section slide with an empty subtitle: a diagram spans the full safe width below the title (live-run regression)', () => {
    const elements = layoutWith('section', ['title'])
    const placed = findPlacement(elements, DIAGRAM_ASPECT)!
    expect(placed.box.x).toBe(SAFE.x)
    expect(placed.box.w).toBe(SAFE.w)
    expect(placed.box.y + placed.box.h).toBe(SAFE.y + SAFE.h)
  })

  it('section slide with a title and subtitle (both filled): no room, so null (the caller adds a new slide)', () => {
    const elements = layoutWith('section', ['title', 'subtitle'])
    expect(findPlacement(elements, DIAGRAM_ASPECT)).toBeNull()
    expect(findPlacement(elements, CHART_ASPECT)).toBeNull()
  })

  it('section slide with an empty subtitle: the empty subtitle does not count, and only the title blocks the top', () => {
    const elements = layoutWith('section', ['title'])
    const placed = findPlacement(elements, DIAGRAM_ASPECT)
    // The title spans 380-580 and the empty subtitle is ignored, so a box below the title (from 604) fits.
    expect(placed).not.toBeNull()
    expect(placed!.box.y).toBeGreaterThanOrEqual(580)
    expect(placed!.placeholderIds).toEqual(elements.filter((e) => isEmptyTextBox(e) && overlapsBox(placed!.box, boxOf(e))).map((e) => e.id))
    expectSafePlacement(elements, placed!, DIAGRAM_ASPECT)
  })

  it('title-content slide with a full body: no room, so null', () => {
    const elements = [
      box('title', 120, 72, 1680, 160, true),
      box('body', 120, 272, 1680, 728, true),
    ]
    expect(findPlacement(elements, DIAGRAM_ASPECT)).toBeNull()
    expect(findPlacement(elements, CHART_ASPECT)).toBeNull()
  })

  it('slide with only empty placeholders: the placeholders under the box are listed for deletion, and nothing else is', () => {
    const elements = layoutWith('title-content', [])
    const placed = findPlacement(elements, DIAGRAM_ASPECT)!
    expect(placed.placeholderIds.sort()).toEqual(elements.map((e) => e.id).sort())
    expectSafePlacement(elements, placed, DIAGRAM_ASPECT)
  })

  it('never lists a non-empty element for deletion, even when it sits among empty placeholders', () => {
    const elements = [box('filled-top', 96, 96, 300, 200, true), box('empty-under', 96, 400, 1000, 500, false), box('empty-far', 1500, 900, 200, 80, false)]
    const placed = findPlacement(elements, DIAGRAM_ASPECT)!
    expect(placed.placeholderIds).not.toContain('filled-top')
    expectSafePlacement(elements, placed, DIAGRAM_ASPECT)
  })

  it('prefers the space below the content when it fits', () => {
    const elements = [box('image-like', 96, 96, 400, 300, true)]
    const placed = findPlacement(elements, DIAGRAM_ASPECT)!
    expect(placed.box.y).toBe(96 + 300 + 24)
    // Centred horizontally in the safe area.
    expect(placed.box.x).toBe(SAFE.x + Math.floor((SAFE.w - placed.box.w) / 2))
    expectSafePlacement(elements, placed, DIAGRAM_ASPECT)
  })

  it('uses the largest free box beside a band of content when nothing is below', () => {
    const elements = [box('band', 96, 500, 1728, 484, true)]
    const placed = findPlacement(elements, DIAGRAM_ASPECT)!
    expect(placed).not.toBeNull()
    // The box keeps the gap above the band.
    expect(placed.box.w).toBeGreaterThan(MIN_WIDTH)
    expect(placed.box.y + placed.box.h).toBeLessThanOrEqual(500 - 24)
    expectSafePlacement(elements, placed, DIAGRAM_ASPECT)
  })

  it('a box that would be below the minimum size is not used', () => {
    // Only 300 px are free under the content, which is less than the minimum height.
    const elements = [box('tall', 96, 96, 1728, 564, true)]
    expect(findPlacement(elements, DIAGRAM_ASPECT)).toBeNull()
  })

  it('the placed box never overlaps a non-empty element (checked on a dense slide)', () => {
    const elements = [
      box('a', 96, 96, 500, 200, true),
      box('b', 700, 96, 500, 200, true),
      box('c', 96, 400, 300, 300, true),
      box('d', 500, 500, 600, 300, false),
    ]
    const placed = findPlacement(elements, DIAGRAM_ASPECT)
    if (placed) expectSafePlacement(elements, placed, DIAGRAM_ASPECT)
  })

  it('the minimum size constants fit the largest aspect the assistant uses', () => {
    expect(MIN_WIDTH).toBe(640)
    expect(MIN_HEIGHT).toBe(360)
    expect(overlapsBox({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false)
  })
})

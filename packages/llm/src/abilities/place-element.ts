// Puts a new element (a chart or a diagram) on a slide. When the slide has free space, the element goes there, and
// the empty placeholder text boxes it covers are deleted in the same batch. When it does not, the element goes on a
// new slide after the target, with a title taken from the ability's output. Never deletes a non-empty element.
import { layoutElements, type Deck, type Element } from '@sleid/model'
import { richFromParagraphs } from '../context.ts'
import { LlmError } from '../errors.ts'
import { findPlacement, isEmptyTextBox, type Box } from '../placement.ts'

export interface PlacedElement {
  /** Unchecked ops, for checkOps. */
  raw: unknown[]
  /** True when the element went on a new slide. */
  onNewSlide: boolean
  /** 1-based number of the slide that holds the element. */
  slideNumber: number
  /** 1-based number of the slide the element was meant for (the target). */
  targetNumber: number
}

function boxFields(box: Box): Pick<Element, 'x' | 'y' | 'w' | 'h'> {
  return { x: box.x, y: box.y, w: box.w, h: box.h }
}

/**
 * `base` holds the element's own fields (type, data, options, ...). The id and the position come from here.
 * `title` names the new slide when there is one.
 */
export function placeNewElement(deck: Deck, slideId: string, base: Record<string, unknown>, aspect: number, title: string): PlacedElement {
  const index = deck.slides.findIndex((s) => s.id === slideId)
  const slide = deck.slides[index]
  if (!slide) throw new LlmError('bad-request', `No slide with id ${slideId} is in this deck.`)

  const onSlide = findPlacement(slide.elements, aspect)
  if (onSlide) {
    const deletes = onSlide.placeholderIds
      .filter((id) => {
        const el = slide.elements.find((e) => e.id === id)
        return el !== undefined && isEmptyTextBox(el)
      })
      .map((elementId) => ({ op: 'deleteElement', slideId, elementId }))
    const element = { ...base, id: crypto.randomUUID(), ...boxFields(onSlide.box) }
    return { raw: [...deletes, { op: 'addElement', slideId, element }], onNewSlide: false, slideNumber: index + 1, targetNumber: index + 1 }
  }

  // No room: a new slide after the target, titled from the ability's output. Its body placeholder is left out.
  const titleTemplate = layoutElements('title-content', deck.theme, () => crypto.randomUUID()).find((e) => e.type === 'text' && e.role === 'title')
  if (!titleTemplate) throw new LlmError('invalid-output', 'The title layout is not available.')
  const heading = { ...titleTemplate, content: richFromParagraphs([title]) } as Element
  const below = findPlacement([heading], aspect)
  if (!below) throw new LlmError('invalid-output', 'The element does not fit on a slide with a title.')
  const element = { ...base, id: crypto.randomUUID(), ...boxFields(below.box), z: 1 }
  const raw = [
    {
      op: 'addSlide',
      layout: 'title-content',
      index: index + 1,
      slide: {
        id: crypto.randomUUID(),
        notes: '',
        elements: [{ ...heading, id: crypto.randomUUID(), z: 0 }, element],
      },
    },
  ]
  return { raw, onNewSlide: true, slideNumber: index + 2, targetNumber: index + 1 }
}

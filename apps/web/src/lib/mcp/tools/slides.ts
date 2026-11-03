// Slide tools: add a slide (with components, columns and chrome), insert or rebuild a component, text, notes, order,
// charts and diagrams, and apply_ops for raw deck operations.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CHART_TYPES, SLIDE_LAYOUTS, type Deck, type Element } from '@sleid/model'
import { CHART_ASPECT, DIAGRAM_ASPECT, placeNewElement, validateMermaid } from '@sleid/llm'
import { COMPONENT_KINDS, type ComponentKind } from '@sleid/compose'
import { ToolError } from '../errors.ts'
import { asText, deckIdField, placedElementId, slideRef, type ServerContext } from '../call.ts'
import { buildSlide, findElement, resolveSlide, textPatchFor } from '../compile.ts'
import {
  appendComponents,
  chromeElements,
  darkenElements,
  fillTwoColumns,
  isEmptyPlaceholder,
  REGION_NAMES,
  twoColumnParts,
  type ComponentSpec,
  type ImageSizes,
} from '../compose-ops.ts'
import { imageSizesFor, imageSrcsOf, withFrameSrc } from '../images.ts'

const componentSpecShape = z.object({
  kind: z.enum(COMPONENT_KINDS).describe('header, card_grid, browser_frame, timeline, comparison, numbered_cards, bullets_with_sublines, stat_row or footer_and_logo.'),
  props: z.record(z.string(), z.unknown()).describe('The component props. See sleid://guide/elements for each kind.'),
  region: z.enum(REGION_NAMES).optional().describe('Where it goes: full (header), body (default, below the header), left or right (side by side), center (covers), top-half or bottom-half.'),
})

/** The ops for a list of elements, one addElement each. */
function addOps(slideId: string, elements: readonly unknown[]): unknown[] {
  return elements.map((element) => ({ op: 'addElement', slideId, element }))
}

export function registerSlideTools(ctx: ServerContext): void {
  const { tool, deps } = ctx

  tool(
    'add_slide',
    {
      scope: 'decks:write',
      description:
        'Add a slide. Prefer components: give a list of components (up to 6), each a kind with props, and each is placed and styled from the deck theme. Kinds: header (label, heading, subtitle, secondary), card_grid (cards with icon, title, body), browser_frame (a screenshot: assetId from upload_asset, alt, caption), timeline (steps), comparison (rows of before and after), numbered_cards (items), bullets_with_sublines (items), stat_row (stats), footer_and_logo. Use variant "dark" for a dark slide. Without components: layout is one of title, title-content, two-column, section, blank, image-left or quote, and body is plain text (one paragraph per line, "- " for bullets, **bold**, *italic*). For a two-column slide, give columns (two strings) or a body with a line that is exactly --- between the two halves. chrome (default on) adds the theme\'s logo, footer and page number when the theme has them. The slide goes at the end unless index is given. Returns the slide id and the component instances. Read sleid://guide/elements first.',
      shape: {
        deckId: deckIdField,
        layout: z.enum(SLIDE_LAYOUTS).optional().describe('Default: blank with components, two-column with columns, otherwise required.'),
        variant: z.enum(['light', 'dark']).optional().describe('dark for a dark slide (the theme\'s dark colours and background).'),
        title: z.string().max(300).optional(),
        body: z.string().max(5000).optional(),
        columns: z.tuple([z.string().max(5000), z.string().max(5000)]).optional().describe('The text of the two columns of a two-column slide.'),
        components: z.array(componentSpecShape).max(6).optional(),
        chrome: z.boolean().optional().describe('Add the theme chrome (logo, footer text, page number). Default true.'),
        notes: z.string().max(5000).optional().describe('Speaker notes.'),
        index: z.number().int().min(0).optional(),
      },
    },
    async (args, call) => {
      const deck = await call.edit(args.deckId)
      const components = args.components ?? []
      const layout = args.layout ?? (components.length > 0 ? 'blank' : args.columns ? 'two-column' : undefined)
      if (!layout) throw new ToolError('Give a layout (title, title-content, two-column, section, blank, image-left or quote), or components.')
      if (args.columns && layout !== 'two-column') throw new ToolError('columns needs layout two-column.')

      const slideId = randomUUID()
      const split = layout === 'two-column' ? twoColumnParts(args.body, args.columns) : null
      const built = buildSlide(deck, { slideId, layout, title: args.title, body: split ? undefined : args.body, notes: args.notes })
      let elements = built.elements as Element[]
      if (split) fillTwoColumns(elements, split)
      if (components.length > 0) elements = elements.filter((el) => !isEmptyPlaceholder(el))
      if (args.variant === 'dark') elements = darkenElements(deck.theme, elements)

      const specs: ComponentSpec[] = components.map((c) => ({ kind: c.kind as ComponentKind, props: withFrameSrc(c.kind, c.props), region: c.region }))
      const images: ImageSizes = await imageSizesFor(deps, args.deckId, imageSrcsOf(specs))
      const draft = { id: slideId, variant: args.variant, elements }
      const placed = appendComponents(deck, draft, specs, { images })
      elements = [...elements, ...(placed.elements as Element[])]
      const index = args.index ?? deck.slides.length
      if (args.chrome !== false) {
        elements = [...elements, ...(chromeElements(deck, { id: slideId, variant: args.variant, elements }, index + 1, { images }) as Element[])]
      }

      const op: Record<string, unknown> = {
        op: 'addSlide',
        layout,
        slide: {
          id: slideId,
          notes: args.notes ?? '',
          ...(args.variant ? { variant: args.variant } : {}),
          elements: elements.map((el, z) => ({ ...el, z })),
        },
      }
      if (args.index !== undefined) op.index = args.index
      await call.write(args.deckId, [op])
      return asText({
        slideId,
        index,
        layout,
        elements: elements.length,
        components: placed.parts.map((p) => ({ kind: p.kind, instance: p.instance })),
      })
    },
  )

  tool(
    'insert_component',
    {
      scope: 'decks:write',
      description:
        'Add one component to an existing slide, placed and styled from the theme. Give slideId or index, the kind and its props (see sleid://guide/elements). By default it goes in the body under the slide\'s header; region picks another place (full, body, left, right, top-half, bottom-half, center). Use lint_deck afterwards to check for overlaps. Returns the instance id, which update_component takes.',
      shape: {
        deckId: deckIdField,
        ...slideRef,
        kind: z.enum(COMPONENT_KINDS),
        props: z.record(z.string(), z.unknown()),
        region: z.enum(REGION_NAMES).optional(),
      },
    },
    async (args, call) => {
      const deck = await call.edit(args.deckId)
      const slide = resolveSlide(deck, args)
      const spec: ComponentSpec = { kind: args.kind as ComponentKind, props: withFrameSrc(args.kind, args.props), region: args.region }
      const images = await imageSizesFor(deps, args.deckId, imageSrcsOf([spec]))
      const placed = appendComponents(deck, slide, [spec], { images })
      await call.write(args.deckId, addOps(slide.id, placed.elements))
      return asText({
        slideId: slide.id,
        slideIndex: deck.slides.findIndex((s) => s.id === slide.id),
        instance: placed.parts[0]!.instance,
        kind: args.kind,
        elementIds: placed.elements.map((el) => el.id),
      })
    },
  )

  tool(
    'update_component',
    {
      scope: 'decks:write',
      description:
        'Change the props of a component already on a slide. Give its instance (from add_slide or insert_component, or get_deck). The component is rebuilt in the same place with the new props; its kind does not change. Use lint_deck afterwards.',
      shape: {
        deckId: deckIdField,
        instance: z.string().min(1).max(64),
        props: z.record(z.string(), z.unknown()),
      },
    },
    async (args, call) => {
      const deck = await call.edit(args.deckId)
      const found = findInstance(deck, args.instance)
      const kind = found.elements[0]!.component!.kind as ComponentKind
      // A header keeps the size it was drawn at (a cover's title, an ask's heading) unless the props say otherwise.
      let props: Record<string, unknown> = args.props
      const heading = found.elements.find((el) => el.component?.part === 'heading')
      if (kind === 'header' && heading?.type === 'text' && props.size === undefined && heading.style.fontSize !== undefined) {
        const fs = heading.style.fontSize
        const sizes = deck.theme.sizes
        if (Math.abs(fs - sizes.title) < 1) props = { ...props, size: 'title' }
        else if (Math.abs(fs - (deck.theme.components?.heading?.size ?? sizes.heading) * 1.222) < 1) props = { ...props, size: 'ask' }
      }
      const spec: ComponentSpec = { kind, props: withFrameSrc(kind, props) }
      const images = await imageSizesFor(deps, args.deckId, imageSrcsOf([spec]))
      const rest = found.slide.elements.filter((el) => el.component?.instance !== args.instance)
      // The new elements keep the old box, z base and first animation order, so the component stays where it was.
      const orders = found.elements.map((el) => el.animation?.order).filter((o): o is number => o !== undefined)
      const placed = appendComponents(
        deck,
        { id: found.slide.id, variant: found.slide.variant, elements: rest },
        [spec],
        {
          images,
          instance: args.instance,
          box: boxOf(found.elements),
          zBase: Math.min(...found.elements.map((el) => el.z)),
          ...(orders.length > 0 ? { animationStart: Math.min(...orders) } : {}),
        },
      )
      const ops = [
        ...found.elements.map((el) => ({ op: 'deleteElement', slideId: found.slide.id, elementId: el.id })),
        ...addOps(found.slide.id, placed.elements),
      ]
      await call.write(args.deckId, ops)
      return asText({ slideId: found.slide.id, instance: args.instance, kind, elementIds: placed.elements.map((el) => el.id) })
    },
  )

  tool(
    'update_text',
    {
      scope: 'decks:write',
      description: 'Replace the text of a text box (or a shape) with new text. Same plain-text format as add_slide body. Find elementId in get_deck.',
      shape: {
        deckId: deckIdField,
        elementId: z.string().min(1).max(100),
        text: z.string().max(5000),
      },
    },
    async (args, call) => {
      const deck = await call.edit(args.deckId)
      const { slide, element } = findElement(deck, args.elementId)
      const { patch } = textPatchFor(element, args.text)
      await call.write(args.deckId, [{ op: 'updateElement', slideId: slide.id, elementId: element.id, patch }])
      return asText({ elementId: element.id, slideId: slide.id })
    },
  )

  tool(
    'set_notes',
    {
      scope: 'decks:write',
      description: 'Set the speaker notes of a slide. Replaces the notes; pass an empty string to clear them.',
      shape: { deckId: deckIdField, slideId: z.string().min(1).max(100), notes: z.string().max(5000) },
    },
    async (args, call) => {
      await call.edit(args.deckId)
      await call.write(args.deckId, [{ op: 'setNotes', slideId: args.slideId, notes: args.notes }])
      return asText({ slideId: args.slideId, notes: args.notes.length })
    },
  )

  tool(
    'delete_slide',
    {
      scope: 'decks:write',
      description: 'Delete one slide and everything on it. This cannot be undone through MCP, so check the slide id first.',
      shape: { deckId: deckIdField, slideId: z.string().min(1).max(100) },
    },
    async (args, call) => {
      await call.edit(args.deckId)
      await call.write(args.deckId, [{ op: 'deleteSlide', slideId: args.slideId }])
      return asText({ deleted: args.slideId })
    },
  )

  tool(
    'move_slide',
    {
      scope: 'decks:write',
      description: 'Move a slide to a new 0-based position. toIndex is where it ends up.',
      shape: { deckId: deckIdField, slideId: z.string().min(1).max(100), toIndex: z.number().int().min(0) },
    },
    async (args, call) => {
      await call.edit(args.deckId)
      await call.write(args.deckId, [{ op: 'moveSlide', slideId: args.slideId, toIndex: args.toIndex }])
      return asText({ slideId: args.slideId, toIndex: args.toIndex })
    },
  )

  tool(
    'insert_chart',
    {
      scope: 'decks:write',
      description:
        'Insert a native chart on a slide, placed in free space so it does not cover text. The first column holds the categories; for pie and donut, the first value column is shown. Each row needs one cell per column. If the slide is full, the chart goes on a new slide after it.',
      shape: {
        deckId: deckIdField,
        slideId: z.string().min(1).max(100),
        chartType: z.enum(CHART_TYPES),
        columns: z.array(z.string().min(1).max(60)).min(2).max(8),
        rows: z.array(z.array(z.union([z.string().max(60), z.number(), z.null()]))).min(1).max(40),
        title: z.string().max(120).optional(),
      },
    },
    async (args, call) => {
      const deck = await call.edit(args.deckId)
      const slide = resolveSlide(deck, { slideId: args.slideId })
      if (args.rows.some((row) => row.length !== args.columns.length)) throw new ToolError('Each row needs exactly one cell per column.')
      const title = args.title ?? ''
      const placed = placeNewElement(
        deck,
        slide.id,
        { type: 'chart', chartType: args.chartType, data: { columns: args.columns, rows: args.rows }, options: { title, legend: true }, rotation: 0, locked: false, opacity: 1, alt: title || 'Chart' },
        CHART_ASPECT,
        title || 'Chart',
      )
      await call.write(args.deckId, placed.raw)
      return asText({ elementId: placedElementId(placed.raw), slideIndex: placed.slideNumber - 1, onNewSlide: placed.onNewSlide })
    },
  )

  tool(
    'insert_diagram',
    {
      scope: 'decks:write',
      description:
        'Insert a Mermaid diagram (flowchart, sequence, pie, mindmap and others). Node ids are single words; put the label in brackets, as in A[Shop appliances]. The source is checked with the Mermaid parser first, and a parse error is returned so you can fix it.',
      shape: {
        deckId: deckIdField,
        slideId: z.string().min(1).max(100),
        mermaid: z.string().min(1).max(6000).describe('Mermaid source, without code fences.'),
      },
    },
    async (args, call) => {
      const deck = await call.edit(args.deckId)
      const slide = resolveSlide(deck, { slideId: args.slideId })
      const check = await validateMermaid(args.mermaid)
      if (!check.ok) throw new ToolError(`The Mermaid source did not parse. ${check.line ? `Line ${check.line}: ` : ''}${check.message}`)
      const placed = placeNewElement(
        deck,
        slide.id,
        { type: 'diagram', source: args.mermaid, rotation: 0, locked: false, opacity: 1, alt: 'Diagram' },
        DIAGRAM_ASPECT,
        'Diagram',
      )
      await call.write(args.deckId, placed.raw)
      return asText({ elementId: placedElementId(placed.raw), slideIndex: placed.slideNumber - 1, onNewSlide: placed.onNewSlide })
    },
  )

  tool(
    'apply_ops',
    {
      scope: 'decks:write',
      description:
        'Apply deck operations as one batch: all of them or none. Each op is an object with an "op" field: addSlide, deleteSlide, duplicateSlide, moveSlide, updateSlide, addElement, updateElement, deleteElement, reorderElement, setTheme, setTitle, addSection, renameSection, deleteSection, setNotes or setDeckOptions. The exact shapes are in sleid://schema/ops, and the element defaults and the component props are in sleid://guide/elements. Use the component tools when they fit.',
      shape: {
        deckId: deckIdField,
        ops: z.array(z.record(z.string(), z.unknown())).min(1).max(200).describe('The operations, applied in order.'),
      },
    },
    async (args, call) => {
      await call.edit(args.deckId)
      const results = await call.write(args.deckId, args.ops)
      return asText({ deckId: args.deckId, applied: args.ops.length, results })
    },
  )
}

/** The slide that holds an instance, and the instance's elements there. Throws when the instance is not in the deck. */
function findInstance(deck: Deck, instance: string): { slide: Deck['slides'][number]; elements: Element[] } {
  for (const slide of deck.slides) {
    const elements = slide.elements.filter((el) => el.component?.instance === instance)
    if (elements.length > 0) return { slide, elements }
  }
  throw new ToolError(`No component with instance ${instance} in this deck. Call get_deck to see the instances, or add_slide to make one.`)
}

/** The box that covers a list of elements. */
function boxOf(elements: Element[]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...elements.map((el) => el.x))
  const y = Math.min(...elements.map((el) => el.y))
  const right = Math.max(...elements.map((el) => el.x + el.w))
  const bottom = Math.max(...elements.map((el) => el.y + el.h))
  return { x, y, w: right - x, h: bottom - y }
}

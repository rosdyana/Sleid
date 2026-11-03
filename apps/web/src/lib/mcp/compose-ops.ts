// Pure helpers that turn components (@sleid/compose) into raw elements for a slide. The MCP tools use them for
// add_slide, insert_component, update_component, insert_image (asFrame) and apply_style_from_deck. Nothing here reads or
// writes the database.
import { randomUUID } from 'node:crypto'
import { lightToDarkMap, recolorSlideElements, resolveTokens, type Deck, type Element, type ElementInput, type Theme } from '@sleid/model'
import {
  bodyTopAfter,
  buildComponent,
  ComponentPropsSchemas,
  HEADER_GAP,
  regionBox,
  type Box,
  type ComponentContext,
  type ComponentKind,
  type Variant,
} from '@sleid/compose'
import { ToolError } from './errors.ts'
import { markdownToRich } from './rich.ts'

/** Named regions a component can be placed in. Matches regionBox in @sleid/compose, minus the explicit box. */
export const REGION_NAMES = ['full', 'body', 'left', 'right', 'top-half', 'bottom-half', 'center'] as const
export type RegionChoice = (typeof REGION_NAMES)[number]

/** Image sizes by src (for example `/api/assets/<id>`), so a browser frame keeps the picture's aspect ratio. */
export type ImageSizes = Record<string, { width: number; height: number }>

export interface ComponentSpec {
  kind: ComponentKind
  props: unknown
  region?: RegionChoice | undefined
}

/** A slide as far as placement is concerned: its id, variant, and the elements already on it. */
export interface SlideDraft {
  id: string
  variant?: Variant | undefined
  elements: readonly Element[]
}

export interface AppendOptions {
  images?: ImageSizes | undefined
  /** The instance id to use for a single spec (update_component keeps the old one). */
  instance?: string | undefined
  /** The z of the first new element. Default: one above the highest z on the slide. */
  zBase?: number | undefined
  /** The first animation order to use. Default: one above the highest order on the slide. */
  animationStart?: number | undefined
  /** An explicit box for a single spec, instead of a named region. */
  box?: Box | undefined
}

export interface AppendResult {
  elements: ElementInput[]
  parts: Array<{ kind: ComponentKind; instance: string }>
}

const ID_UNSAFE = /[^A-Za-z0-9_.-]/g

/** A short instance id: 12 hex characters, unique enough within one slide. */
export function newInstanceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/** The element id for one part of an instance. Stable for the same instance and part, so an update keeps ids. */
export function partId(instance: string, part: string): string {
  return `${instance}-${part}`.replace(ID_UNSAFE, '-')
}

/** The region a component uses when the caller gives none: header and footer take the full area, the rest the body. */
export function defaultRegionFor(kind: ComponentKind): RegionChoice {
  return kind === 'header' || kind === 'footer_and_logo' ? 'full' : 'body'
}

/** Highest z on a slide, or -1 when it has no elements. */
function maxZ(elements: readonly Element[]): number {
  return elements.reduce((m, e) => Math.max(m, e.z), -1)
}

/** The next free animation order: one above the highest order on the slide, or 0. */
function nextAnimationOrder(elements: readonly Element[]): number {
  let next = 0
  for (const el of elements) if (el.animation) next = Math.max(next, el.animation.order + 1)
  return next
}

/** The bottom of the slide's header (the lowest edge of its header elements), when it has one. */
function headerBottomOf(elements: readonly Element[]): number | undefined {
  let bottom: number | undefined
  for (const el of elements) {
    if (el.component?.kind !== 'header') continue
    bottom = Math.max(bottom ?? 0, el.y + el.h)
  }
  return bottom
}

/** The validation message for props, with the path of the first problem. Throws a ToolError. */
export function checkProps(kind: ComponentKind, props: unknown, label: string): unknown {
  const parsed = ComponentPropsSchemas[kind].safeParse(props)
  if (parsed.success) return parsed.data
  const lines = parsed.error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.map(String).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  throw new ToolError(`${label} (${kind}) is not valid. ${lines.join('; ')}. See sleid://guide/elements for the props of each component.`)
}

/**
 * Places components on a slide. Each component gets its own instance id (unless `opts.instance` is given), and its elements
 * are tagged with it. Three columns of flow: the body (below the header, stacked, each component 32px under the one before),
 * and the 'left' and 'right' columns, which stack on their own (a header and bullets in 'left' sit over each other, while a
 * browser frame in 'right' runs alongside them). A header sets where the body starts (56px under its bottom, never above 303).
 * A browser frame in a column, and anything in 'center', is centred vertically in its box.
 */
export function appendComponents(deck: Deck, draft: SlideDraft, specs: ComponentSpec[], opts: AppendOptions = {}): AppendResult {
  const tokens = resolveTokens(deck.theme)
  const variant: Variant = draft.variant ?? 'light'
  const gap = tokens.gap
  let top = bodyTopAfter(headerBottomOf(draft.elements) ?? 0)
  let left = top
  let right = top
  let z = opts.zBase ?? maxZ(draft.elements) + 1
  let anim = opts.animationStart ?? nextAnimationOrder(draft.elements)
  const out: ElementInput[] = []
  const parts: AppendResult['parts'] = []

  specs.forEach((spec, i) => {
    const label = `components[${i}]`
    const props = checkProps(spec.kind, spec.props, label)
    const regionName = spec.region ?? defaultRegionFor(spec.kind)
    let box: Box
    if (opts.box && specs.length === 1) {
      box = { ...opts.box }
    } else if (regionName === 'body') {
      top = Math.max(top, left, right)
      box = regionBox('body', tokens, { bodyTop: top })
    } else if (regionName === 'left') {
      box = regionBox('left', tokens, { bodyTop: left })
    } else if (regionName === 'right') {
      box = regionBox('right', tokens, { bodyTop: right })
    } else {
      box = regionBox(regionName, tokens)
    }

    const instance = opts.instance && specs.length === 1 ? opts.instance : newInstanceId()
    const ctx: ComponentContext = {
      theme: deck.theme,
      tokens,
      variant,
      ...(deck.secondaryLanguage ? { secondaryLanguage: deck.secondaryLanguage } : {}),
      regionName,
      region: box,
      instance,
      idFor: (part) => partId(instance, part),
      animationStart: anim,
      ...(opts.images ? { images: opts.images } : {}),
      zBase: z,
    }
    let result = buildComponent(spec.kind, props, ctx)
    // A cover's header, and a browser frame in a column, sit in the middle of their box rather than at its top.
    const free = box.h - result.box.h
    const centred = regionName === 'center' || (spec.kind === 'browser_frame' && (regionName === 'left' || regionName === 'right'))
    if (centred && free > 0) result = shiftResult(result, free / 2)
    out.push(...result.elements)
    parts.push({ kind: spec.kind, instance })
    z += result.elements.length
    for (const el of result.elements) if (el.animation) anim = Math.max(anim, el.animation.order + 1)

    if (spec.kind === 'header' && regionName === 'full') {
      top = bodyTopAfter(result.bottom)
      left = top
      right = top
    } else if (regionName === 'body') {
      top = result.bottom + gap
      left = top
      right = top
    } else if (regionName === 'left') {
      left = result.bottom + (spec.kind === 'header' ? HEADER_GAP : gap)
    } else if (regionName === 'right') {
      right = result.bottom + (spec.kind === 'header' ? HEADER_GAP : gap)
    }
  })
  return { elements: out, parts }
}

/** The same component, moved down by `dy`. */
function shiftResult(result: ReturnType<typeof buildComponent>, dy: number): ReturnType<typeof buildComponent> {
  return {
    elements: result.elements.map((el) => ({ ...el, y: el.y + dy })) as ElementInput[],
    box: { ...result.box, y: result.box.y + dy },
    bottom: result.bottom + dy,
  }
}

/** The elements of one component on a slide, placed the same way add_slide and insert_component place them. */
export function componentElements(deck: Deck, slide: SlideDraft, spec: ComponentSpec, opts: AppendOptions = {}): ElementInput[] {
  return appendComponents(deck, slide, [spec], opts).elements
}

/**
 * The slide chrome for one slide: the logos, the footer text and the page number that the theme's components.chrome asks
 * for. Empty when the theme has none of them. Dark slides use the dark logo when there is one.
 */
export function chromeElements(deck: Deck, slide: SlideDraft, pageNumber: number, opts: { images?: ImageSizes } = {}): ElementInput[] {
  const chrome = deck.theme.components?.chrome
  if (!chrome || !(chrome.logoLight || chrome.logoDark || chrome.footerText)) return []
  const props = {
    ...(chrome.logoLight ? { logoSrc: chrome.logoLight } : {}),
    ...(chrome.logoDark ? { logoSrcDark: chrome.logoDark } : {}),
    ...(chrome.footerText ? { footerText: chrome.footerText } : {}),
    ...(chrome.pageNumbers ? { pageNumber } : {}),
    ...(chrome.logoBox ? { logoBox: chrome.logoBox } : {}),
    ...(chrome.footerBox ? { footerBox: chrome.footerBox } : {}),
  }
  return appendComponents(deck, slide, [{ kind: 'footer_and_logo', props, region: 'full' }], { images: opts.images }).elements
}

/** Whether a stored element is a footer_and_logo part (the chrome of a slide). */
export function isChrome(el: Element): boolean {
  return el.component?.kind === 'footer_and_logo'
}

/** The text of a layout placeholder that is still empty: a text box with no characters in it. */
export function isEmptyPlaceholder(el: Element): boolean {
  if (el.type !== 'text' || el.component) return false
  return !hasText(el.content)
}

function hasText(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as { text?: unknown; content?: unknown }
  if (typeof n.text === 'string' && n.text.length > 0) return true
  return Array.isArray(n.content) && n.content.some(hasText)
}

/** Colours a light slide's layout placeholders for the dark variant. */
export function darkenElements(theme: Theme, elements: Element[]): Element[] {
  return recolorSlideElements(elements, lightToDarkMap(theme)) as Element[]
}

/**
 * Splits two-column text. With `columns`, the two strings fill the two body boxes (left and right, by x). Otherwise a
 * body with one line that is exactly `---` is split there. Returns null when there is nothing to split.
 */
export function twoColumnParts(body: string | undefined, columns: [string, string] | undefined): [string, string] | null {
  if (columns) return columns
  if (!body) return null
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const at = lines.findIndex((line) => line.trim() === '---')
  if (at < 0) return null
  return [lines.slice(0, at).join('\n'), lines.slice(at + 1).join('\n')]
}

/** Fills the two body boxes of a two-column slide, left box first. */
export function fillTwoColumns(elements: Element[], parts: [string, string]): void {
  const bodies = elements
    .filter((e): e is Extract<Element, { type: 'text' }> => e.type === 'text' && e.role === 'body')
    .sort((a, b) => a.x - b.x)
  bodies.slice(0, 2).forEach((box, i) => {
    box.content = markdownToRich(parts[i] ?? '') as typeof box.content
  })
}

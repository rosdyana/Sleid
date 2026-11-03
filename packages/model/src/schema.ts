// Zod schemas for the plain JSON form of a deck. Everything else in the model
// (Yjs binding, deck-ops, renderer) is checked against these.
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Rich text: a permissive subset of ProseMirror / TipTap JSON.
// Unknown node types are allowed (renderers degrade them to their children).
// Marks we know about are typed; unknown extra keys are kept (looseObject).
// ---------------------------------------------------------------------------

export const MarkSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('bold') }),
  z.looseObject({ type: z.literal('italic') }),
  z.looseObject({ type: z.literal('underline') }),
  z.looseObject({ type: z.literal('strike') }),
  z.looseObject({ type: z.literal('code') }),
  z.looseObject({
    type: z.literal('link'),
    attrs: z.looseObject({
      href: z.string(),
      target: z.string().nullish(),
      rel: z.string().nullish(),
    }),
  }),
  z.looseObject({
    type: z.literal('textStyle'),
    attrs: z.looseObject({
      color: z.string().nullish(),
      fontSize: z.string().nullish(),
      fontFamily: z.string().nullish(),
      // M10. fontWeight is a CSS number (400) or keyword ('bold'); letterSpacing is a CSS length ('0.14em').
      fontWeight: z.union([z.string(), z.number()]).nullish(),
      letterSpacing: z.string().nullish(),
    }),
  }),
])
export type RichMark = z.infer<typeof MarkSchema>

export interface RichNode {
  type: string
  attrs?: Record<string, unknown> | undefined
  content?: RichNode[] | undefined
  marks?: RichMark[] | undefined
  text?: string | undefined
  [key: string]: unknown
}

export const RichNodeSchema: z.ZodType<RichNode> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(RichNodeSchema).optional(),
    marks: z.array(MarkSchema).optional(),
    text: z.string().optional(),
  }),
)

export const RichTextSchema = z.looseObject({
  type: z.literal('doc'),
  content: z.array(RichNodeSchema).optional(),
})
export type RichText = z.infer<typeof RichTextSchema>

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** One Google Fonts css2 `family` value: a family name, optionally with an axis list. */
export const FONT_IMPORT_RE = /^[A-Za-z0-9 ]{1,60}(:[A-Za-z0-9,;@.]{1,80})?$/

export const ThemeSchema = z.object({
  name: z.string(),
  colors: z.object({
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
    accent: z.string(),
    accent2: z.string(),
    accent3: z.string(),
    accent4: z.string(),
  }),
  fonts: z.object({
    heading: z.string(),
    body: z.string(),
    mono: z.string(),
  }),
  sizes: z.object({
    title: z.number().positive(),
    heading: z.number().positive(),
    body: z.number().positive(),
    small: z.number().positive(),
  }),
  radius: z.number().min(0),
  backgroundStyle: z.enum(['solid', 'gradient', 'image']),
  backgroundValue: z.string().optional(),
  /**
   * M10. Google Fonts css2 `family` values, e.g. `Inter:wght@400;600;700`. The render adds one stylesheet link.
   * The pattern keeps the value to family names plus an axis list, so it cannot carry a URL or markup.
   */
  fontImports: z
    .array(z.string().regex(FONT_IMPORT_RE))
    .max(6)
    .optional(),
})
export type Theme = z.infer<typeof ThemeSchema>

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export const ANIMATION_EFFECTS = [
  'fade-in',
  'fade-up',
  'fade-down',
  'fade-left',
  'fade-right',
  'grow',
  'shrink',
  'highlight-red',
  'zoom-in',
  // M10. Exit and wipe effects. The suggestion ability only uses the entrance effects (see packages/llm).
  'fade-out',
  'current-visible',
  'fade-in-then-out',
  'semi-fade-out',
  'wipe',
] as const

export const AnimationSchema = z.object({
  effect: z.enum(ANIMATION_EFFECTS),
  order: z.number().int().min(0),
})

export const TextStyleSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  color: z.string().optional(),
  align: z.enum(['left', 'center', 'right', 'justify']),
  valign: z.enum(['top', 'middle', 'bottom']),
  lineHeight: z.number().positive().optional(),
  // M10 typography. All optional, so existing decks are unchanged.
  fontWeight: z.number().int().min(100).max(900).optional(),
  /** In em, so it scales with fontSize. */
  letterSpacing: z.number().min(-0.5).max(2).optional(),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
})

// M10. Shared by shapes, images and text. Canvas pixels for offsets and blur.
export const ShadowSchema = z.object({
  x: z.number(),
  y: z.number(),
  blur: z.number().min(0),
  spread: z.number().optional(),
  color: z.string(),
})
export type Shadow = z.infer<typeof ShadowSchema>

export const GradientFillSchema = z.object({
  type: z.enum(['linear', 'radial']),
  /** Degrees, linear only. Default 180 (top to bottom). */
  angle: z.number().optional(),
  stops: z.array(z.object({ color: z.string(), at: z.number().min(0).max(1) })).min(2).max(8),
})
export type GradientFill = z.infer<typeof GradientFillSchema>

// M10. Vector paths are structured (d + paints), not raw SVG markup, so nothing needs an XML sanitiser.
// The `d` regex allows only path commands and number syntax; the renderer re-checks it.
export const VECTOR_PATH_D_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/
export const VectorPathSchema = z.object({
  d: z.string().max(20000).regex(VECTOR_PATH_D_RE),
  fill: z.string(),
  stroke: z.string(),
  strokeWidth: z.number().min(0),
  lineCap: z.enum(['butt', 'round', 'square']).optional(),
  lineJoin: z.enum(['miter', 'round', 'bevel']).optional(),
  opacity: z.number().min(0).max(1).optional(),
})
export type VectorPath = z.infer<typeof VectorPathSchema>

export const SHAPE_KINDS = ['rect', 'roundRect', 'ellipse', 'triangle', 'arrow', 'line', 'star'] as const
export const CHART_TYPES = ['bar', 'line', 'pie', 'area', 'scatter', 'donut', 'stacked-bar'] as const

export const ChartDataSchema = z
  .object({
    columns: z.array(z.string()).min(1),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  })
  .refine((d) => d.rows.every((r) => r.length === d.columns.length), {
    message: 'every row needs one cell per column',
  })

export const ChartOptionsSchema = z.object({
  title: z.string().optional(),
  legend: z.boolean(),
  stacked: z.boolean().optional(),
  colors: z.array(z.string()).optional(),
})

/** Allowed reveal auto-animate keys. Also the only ids a duplicate can reuse as a key, so they stay safe in data-id. */
export const ANIMATE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/

// Shared by every element. `idSchema` and `zSchema` differ between the stored
// element (both required) and the input accepted by addElement (both optional).
function buildElement<I extends z.ZodType, Z extends z.ZodType>(idSchema: I, zSchema: Z) {
  const common = {
    id: idSchema,
    x: z.number(),
    y: z.number(),
    w: z.number().min(0),
    h: z.number().min(0),
    rotation: z.number(),
    z: zSchema,
    locked: z.boolean(),
    opacity: z.number().min(0).max(1),
    animation: AnimationSchema.optional(),
    alt: z.string().optional(),
    /** M10. Reveal auto-animate match key. Two elements with the same key animate between slides. */
    animateKey: z.string().regex(ANIMATE_KEY_RE).optional(),
  }
  return z.discriminatedUnion('type', [
    z.object({
      ...common,
      type: z.literal('text'),
      content: RichTextSchema,
      style: TextStyleSchema,
      role: z.enum(['title', 'subtitle', 'body']).optional(),
      /** M10. text-shadow. */
      shadow: ShadowSchema.optional(),
    }),
    z.object({
      ...common,
      type: z.literal('shape'),
      shape: z.enum(SHAPE_KINDS),
      fill: z.string(),
      stroke: z.string(),
      strokeWidth: z.number().min(0),
      text: RichTextSchema.optional(),
      /** M10. Canvas px. Used by rect and roundRect. Absent on roundRect means the legacy 12% corner. */
      radius: z.number().min(0).optional(),
      strokeDash: z.enum(['solid', 'dashed', 'dotted']).optional(),
      /** M10. Overrides `fill` when present. */
      gradient: GradientFillSchema.optional(),
      shadow: ShadowSchema.optional(),
    }),
    z.object({
      ...common,
      type: z.literal('image'),
      src: z.string(),
      fit: z.enum(['cover', 'contain']),
      crop: z
        .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) })
        .optional(),
      /** M10. Corner radius in canvas px. */
      radius: z.number().min(0).optional(),
      shadow: ShadowSchema.optional(),
    }),
    z.object({
      ...common,
      type: z.literal('chart'),
      chartType: z.enum(CHART_TYPES),
      data: ChartDataSchema,
      options: ChartOptionsSchema,
      echartsOverride: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      ...common,
      type: z.literal('diagram'),
      source: z.string(),
    }),
    z.object({
      ...common,
      type: z.literal('table'),
      rows: z.array(z.array(z.string())),
      header: z.boolean(),
      style: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    }),
    z.object({
      ...common,
      type: z.literal('code'),
      code: z.string(),
      language: z.string(),
    }),
    z.object({
      ...common,
      type: z.literal('embed'),
      url: z.string(),
    }),
    // M10. Vector icon. Paths are drawn inside the viewBox and scaled to the element box.
    z.object({
      ...common,
      type: z.literal('vector'),
      viewBox: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }),
      paths: z.array(VectorPathSchema).min(1).max(200),
      /** true = xMidYMid meet (keep proportions); false = none (stretch to the box). */
      preserveAspectRatio: z.boolean(),
    }),
  ])
}

export const ElementSchema = buildElement(z.string().min(1), z.number())
export const ElementInputSchema = buildElement(z.string().min(1).optional(), z.number().optional())

export type Element = z.infer<typeof ElementSchema>
export type ElementInput = z.infer<typeof ElementInputSchema>
export type ElementType = Element['type']
export type TextElement = Extract<Element, { type: 'text' }>
export type ShapeElement = Extract<Element, { type: 'shape' }>
export type ImageElement = Extract<Element, { type: 'image' }>
export type ChartElement = Extract<Element, { type: 'chart' }>
export type DiagramElement = Extract<Element, { type: 'diagram' }>
export type TableElement = Extract<Element, { type: 'table' }>
export type CodeElement = Extract<Element, { type: 'code' }>
export type EmbedElement = Extract<Element, { type: 'embed' }>
export type VectorElement = Extract<Element, { type: 'vector' }>
export type ChartData = z.infer<typeof ChartDataSchema>
export type ChartOptions = z.infer<typeof ChartOptionsSchema>

// ---------------------------------------------------------------------------
// Slides, sections, deck
// ---------------------------------------------------------------------------

export const SLIDE_LAYOUTS = ['title', 'title-content', 'two-column', 'section', 'blank', 'image-left', 'quote'] as const
export const TRANSITIONS = ['none', 'fade', 'slide', 'convex', 'concave', 'zoom'] as const

export const SlideBackgroundSchema = z.object({
  type: z.enum(['color', 'gradient', 'image']),
  value: z.string(),
})

// Everything on a slide except its id and elements.
export const SlideMetaSchema = z.object({
  sectionId: z.string().min(1).optional(),
  layout: z.enum(SLIDE_LAYOUTS),
  background: SlideBackgroundSchema.optional(),
  notes: z.string(),
  transition: z.enum(TRANSITIONS),
  autoAnimate: z.boolean(),
  hidden: z.boolean(),
})

export const SlideSchema = SlideMetaSchema.extend({
  id: z.string().min(1),
  elements: z.array(ElementSchema),
})
export type Slide = z.infer<typeof SlideSchema>
export type SlideLayout = Slide['layout']

export const SectionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
})
export type Section = z.infer<typeof SectionSchema>

// ---------------------------------------------------------------------------
// Brand kit reference (M9). The deck keeps the kit id, and the logo already
// resolved to an asset URL of this deck, so render and export need no lookups.
// ---------------------------------------------------------------------------

export const LOGO_CORNERS = ['tl', 'tr', 'bl', 'br'] as const
export const LOGO_SLIDES = ['all', 'all-but-title', 'none'] as const

export const LogoPlacementSchema = z.object({
  corner: z.enum(LOGO_CORNERS),
  /** Width of the logo as a percentage of the slide width (2 to 30). */
  widthPct: z.number().min(2).max(30),
  /** Distance from the two nearest edges, in canvas pixels (0 to 200). */
  margin: z.number().min(0).max(200),
  slides: z.enum(LOGO_SLIDES),
})
export type LogoPlacement = z.infer<typeof LogoPlacementSchema>

/** A logo src is either a deck asset URL or a raster/SVG data URL (the editor's own images). */
export const LogoSrcSchema = z
  .string()
  .min(1)
  .refine((s) => s.startsWith('/api/assets/') || /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(s), {
    message: 'logo must be a deck asset URL or an image data URL',
  })

export const BrandLogoSchema = z.object({
  src: LogoSrcSchema,
  placement: LogoPlacementSchema,
})
export type BrandLogo = z.infer<typeof BrandLogoSchema>

export const BrandRefSchema = z.object({
  brandKitId: z.string().min(1),
  logo: BrandLogoSchema.optional(),
  /**
   * The kit's palette and fonts as they were when the kit was applied. The AI constraint reads these,
   * not the theme, so a later hand edit of the theme does not widen what the assistant may use.
   */
  palette: z.record(z.string(), z.string()).optional(),
  fonts: z.object({ heading: z.string(), body: z.string() }).optional(),
})
export type BrandRef = z.infer<typeof BrandRefSchema>

export const DeckSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  size: z.object({ w: z.literal(1920), h: z.literal(1080) }),
  theme: ThemeSchema,
  sections: z.array(SectionSchema),
  slides: z.array(SlideSchema),
  version: z.literal(1),
  /** Set when a brand kit is applied. Absent for a deck without a kit. */
  brand: BrandRefSchema.optional(),
})
export type Deck = z.infer<typeof DeckSchema>

export const CANVAS_WIDTH = 1920
export const CANVAS_HEIGHT = 1080

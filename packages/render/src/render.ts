// Browser-safe renderers: slide and deck HTML for reveal.js.
// Node-only parts (reading reveal.js files for standalone output) live in render-node.ts.
import { FONT_IMPORT_RE, VECTOR_PATH_D_RE, logoAppliesToSlide, type Deck, type Element, type GradientFill, type Slide, type Theme, type TextElement, type ShapeElement, type ImageElement, type TableElement, type CodeElement, type EmbedElement, type DiagramElement, type VectorElement } from '@sleid/model'
import { richTextToHtml } from './rich-text.ts'
import { mermaidConfigFor, readableTextOn } from '@sleid/model'
import { renderChartSvg } from './chart.ts'
import { BASE_CSS, themeCssVariables } from './styles.ts'
import {
  assertInlineSafe,
  escapeHtml,
  num,
  safeBundleAssetPath,
  safeClass,
  safeColor,
  safeCssUrl,
  safeEmbedUrl,
  fontStack,
  safeFontFamily,
  safeGradient,
  safeImageSrc,
  safeToken,
  shadowList,
} from './html.ts'

export { chartToEchartsOption, renderChartSvg } from './chart.ts'
export { richTextToHtml } from './rich-text.ts'
export { themeCssVariables, BASE_CSS } from './styles.ts'

export const REVEAL_VERSION = '5.2.1'
export const DEFAULT_ASSET_BASE = `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}`
// Mermaid needs a browser, so diagrams load it from a CDN in standalone output only.
export const MERMAID_MODULE_URL = 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs'

const EFFECT_CLASS: Record<string, string> = {
  'fade-in': 'fade-in',
  'fade-up': 'fade-up',
  'fade-down': 'fade-down',
  'fade-left': 'fade-left',
  'fade-right': 'fade-right',
  grow: 'grow',
  shrink: 'shrink',
  'highlight-red': 'highlight-red',
  'zoom-in': 'zoom-in',
  // M10. Exit effects map to reveal's own classes. `wipe` has no reveal class: BASE_CSS styles `sleid-wipe`.
  'fade-out': 'fade-out',
  'current-visible': 'current-visible',
  'fade-in-then-out': 'fade-in-then-out',
  'semi-fade-out': 'semi-fade-out',
  wipe: 'sleid-wipe',
}

const TRANSITIONS = new Set(['none', 'fade', 'slide', 'convex', 'concave', 'zoom'])
const VALIGN: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
const ALIGN = new Set(['left', 'center', 'right', 'justify'])
const TEXT_TRANSFORMS = new Set(['none', 'uppercase', 'lowercase', 'capitalize'])
const LINE_CAPS = new Set(['butt', 'round', 'square'])
const LINE_JOINS = new Set(['miter', 'round', 'bevel'])

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

export interface SlideRenderOptions {
  /** Animated elements become reveal fragments (default). Print output turns this off: one page per slide, all content visible. */
  fragments?: boolean
}

export function renderSlideHtml(slide: Slide, deck: Deck, options: SlideRenderOptions = {}): string {
  const fragments = options.fragments !== false
  const theme = deck.theme
  const attrs = [`class="sleid-slide layout-${safeClass(slide.layout)}"`, `data-slide-id="${escapeHtml(slide.id)}"`]
  const transition = TRANSITIONS.has(slide.transition) ? slide.transition : 'none'
  attrs.push(`data-transition="${transition}"`)
  if (slide.autoAnimate) attrs.push('data-auto-animate')
  if (slide.hidden) attrs.push('data-visibility="hidden"')
  attrs.push(`style="${escapeHtml(slideBackgroundCss(slide, theme))}"`)

  const elements = [...slide.elements]
    .sort((a, b) => a.z - b.z)
    .map((el) => renderElement(el, theme, fragments))
    .join('')
  const notes = slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : ''
  return `<section ${attrs.join(' ')}><div class="sleid-stage">${elements}${logoOverlayHtml(slide, deck)}</div>${notes}</section>`
}

// ---------------------------------------------------------------------------
// Brand logo (M9). A slide overlay, not an element: it cannot be selected or moved
// by accident, and it is drawn the same way in present, HTML, PDF and PNG output.
// ---------------------------------------------------------------------------

const LOGO_POSITION: Record<string, (margin: string) => string> = {
  tl: (m) => `left:${m}px;top:${m}px`,
  tr: (m) => `right:${m}px;top:${m}px`,
  bl: (m) => `left:${m}px;bottom:${m}px`,
  br: (m) => `right:${m}px;bottom:${m}px`,
}

export function logoOverlayHtml(slide: Slide, deck: Deck): string {
  if (!logoAppliesToSlide(slide, deck)) return ''
  const logo = deck.brand!.logo!
  // Same rule as the model's LogoSrcSchema: an asset URL or a raster data URL, never a remote one. An export bundle
  // rewrites the asset URL to its file in the bundle (assets/<id>.<ext>), which is accepted too, as for element images.
  const isAsset = logo.src.startsWith('/api/assets/')
  const isRaster = /^data:image\/(png|jpeg|webp|gif);base64,/.test(logo.src)
  const isBundled = safeBundleAssetPath(logo.src) !== undefined
  const src = isAsset || isRaster || isBundled ? safeImageSrc(logo.src) : undefined
  if (!src) return ''
  const position = LOGO_POSITION[logo.placement.corner]
  if (!position) return ''
  const style = `position:absolute;${position(num(logo.placement.margin))};width:${num(logo.placement.widthPct)}%;height:auto;pointer-events:none;z-index:1000`
  return `<img class="sleid-brand-logo" src="${escapeHtml(src)}" alt="Logo" style="${escapeHtml(style)}">`
}

function slideBackgroundCss(slide: Slide, theme: Theme): string {
  const bg = slide.background
  if (bg?.type === 'color') return `background-color:${safeColor(bg.value, theme.colors.background)}`
  if (bg?.type === 'gradient') {
    const g = safeGradient(bg.value)
    if (g) return `background:${g}`
  }
  if (bg?.type === 'image') {
    const u = safeCssUrl(bg.value)
    if (u) return `background:${u} center / cover no-repeat`
  }
  if (theme.backgroundStyle === 'gradient') {
    const g = safeGradient(theme.backgroundValue)
    if (g) return `background:${g}`
  }
  if (theme.backgroundStyle === 'image') {
    const u = safeCssUrl(theme.backgroundValue)
    if (u) return `background:${u} center / cover no-repeat`
  }
  return `background-color:${safeColor(theme.colors.background, '#ffffff')}`
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export function renderElement(el: Element, theme: Theme, fragments = true): string {
  switch (el.type) {
    case 'text':
      return frame(el, renderText(el), 'sleid-text-el', fragments)
    case 'shape':
      return frame(el, renderShape(el, theme), 'sleid-shape', fragments)
    case 'image':
      return frame(el, renderImage(el), 'sleid-image-el', fragments)
    case 'chart':
      return frame(el, `<div class="sleid-chart">${renderChartSvg(el, theme)}</div>`, 'sleid-chart-el', fragments)
    case 'diagram':
      return frame(el, renderDiagram(el), 'sleid-diagram-el', fragments)
    case 'table':
      return frame(el, renderTable(el, theme), 'sleid-table-el', fragments)
    case 'code':
      return frame(el, renderCode(el), 'sleid-code-el', fragments)
    case 'embed':
      return frame(el, renderEmbed(el), 'sleid-embed-el', fragments)
    case 'vector':
      return frame(el, renderVector(el), 'sleid-vector-el', fragments)
  }
}

// Positioned wrapper. Fragment classes go on the wrapper so reveal can
// animate it. Rotation and opacity go on the inner body.
function frame(el: Element, inner: string, kind: string, fragments = true): string {
  const classes = ['sleid-el', kind]
  let fragmentAttr = ''
  if (el.animation && fragments) {
    classes.push('fragment', EFFECT_CLASS[el.animation.effect] ?? 'fade-in')
    fragmentAttr = ` data-fragment-index="${num(el.animation.order)}"`
  }
  // M10. Reveal's auto-animate matches elements by data-id across slides. A duplicated slide's copy
  // carries the source's key, so the pair matches. The real id stays in data-el.
  const matchId = el.animateKey ?? el.id
  const style = `left:${num(el.x)}px;top:${num(el.y)}px;width:${num(el.w)}px;height:${num(el.h)}px;z-index:${num(Math.round(el.z))}`
  const bodyStyle = `transform:rotate(${num(el.rotation)}deg);opacity:${num(Math.min(Math.max(el.opacity, 0), 1), 1)}`
  return `<div class="${classes.join(' ')}"${fragmentAttr} data-id="${escapeHtml(matchId)}" data-el="${escapeHtml(el.id)}" style="${escapeHtml(style)}"><div class="sleid-body" style="${escapeHtml(bodyStyle)}">${inner}</div></div>`
}

function renderText(el: TextElement): string {
  const s = el.style
  const parts = [`text-align:${ALIGN.has(s.align) ? s.align : 'left'}`, `justify-content:${VALIGN[s.valign] ?? 'flex-start'}`]
  const family = safeFontFamily(s.fontFamily)
  if (family) parts.push(`font-family:${fontStack(family, 'sans-serif')}`)
  if (typeof s.fontSize === 'number') parts.push(`font-size:${num(s.fontSize)}px`)
  if (s.color) parts.push(`color:${safeColor(s.color, '')}`)
  if (typeof s.lineHeight === 'number') parts.push(`line-height:${num(s.lineHeight)}`)
  // M10 typography. Each value is range-checked, so a bad one is simply left out.
  if (typeof s.fontWeight === 'number' && s.fontWeight >= 100 && s.fontWeight <= 900) parts.push(`font-weight:${num(Math.round(s.fontWeight))}`)
  if (typeof s.letterSpacing === 'number') parts.push(`letter-spacing:${num(s.letterSpacing)}em`)
  if (s.textTransform && TEXT_TRANSFORMS.has(s.textTransform)) parts.push(`text-transform:${s.textTransform}`)
  if (el.shadow) parts.push(`text-shadow:${shadowList(el.shadow, false)}`)
  const role = el.role ? ` data-role="${el.role}"` : ''
  return `<div class="sleid-text"${role} style="${escapeHtml(parts.filter((p) => !p.endsWith(':')).join(';'))}">${richTextToHtml(el.content)}</div>`
}

const STAR_POINTS = (() => {
  const points: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 50 : 20
    const angle = (Math.PI / 5) * i - Math.PI / 2
    points.push(`${(50 + r * Math.cos(angle)).toFixed(2)},${(50 + r * Math.sin(angle)).toFixed(2)}`)
  }
  return points.join(' ')
})()

// Rect, rounded rect and ellipse are drawn as styled divs, so CSS can do gradients, dashed borders
// and radii. The other kinds stay SVG.
function renderShape(el: ShapeElement, theme: Theme): string {
  const text = el.text ? `<div class="sleid-shape-text" style="color:${escapeHtml(safeColor(theme.colors.text, '#202124'))}">${richTextToHtml(el.text)}</div>` : ''
  if (el.shape === 'rect' || el.shape === 'roundRect' || el.shape === 'ellipse') return boxShapeHtml(el) + text

  const stops = el.gradient ? usableStops(el.gradient) : undefined
  // An SVG shape has no gradient here: it takes the first stop as its flat fill.
  const fill = stops ? stops[0]!.color : safeColor(el.fill, 'none')
  const stroke = safeColor(el.stroke, 'none')
  const sw = Math.max(el.strokeWidth, 0)
  const dash = strokeDashAttr(el.strokeDash, sw)
  const common = `fill="${escapeHtml(fill)}" stroke="${escapeHtml(stroke)}" stroke-width="${num(sw)}" vector-effect="non-scaling-stroke"${dash}`
  let geometry: string
  switch (el.shape) {
    case 'triangle':
      geometry = `<polygon points="50,0 100,100 0,100" ${common}/>`
      break
    case 'arrow':
      geometry = `<polygon points="0,35 65,35 65,15 100,50 65,85 65,65 0,65" ${common}/>`
      break
    case 'line':
      geometry = `<line x1="0" y1="50" x2="100" y2="50" fill="none" stroke="${escapeHtml(stroke)}" stroke-width="${num(sw)}" vector-effect="non-scaling-stroke"${dash}/>`
      break
    case 'star':
      geometry = `<polygon points="${STAR_POINTS}" ${common}/>`
      break
  }
  const filter = el.shadow ? ` style="${escapeHtml(`filter:drop-shadow(${shadowList(el.shadow, false)})`)}"` : ''
  const svg = `<svg class="sleid-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"${filter}>${geometry}</svg>`
  return svg + text
}

const DASH_STYLES = new Set(['solid', 'dashed', 'dotted'])

// Gradient stops with a bad colour or position are dropped. Fewer than two usable stops means no gradient.
function usableStops(g: GradientFill): { color: string; at: number }[] | undefined {
  const stops = g.stops.flatMap((s) => {
    const color = safeColor(s.color, '')
    return color && Number.isFinite(s.at) ? [{ color, at: Math.min(Math.max(s.at, 0), 1) }] : []
  })
  return stops.length >= 2 ? stops : undefined
}

function gradientCss(g: GradientFill): string | undefined {
  const stops = usableStops(g)
  if (!stops) return undefined
  const list = stops.map((s) => `${s.color} ${num(s.at * 100)}%`).join(', ')
  return g.type === 'radial' ? `radial-gradient(circle, ${list})` : `linear-gradient(${num(g.angle ?? 180, 180)}deg, ${list})`
}

// 'none' in the model means no paint. CSS has no 'none' colour, so it becomes transparent.
function paintOr(value: string): string {
  return value === 'none' ? 'transparent' : safeColor(value, 'transparent')
}

function boxShapeHtml(el: ShapeElement): string {
  const parts = ['position:absolute', 'inset:0', 'box-sizing:border-box']
  const background = el.gradient ? gradientCss(el.gradient) : undefined
  parts.push(background ? `background:${background}` : `background-color:${paintOr(el.fill)}`)
  if (el.strokeWidth > 0) {
    const style = el.strokeDash && DASH_STYLES.has(el.strokeDash) ? el.strokeDash : 'solid'
    parts.push(`border:${num(Math.max(el.strokeWidth, 0))}px ${style} ${paintOr(el.stroke)}`)
  }
  parts.push(`border-radius:${boxRadius(el)}`)
  if (el.shadow) parts.push(`box-shadow:${shadowList(el.shadow)}`)
  return `<div class="sleid-shape-box" style="${escapeHtml(parts.join(';'))}"></div>`
}

// Ellipse is a full circle or oval. A rounded rect with no radius keeps the legacy 12% corner.
function boxRadius(el: ShapeElement): string {
  if (el.shape === 'ellipse') return '50%'
  if (el.shape === 'roundRect' && el.radius === undefined) return '12%'
  return `${num(Math.max(el.radius ?? 0, 0))}px`
}

// SVG stroke dashes. Dotted uses round caps so each dash is a dot.
function strokeDashAttr(dash: ShapeElement['strokeDash'], sw: number): string {
  if (sw <= 0) return ''
  if (dash === 'dashed') return ` stroke-dasharray="${num(3 * sw)} ${num(2 * sw)}"`
  if (dash === 'dotted') return ` stroke-dasharray="0 ${num(2 * sw)}" stroke-linecap="round"`
  return ''
}

function renderImage(el: ImageElement): string {
  const src = safeImageSrc(el.src)
  if (!src) return `<div class="sleid-image sleid-image-empty"${imageWrapAttr(el)}></div>`
  const alt = escapeHtml(el.alt ?? '')
  const fit = el.fit === 'contain' ? 'contain' : 'cover'
  if (el.crop) {
    const cw = Math.max(el.crop.w, 0.0001)
    const ch = Math.max(el.crop.h, 0.0001)
    const style = `width:${num((1 / cw) * 100)}%;height:${num((1 / ch) * 100)}%;left:${num((-el.crop.x / cw) * 100)}%;top:${num((-el.crop.y / ch) * 100)}%;object-fit:${fit}`
    return `<div class="sleid-image"${imageWrapAttr(el)}><img src="${escapeHtml(src)}" alt="${alt}" style="${escapeHtml(style)}"></div>`
  }
  return `<div class="sleid-image"${imageWrapAttr(el)}><img src="${escapeHtml(src)}" alt="${alt}" style="object-fit:${fit}"></div>`
}

// M10. Radius and shadow of an image wrapper. The radius clips the picture (overflow hidden).
function imageWrapAttr(el: ImageElement): string {
  const parts: string[] = []
  if (el.radius !== undefined) parts.push(`border-radius:${num(Math.max(el.radius, 0))}px`, 'overflow:hidden')
  if (el.shadow) parts.push(`box-shadow:${shadowList(el.shadow)}`)
  return parts.length > 0 ? ` style="${escapeHtml(parts.join(';'))}"` : ''
}

// M10. Vector icon. Each path's d is re-checked, and every paint and attribute is sanitised.
// A path that fails the check is dropped; the rest still draw.
function renderVector(el: VectorElement): string {
  const paths: string[] = []
  for (const p of el.paths) {
    if (!VECTOR_PATH_D_RE.test(p.d)) continue
    const attrs = [
      `d="${escapeHtml(p.d)}"`,
      `fill="${escapeHtml(paintOr(p.fill))}"`,
      `stroke="${escapeHtml(paintOr(p.stroke))}"`,
      `stroke-width="${num(Math.max(p.strokeWidth, 0))}"`,
    ]
    if (p.lineCap && LINE_CAPS.has(p.lineCap)) attrs.push(`stroke-linecap="${p.lineCap}"`)
    if (p.lineJoin && LINE_JOINS.has(p.lineJoin)) attrs.push(`stroke-linejoin="${p.lineJoin}"`)
    if (p.opacity !== undefined) attrs.push(`opacity="${num(Math.min(Math.max(p.opacity, 0), 1), 1)}"`)
    paths.push(`<path ${attrs.join(' ')}/>`)
  }
  const vb = el.viewBox
  const viewBox = `${num(vb.x)} ${num(vb.y)} ${num(vb.w, 1)} ${num(vb.h, 1)}`
  const aspect = el.preserveAspectRatio ? 'xMidYMid meet' : 'none'
  return `<svg class="sleid-vector" viewBox="${viewBox}" preserveAspectRatio="${aspect}" width="100%" height="100%" aria-hidden="true">${paths.join('')}</svg>`
}

// Mermaid reads the element's text content, so escaped source is correct here.
function renderDiagram(el: DiagramElement): string {
  return `<pre class="mermaid sleid-diagram">${escapeHtml(el.source)}</pre>`
}

function renderTable(el: TableElement, theme: Theme): string {
  const headerFill = typeof el.style?.headerFill === 'string' ? safeColor(el.style.headerFill, '') : ''
  const borderColor = typeof el.style?.borderColor === 'string' ? safeColor(el.style.borderColor, '') : ''
  const tableStyle = [
    borderColor ? `--sleid-border:${borderColor}` : '',
    typeof el.style?.fontSize === 'number' ? `font-size:${num(el.style.fontSize)}px` : '',
  ]
    .filter(Boolean)
    .join(';')
  const rows = el.rows.map((row, rowIndex) => {
    const isHeader = el.header && rowIndex === 0
    const cellTag = isHeader ? 'th' : 'td'
    // The header text is picked to read on the header fill (a dark text on a strong fill is not readable).
    const cellStyle = isHeader && headerFill ? ` style="background:${escapeHtml(headerFill)}; color:${readableTextOn(headerFill, theme.colors.text)}"` : ''
    return `<tr>${row.map((cell) => `<${cellTag}${cellStyle}>${escapeHtml(cell)}</${cellTag}>`).join('')}</tr>`
  })
  return `<table class="sleid-table"${tableStyle ? ` style="${escapeHtml(tableStyle)}"` : ''}>${rows.join('')}</table>`
}

function renderCode(el: CodeElement): string {
  const lang = safeToken(el.language)
  const cls = lang ? ` class="language-${lang}"` : ''
  return `<pre class="sleid-code"><code${cls}>${escapeHtml(el.code)}</code></pre>`
}

// Sandboxed without allow-same-origin, so an embed gets an opaque origin.
function renderEmbed(el: EmbedElement): string {
  const url = safeEmbedUrl(el.url)
  if (!url) return `<div class="sleid-embed sleid-embed-blocked">Embed blocked: only http(s) links are allowed</div>`
  return `<iframe class="sleid-embed" src="${escapeHtml(url)}" sandbox="allow-scripts allow-popups allow-presentation" referrerpolicy="strict-origin-when-cross-origin" loading="lazy" allowfullscreen></iframe>`
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

export type RenderMode = 'present' | 'standalone' | 'print'

export interface RevealAssets {
  revealCss: string
  revealJs: string
  notesJs: string
}

/**
 * Where the mermaid library comes from. `module` loads an ES module (the default, from jsDelivr).
 * A classic script (`module: false`) works from file:// too, so offline bundles use it.
 */
export interface MermaidScript {
  src: string
  module: boolean
}

export interface RenderDeckOptions {
  mode: RenderMode
  /** Base URL of reveal.js when `assets` is not given. Defaults to jsDelivr. */
  assetBase?: string
  /** Inline reveal.js. Required for standalone; used by print when given (so the page needs no network). */
  assets?: RevealAssets
  /** Mermaid source. Default: the jsDelivr ES module. Used when the deck has diagrams and the mode is standalone or print. */
  mermaid?: MermaidScript
  /** Print mode only: speaker notes on a separate page after each slide (reveal showNotes 'separate-page'). */
  showNotes?: boolean
}

export const DEFAULT_MERMAID_SCRIPT: MermaidScript = { src: MERMAID_MODULE_URL, module: true }

/** Set on <html> when diagrams have been drawn (`done`) or failed (`error`). Exporters wait for it. */
export const DIAGRAMS_STATE_ATTR = 'data-sleid-diagrams'

function mermaidScriptTags(script: MermaidScript, config: Record<string, unknown>): string[] {
  const src = JSON.stringify(script.src).replace(/</g, '\\u003c')
  // The deck theme for diagrams (mermaid-theme.ts). The JSON is escaped so no value can close the script element.
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c')
  // mermaid.render lays each diagram out in a scratch node on <body>, outside reveal's scaled
  // slide stage. Running in place (mermaid.run) measured labels inside the transformed, possibly
  // hidden slide and produced ~2px-tall, blank labels.
  // A diagram that fails gets a placeholder in its own place, with the attribute on that element only.
  // The root attribute is 'done' once every diagram has been tried. 'error' means mermaid itself did not start.
  const placeholder = `function sleidDiagramFallback() {
    const box = document.createElement('div');
    box.className = 'sleid-diagram-error';
    box.setAttribute('${DIAGRAMS_STATE_ATTR}', 'error');
    box.textContent = 'Diagram could not be drawn';
    return box;
  }`
  const run = `mermaid.initialize(${configJson});
    const nodes = [...document.querySelectorAll('.mermaid')];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      try {
        const out = await mermaid.render('sleid-mmd-' + i, node.textContent || '');
        node.innerHTML = out.svg;
        node.setAttribute('data-processed', 'true');
      } catch (err) {
        console.error(err);
        node.replaceWith(sleidDiagramFallback());
        document.getElementById('dsleid-mmd-' + i)?.remove();
      }
    }
    document.documentElement.setAttribute('${DIAGRAMS_STATE_ATTR}', 'done');`
  // mermaid itself did not start: no diagram is drawn, so every undrawn source gets the placeholder, never its text.
  const failed = `console.error(err);
    document.querySelectorAll('.mermaid:not([data-processed])').forEach((node) => node.replaceWith(sleidDiagramFallback()));
    document.documentElement.setAttribute('${DIAGRAMS_STATE_ATTR}', 'error');`
  if (script.module) {
    return [
      `<script type="module">
  ${placeholder}
  try {
    const { default: mermaid } = await import(${src});
    ${run}
  } catch (err) { ${failed} }
</script>`,
    ]
  }
  return [
    `<script src="${escapeHtml(script.src)}"></script>`,
    `<script>
  ${placeholder}
  (async () => {
    try {
      ${run}
    } catch (err) { ${failed} }
  })();
</script>`,
  ]
}

/**
 * M10. Google Fonts stylesheet URL for the theme's `fontImports`, or undefined when there are none.
 * Each value is re-checked with the schema pattern, so a bad import is dropped rather than put in the URL.
 * Used by renderDeckHtml, and by the editor.
 */
export function googleFontsHref(theme: Theme): string | undefined {
  const families = (theme.fontImports ?? []).filter((f) => typeof f === 'string' && FONT_IMPORT_RE.test(f)).slice(0, 6)
  if (families.length === 0) return undefined
  const query = families.map((f) => `family=${encodeFamily(f)}`).join('&')
  return `https://fonts.googleapis.com/css2?${query}&display=swap`
}

// Google's css2 format: spaces as '+', and the separators ':' ';' '@' ',' left readable.
function encodeFamily(family: string): string {
  return encodeURIComponent(family)
    .replace(/%20/g, '+')
    .replace(/%3A/g, ':')
    .replace(/%3B/g, ';')
    .replace(/%40/g, '@')
    .replace(/%2C/g, ',')
}

export function renderDeckHtml(deck: Deck, options: RenderDeckOptions): string {
  const { mode } = options
  if (mode === 'standalone' && !options.assets) {
    throw new Error('standalone mode needs reveal.js assets; use renderStandaloneDeckHtml from @sleid/render/node')
  }
  const base = (options.assetBase ?? DEFAULT_ASSET_BASE).replace(/\/$/, '')
  const slides = deck.slides.map((s) => renderSlideHtml(s, deck, { fragments: mode !== 'print' })).join('\n')
  const hasDiagrams = deck.slides.some((s) => s.elements.some((e) => e.type === 'diagram'))

  const head: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(deck.title)}</title>`,
  ]
  const fontsHref = googleFontsHref(deck.theme)
  if (fontsHref) head.push(`<link rel="stylesheet" href="${escapeHtml(fontsHref)}">`)
  head.push(`<style>\n${themeCssVariables(deck.theme)}\n${BASE_CSS}\n</style>`)
  if (mode === 'print' && options.showNotes) {
    // The last notes page would end with a page break and print an empty trailing page.
    head.push('<style>.reveal .slides > :last-child { page-break-after: auto !important; break-after: auto !important; }</style>')
  }
  if (hasDiagrams) {
    // Mermaid appends a hover tooltip to <body>, outside the slide. It would add a page when printed.
    head.push('<style>div.mermaidTooltip { display: none !important; }</style>')
  }
  const scripts: string[] = []

  if (options.assets) {
    const a = options.assets
    head.push(`<style>\n${assertInlineSafe(a.revealCss, 'style', 'reveal.css')}\n</style>`)
    scripts.push(`<script>\n${assertInlineSafe(a.revealJs, 'script', 'reveal.js')}\n</script>`)
    scripts.push(`<script>\n${assertInlineSafe(a.notesJs, 'script', 'reveal notes plugin')}\n</script>`)
  } else {
    head.push(`<link rel="stylesheet" href="${escapeHtml(`${base}/dist/reveal.css`)}">`)
    scripts.push(`<script src="${escapeHtml(`${base}/dist/reveal.js`)}"></script>`)
    scripts.push(`<script src="${escapeHtml(`${base}/plugin/notes/notes.js`)}"></script>`)
  }

  const printOptions = mode === 'print' ? ', controls: false, progress: false' : ''
  const notesOption = mode === 'print' && options.showNotes ? ", showNotes: 'separate-page'" : ''
  scripts.push(`<script>\n  Reveal.initialize({ width: 1920, height: 1080, margin: 0, hash: true, plugins: [RevealNotes]${printOptions}${notesOption} });\n</script>`)

  if (hasDiagrams && (mode === 'standalone' || mode === 'print' || options.mermaid)) {
    scripts.push(...mermaidScriptTags(options.mermaid ?? DEFAULT_MERMAID_SCRIPT, mermaidConfigFor(deck.theme)))
  }

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    ...head,
    '</head>',
    `<body class="sleid-${mode}">`,
    '<div class="reveal"><div class="slides">',
    slides,
    '</div></div>',
    ...scripts,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

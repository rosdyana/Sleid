// Browser-safe renderers: slide and deck HTML for reveal.js.
// Node-only parts (reading reveal.js files for standalone output) live in render-node.ts.
import type { Deck, Element, Slide, Theme, TextElement, ShapeElement, ImageElement, TableElement, CodeElement, EmbedElement, DiagramElement } from '@sleid/model'
import { richTextToHtml } from './rich-text.ts'
import { renderChartSvg } from './chart.ts'
import { BASE_CSS, themeCssVariables } from './styles.ts'
import {
  assertInlineSafe,
  escapeHtml,
  num,
  safeClass,
  safeColor,
  safeCssUrl,
  safeEmbedUrl,
  fontStack,
  safeFontFamily,
  safeGradient,
  safeImageSrc,
  safeToken,
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
}

const TRANSITIONS = new Set(['none', 'fade', 'slide', 'convex', 'concave', 'zoom'])
const VALIGN: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
const ALIGN = new Set(['left', 'center', 'right', 'justify'])

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
  return `<section ${attrs.join(' ')}><div class="sleid-stage">${elements}</div>${notes}</section>`
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
      return frame(el, renderTable(el), 'sleid-table-el', fragments)
    case 'code':
      return frame(el, renderCode(el), 'sleid-code-el', fragments)
    case 'embed':
      return frame(el, renderEmbed(el), 'sleid-embed-el', fragments)
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
  const style = `left:${num(el.x)}px;top:${num(el.y)}px;width:${num(el.w)}px;height:${num(el.h)}px;z-index:${num(Math.round(el.z))}`
  const bodyStyle = `transform:rotate(${num(el.rotation)}deg);opacity:${num(Math.min(Math.max(el.opacity, 0), 1), 1)}`
  return `<div class="${classes.join(' ')}"${fragmentAttr} data-id="${escapeHtml(el.id)}" style="${escapeHtml(style)}"><div class="sleid-body" style="${escapeHtml(bodyStyle)}">${inner}</div></div>`
}

function renderText(el: TextElement): string {
  const s = el.style
  const parts = [`text-align:${ALIGN.has(s.align) ? s.align : 'left'}`, `justify-content:${VALIGN[s.valign] ?? 'flex-start'}`]
  const family = safeFontFamily(s.fontFamily)
  if (family) parts.push(`font-family:${fontStack(family, 'sans-serif')}`)
  if (typeof s.fontSize === 'number') parts.push(`font-size:${num(s.fontSize)}px`)
  if (s.color) parts.push(`color:${safeColor(s.color, '')}`)
  if (typeof s.lineHeight === 'number') parts.push(`line-height:${num(s.lineHeight)}`)
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

function renderShape(el: ShapeElement, theme: Theme): string {
  const fill = safeColor(el.fill, 'none')
  const stroke = safeColor(el.stroke, 'none')
  const sw = num(Math.max(el.strokeWidth, 0))
  const common = `fill="${escapeHtml(fill)}" stroke="${escapeHtml(stroke)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"`
  let geometry: string
  switch (el.shape) {
    case 'rect':
      geometry = `<rect x="0" y="0" width="100" height="100" ${common}/>`
      break
    case 'roundRect':
      geometry = `<rect x="0" y="0" width="100" height="100" rx="12" ry="12" ${common}/>`
      break
    case 'ellipse':
      geometry = `<ellipse cx="50" cy="50" rx="50" ry="50" ${common}/>`
      break
    case 'triangle':
      geometry = `<polygon points="50,0 100,100 0,100" ${common}/>`
      break
    case 'arrow':
      geometry = `<polygon points="0,35 65,35 65,15 100,50 65,85 65,65 0,65" ${common}/>`
      break
    case 'line':
      geometry = `<line x1="0" y1="50" x2="100" y2="50" fill="none" stroke="${escapeHtml(stroke)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>`
      break
    case 'star':
      geometry = `<polygon points="${STAR_POINTS}" ${common}/>`
      break
  }
  const svg = `<svg class="sleid-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${geometry}</svg>`
  const text = el.text ? `<div class="sleid-shape-text" style="color:${escapeHtml(safeColor(theme.colors.text, '#202124'))}">${richTextToHtml(el.text)}</div>` : ''
  return svg + text
}

function renderImage(el: ImageElement): string {
  const src = safeImageSrc(el.src)
  if (!src) return `<div class="sleid-image sleid-image-empty"></div>`
  const alt = escapeHtml(el.alt ?? '')
  const fit = el.fit === 'contain' ? 'contain' : 'cover'
  if (el.crop) {
    const cw = Math.max(el.crop.w, 0.0001)
    const ch = Math.max(el.crop.h, 0.0001)
    const style = `width:${num((1 / cw) * 100)}%;height:${num((1 / ch) * 100)}%;left:${num((-el.crop.x / cw) * 100)}%;top:${num((-el.crop.y / ch) * 100)}%;object-fit:${fit}`
    return `<div class="sleid-image"><img src="${escapeHtml(src)}" alt="${alt}" style="${escapeHtml(style)}"></div>`
  }
  return `<div class="sleid-image"><img src="${escapeHtml(src)}" alt="${alt}" style="object-fit:${fit}"></div>`
}

// Mermaid reads the element's text content, so escaped source is correct here.
function renderDiagram(el: DiagramElement): string {
  return `<pre class="mermaid sleid-diagram">${escapeHtml(el.source)}</pre>`
}

function renderTable(el: TableElement): string {
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
    const cellStyle = isHeader && headerFill ? ` style="background:${escapeHtml(headerFill)}"` : ''
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

function mermaidScriptTags(script: MermaidScript): string[] {
  const src = JSON.stringify(script.src).replace(/</g, '\\u003c')
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
  const run = `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
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
    `<style>\n${themeCssVariables(deck.theme)}\n${BASE_CSS}\n</style>`,
  ]
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
    scripts.push(...mermaidScriptTags(options.mermaid ?? DEFAULT_MERMAID_SCRIPT))
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

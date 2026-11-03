// React rendering of a slide's elements. The same component draws the main
// canvas (scale = stage width / 1920) and the filmstrip thumbnails (small scale).
// Positions are multiplied by `scale` in layout, not by a CSS transform, so
// react-moveable works in real pixels and the gesture maths stays simple.
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import * as echarts from 'echarts'
import { logoAppliesToBrand, type BrandLogo, type BrandRef, type ChartElement, type Element, type RichNode, type RichText, type ShapeElement, type Slide, type Theme } from '@sleid/model'
import { chartToEchartsOption, fontStack, safeColor } from '@sleid/render'
import { mermaidConfigFor, readableTextOn } from '@sleid/model'
import { CANVAS_H, CANVAS_W } from './commands.ts'
import { boxShapeStyle, imageWrapStyle, shapeSvgPaint, textBoxStyle, textStyleMarkCss, vectorPathProps, vectorViewBox, visibleVectorPaths } from './element-style.ts'

export function safeImageSrc(src: string): string | undefined {
  return /^(https?:\/\/|data:image\/(png|jpeg|gif|webp|svg\+xml);|\/)/i.test(src) ? src : undefined
}

export function safeEmbedSrc(src: string): string | undefined {
  return /^https?:\/\//i.test(src) ? src : undefined
}

const GRADIENT = /^(linear|radial)-gradient\([^;{}<>]*\)$/i

export function slideBackground(slide: Slide, theme: Theme): CSSProperties {
  const bg = slide.background
  if (bg?.type === 'color') return { backgroundColor: bg.value }
  if (bg?.type === 'gradient' && GRADIENT.test(bg.value)) return { backgroundImage: bg.value }
  if (bg?.type === 'image') {
    const src = safeImageSrc(bg.value)
    if (src) return { backgroundImage: `url("${src.replace(/"/g, '%22')}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
  }
  return { backgroundColor: theme.colors.background }
}

interface SurfaceProps {
  slide: Slide
  theme: Theme
  /** The deck's brand reference (M9). Its logo is drawn over the slide, as in the renderer. */
  brand?: BrandRef | undefined
  scale: number
  selectedIds?: readonly string[]
  editingId?: string | null
  renderEditing?: (el: Element) => ReactNode
  onElementPointerDown?: (el: Element, event: ReactPointerEvent<HTMLDivElement>) => void
  onElementDoubleClick?: (el: Element) => void
  showGuides?: boolean
}

/** One slide drawn at `scale`. Elements are sorted by z. */
export function SlideSurface({
  slide,
  theme,
  brand,
  scale,
  selectedIds = [],
  editingId = null,
  renderEditing,
  onElementPointerDown,
  onElementDoubleClick,
  showGuides = false,
}: SurfaceProps) {
  const sorted = [...slide.elements].sort((a, b) => a.z - b.z)
  return (
    <div
      className="relative overflow-hidden"
      style={{ width: CANVAS_W * scale, height: CANVAS_H * scale, ...slideBackground(slide, theme) }}
    >
      {sorted.map((el) => {
        const selected = selectedIds.includes(el.id)
        const editing = editingId === el.id && renderEditing
        return (
          <div
            key={el.id}
            data-el={el.id}
            data-type={el.type}
            onPointerDown={onElementPointerDown ? (e) => onElementPointerDown(el, e) : undefined}
            onDoubleClick={onElementDoubleClick ? (e: MouseEvent) => { e.stopPropagation(); onElementDoubleClick(el) } : undefined}
            className={`absolute ${selected ? 'outline outline-2 outline-accent' : ''} ${showGuides ? 'outline outline-1 outline-dashed outline-[#c4c7c5]' : ''}`}
            style={{
              left: el.x * scale,
              top: el.y * scale,
              width: el.w * scale,
              height: el.h * scale,
              zIndex: Math.round(el.z),
              transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
              opacity: el.opacity,
            }}
          >
            {editing ? renderEditing(el) : <ElementBody el={el} theme={theme} scale={scale} />}
          </div>
        )
      })}
      {brand?.logo && logoAppliesToBrand(slide, brand) ? <BrandLogoOverlay logo={brand.logo} scale={scale} /> : null}
    </div>
  )
}

export function ElementBody({ el, theme, scale }: { el: Element; theme: Theme; scale: number }) {
  const headingFont = fontStack(theme.fonts.heading, 'sans-serif')
  switch (el.type) {
    case 'text':
      return (
        <div className="h-full w-full overflow-hidden" style={textBoxStyle(el, theme, scale)}>
          <RichView doc={el.content} headingFont={headingFont} />
        </div>
      )
    case 'shape':
      return (
        <div className="relative h-full w-full">
          {el.shape === 'rect' || el.shape === 'roundRect' || el.shape === 'ellipse' ? (
            <div style={boxShapeStyle(el, scale)} />
          ) : (
            <ShapeSvg el={el} scale={scale} />
          )}
          {el.text && (
            <div
              className="absolute inset-0 flex flex-col justify-center text-center"
              style={{ padding: '0.5em', fontSize: theme.sizes.body * scale, color: safeColor(theme.colors.text, '#202124') }}
            >
              <RichView doc={el.text} headingFont={headingFont} />
            </div>
          )}
        </div>
      )
    case 'image': {
      const src = safeImageSrc(el.src)
      const wrap = imageWrapStyle(el, scale)
      if (!src) return <div className="grid h-full w-full place-items-center bg-[#eceff1] text-[12px] text-[#5f6368]" style={wrap}>Image</div>
      return (
        <div className="h-full w-full" style={wrap}>
          <img src={src} alt={el.alt ?? ''} draggable={false} className="h-full w-full select-none" style={{ objectFit: el.fit }} />
        </div>
      )
    }
    case 'chart':
      return <ChartView key={scale < 0.5 ? 'lo' : 'hi'} el={el} theme={theme} scale={scale} />
    case 'diagram':
      return <DiagramView source={el.source} theme={theme} />
    case 'table':
      return (
        <table className="h-full w-full border-collapse" style={{ fontSize: theme.sizes.small * scale, color: theme.colors.text }}>
          <tbody>
            {el.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => {
                  const isHeader = el.header && r === 0
                  const Tag = isHeader ? 'th' : 'td'
                  // Same header fill and text rule as the HTML render and the PowerPoint export.
                  const fill = isHeader ? (typeof el.style?.headerFill === 'string' ? el.style.headerFill : theme.colors.surface) : undefined
                  return (
                    <Tag key={c} className="border border-[#c4c7c5] px-2 text-left" style={{ background: fill, color: fill ? readableTextOn(fill, theme.colors.text) : undefined, fontWeight: isHeader ? 600 : 400 }}>
                      {cell}
                    </Tag>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'code':
      return (
        <pre
          className="m-0 h-full w-full overflow-hidden whitespace-pre rounded p-3 text-[#e8eaed]"
          style={{ background: '#1f1f1f', fontFamily: theme.fonts.mono, fontSize: theme.sizes.small * scale }}
        >
          {el.code}
        </pre>
      )
    case 'embed': {
      const src = safeEmbedSrc(el.url)
      if (!src) return <div className="grid h-full w-full place-items-center bg-[#eceff1]">Embed URL must be http(s)</div>
      return <iframe src={src} title="Embed" sandbox="allow-scripts allow-popups" className="h-full w-full border-0" />
    }
    // M10. Same attributes as renderVector in the renderer. Paths failing the d check are skipped.
    case 'vector':
      return (
        <svg
          className="block h-full w-full overflow-visible"
          viewBox={vectorViewBox(el)}
          preserveAspectRatio={el.preserveAspectRatio ? 'xMidYMid meet' : 'none'}
          width="100%"
          height="100%"
          aria-hidden="true"
        >
          {visibleVectorPaths(el).map((p, i) => (
            <path key={i} {...vectorPathProps(p)} />
          ))}
        </svg>
      )
  }
}

const STAR_POINTS = (() => {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 50 : 20
    const a = (Math.PI / 5) * i - Math.PI / 2
    pts.push(`${(50 + r * Math.cos(a)).toFixed(2)},${(50 + r * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
})()

// Geometry matches the renderer's renderShape for the SVG kinds (triangle, arrow, line, star).
function ShapeSvg({ el, scale }: { el: ShapeElement; scale: number }) {
  const paint = shapeSvgPaint(el, scale)
  const common = { fill: paint.fill, stroke: paint.stroke, strokeWidth: paint.strokeWidth, vectorEffect: 'non-scaling-stroke', strokeDasharray: paint.strokeDasharray, strokeLinecap: paint.strokeLinecap }
  const body = (() => {
    switch (el.shape) {
      case 'triangle':
        return <polygon points="50,0 100,100 0,100" {...common} />
      case 'arrow':
        return <polygon points="0,35 65,35 65,15 100,50 65,85 65,65 0,65" {...common} />
      case 'line':
        return <line x1="0" y1="50" x2="100" y2="50" {...common} fill="none" />
      case 'star':
        return <polygon points={STAR_POINTS} {...common} />
      default:
        // rect, roundRect and ellipse are drawn as boxes (boxShapeStyle), not here.
        return null
    }
  })()
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible" style={paint.filter ? { filter: paint.filter } : undefined} aria-hidden="true">
      {body}
    </svg>
  )
}

/** Rich text (ProseMirror-style JSON) as React nodes. Unknown nodes keep their children. */
export function RichView({ doc, headingFont }: { doc: RichText | RichNode | undefined; headingFont?: string | undefined }) {
  return <>{renderNodes(doc?.content, { headingFont, listDepth: 0 })}</>
}

interface RichCtx {
  headingFont: string | undefined
  /** How many lists enclose this node. A bullet list inside a bullet list uses a circle, as BASE_CSS does. */
  listDepth: number
}

function renderNodes(nodes: RichNode[] | undefined, ctx: RichCtx): ReactNode[] {
  return (nodes ?? []).map((node, i) => renderNode(node, i, ctx))
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

// Spacing and line height follow BASE_CSS in the renderer (paragraphs 0 0 0.4em, headings 0 0 0.3em at 1.15, lists 0 0 0.4em with 1.2em indent).
function renderNode(node: RichNode, key: number, ctx: RichCtx): ReactNode {
  if (node.type === 'text') {
    let out: ReactNode = node.text ?? ''
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case 'bold':
          out = <strong>{out}</strong>
          break
        case 'italic':
          out = <em>{out}</em>
          break
        case 'underline':
          out = <u>{out}</u>
          break
        case 'strike':
          out = <s>{out}</s>
          break
        case 'code':
          out = <code>{out}</code>
          break
        case 'textStyle':
          out = <span style={textStyleMarkCss(mark.attrs)}>{out}</span>
          break
        case 'link':
          out = <span className="text-accent underline">{out}</span>
          break
      }
    }
    return <span key={key}>{out}</span>
  }
  if (node.type === 'hardBreak') return <br key={key} />
  const inner = (next: RichCtx = ctx) => renderNodes(node.content, next)
  switch (node.type) {
    case 'bulletList':
      return (
        <ul key={key} style={{ margin: '0 0 0.4em', paddingLeft: '1.2em', listStyle: ctx.listDepth > 0 ? 'circle outside' : 'disc outside' }}>
          {inner({ ...ctx, listDepth: ctx.listDepth + 1 })}
        </ul>
      )
    case 'orderedList':
      return (
        <ol key={key} style={{ margin: '0 0 0.4em', paddingLeft: '1.2em', listStyle: 'decimal outside' }}>
          {inner({ ...ctx, listDepth: ctx.listDepth + 1 })}
        </ol>
      )
    case 'listItem':
      return <li key={key}>{inner()}</li>
    case 'heading': {
      const level = node.attrs?.level
      const n = typeof level === 'number' ? Math.round(level) : 1
      const Tag = HEADINGS[Math.min(Math.max(n, 1), 6) - 1]!
      return (
        <Tag key={key} style={{ margin: '0 0 0.3em', lineHeight: 1.15, fontFamily: ctx.headingFont, fontWeight: 700, fontSize: '1.3em' }}>
          {inner()}
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p key={key} style={{ margin: '0 0 0.4em', minHeight: '1em' }}>
          {inner()}
        </p>
      )
    default:
      return <div key={key}>{inner()}</div>
  }
}

// The ECharts option uses slide-space pixel sizes (fonts, grid offsets) tuned for the 1920×1080
// stage, so the chart is laid out at its real size and scaled down visually. This keeps the
// editor, thumbnails and the reveal render identical.
function ChartView({ el, theme, scale }: { el: ChartElement; theme: Theme; scale: number }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chart = echarts.init(host, undefined, { renderer: 'canvas', devicePixelRatio: Math.max(1, (window.devicePixelRatio || 1) * Math.min(1, scale)) })
    chartRef.current = chart
    return () => {
      chart.dispose()
      chartRef.current = null
    }
    // devicePixelRatio is fixed at init; a zoom change re-creates the chart via the key below.
  }, [])

  useEffect(() => {
    chartRef.current?.resize({ width: el.w, height: el.h })
  }, [el.w, el.h])

  useEffect(() => {
    chartRef.current?.setOption(chartToEchartsOption(el, theme), { notMerge: true })
  }, [el, theme])

  return (
    <div className="h-full w-full overflow-hidden">
      <div ref={hostRef} style={{ width: el.w, height: el.h, transform: `scale(${scale})`, transformOrigin: '0 0' }} />
    </div>
  )
}

function DiagramView({ source, theme }: { source: string; theme: Theme }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const id = `mmd-${Math.random().toString(36).slice(2, 10)}`
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize(mermaidConfigFor(theme))
        const out = await mermaid.render(id, source)
        if (!cancelled) {
          setSvg(out.svg)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Diagram failed to render')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, theme])

  if (error) return <div className="h-full w-full overflow-auto bg-red-50 p-2 text-[11px] text-red-800">{error}</div>
  return <div className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
}

/**
 * The brand logo over a slide (M9). Not an element: it has no pointer events, so it cannot be selected or moved in the
 * editor. Placement follows the renderer: the corner, the width as a share of the slide, and the margin in canvas pixels.
 */
function BrandLogoOverlay({ logo, scale }: { logo: BrandLogo; scale: number }) {
  const src = safeImageSrc(logo.src)
  const isAsset = logo.src.startsWith('/api/assets/')
  const isRaster = /^data:image\/(png|jpeg|webp|gif);base64,/.test(logo.src)
  if (!src || !(isAsset || isRaster)) return null
  const p = logo.placement
  const margin = p.margin * scale
  const style: CSSProperties = { position: 'absolute', width: `${p.widthPct}%`, height: 'auto', pointerEvents: 'none', zIndex: 1000 }
  if (p.corner.endsWith('l')) style.left = margin
  else style.right = margin
  if (p.corner.startsWith('t')) style.top = margin
  else style.bottom = margin
  return <img src={src} alt="" aria-hidden="true" draggable={false} data-brand-logo="" style={style} />
}

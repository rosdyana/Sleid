// Icons come from the `lucide` package. Its nodes are [tag, attrs] pairs; each shape is converted to an SVG path `d`
// so the icon can be drawn by a vector element (24 x 24 viewBox, stroked).
import { icons, type IconNode } from 'lucide'
import { VECTOR_PATH_D_RE, type ElementInput } from '@sleid/model'

export interface IconPath {
  d: string
}

export interface IconBox {
  x: number
  y: number
  size: number
}

const ICONS = icons as unknown as Record<string, IconNode>
const KEYS = Object.keys(ICONS)
const BY_STRIPPED = new Map<string, string>()
for (const key of KEYS) BY_STRIPPED.set(stripName(key), key)

function stripName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** PascalCase lucide name to kebab-case, for listing: EyeOff -> eye-off. */
function kebab(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/** The lucide key for a name in kebab-case, PascalCase, lowercase or camelCase. Undefined when there is no such icon. */
export function resolveIconName(name: string): string | undefined {
  const trimmed = name.trim()
  if (ICONS[trimmed]) return trimmed
  const pascal = trimmed
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('')
  if (ICONS[pascal]) return pascal
  const stripped = stripName(trimmed)
  return stripped ? BY_STRIPPED.get(stripped) : undefined
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]!
}

/** Up to five icon names near `name`: substring matches first, then the smallest edit distance. */
export function closestIconNames(name: string, limit = 5): string[] {
  const target = stripName(name)
  const scored = KEYS.map((key) => {
    const s = stripName(key)
    const sub = target.length > 0 && (s.includes(target) || target.includes(s)) ? 0 : 1
    return { key, score: sub * 1000 + levenshtein(target, s) }
  })
  scored.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key))
  return scored.slice(0, limit).map((s) => kebab(s.key))
}

function unknownIcon(name: string): Error {
  return new Error(`Unknown icon "${name}". Closest: ${closestIconNames(name).join(', ')}. Use listIcons(query) to search.`)
}

function f(n: number): string {
  return String(Number(n.toFixed(3)))
}

function num(attrs: Record<string, string | number | undefined>, key: string, fallback?: number): number {
  const raw = attrs[key]
  if (raw === undefined) {
    if (fallback !== undefined) return fallback
    return Number.NaN
  }
  return Number(raw)
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`
}

function rectPath(x: number, y: number, w: number, h: number, rxIn: number, ryIn: number): string {
  if (rxIn <= 0 || ryIn <= 0) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`
  const rx = Math.min(rxIn, w / 2)
  const ry = Math.min(ryIn, h / 2)
  return [
    `M${f(x + rx)} ${f(y)}`,
    `H${f(x + w - rx)}`,
    `A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w)} ${f(y + ry)}`,
    `V${f(y + h - ry)}`,
    `A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w - rx)} ${f(y + h)}`,
    `H${f(x + rx)}`,
    `A${f(rx)} ${f(ry)} 0 0 1 ${f(x)} ${f(y + h - ry)}`,
    `V${f(y + ry)}`,
    `A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(y)}`,
    'Z',
  ].join('')
}

function pointsOf(value: string | number | undefined): number[] {
  if (value === undefined) return []
  return String(value)
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n))
}

/** The path for one lucide shape node. Returns nothing for a tag it does not draw, or for a shape with a missing number. */
function shapeToPath(tag: string, attrs: Record<string, string | number | undefined>): string | undefined {
  switch (tag) {
    case 'path': {
      const d = attrs.d
      return typeof d === 'string' ? d : undefined
    }
    case 'circle': {
      const cx = num(attrs, 'cx', 0)
      const cy = num(attrs, 'cy', 0)
      const r = num(attrs, 'r')
      return Number.isFinite(r) ? ellipsePath(cx, cy, r, r) : undefined
    }
    case 'ellipse': {
      const cx = num(attrs, 'cx', 0)
      const cy = num(attrs, 'cy', 0)
      const rx = num(attrs, 'rx')
      const ry = num(attrs, 'ry', rx)
      return Number.isFinite(rx) && Number.isFinite(ry) ? ellipsePath(cx, cy, rx, ry) : undefined
    }
    case 'rect': {
      const x = num(attrs, 'x', 0)
      const y = num(attrs, 'y', 0)
      const w = num(attrs, 'width')
      const h = num(attrs, 'height')
      const rx = num(attrs, 'rx', 0)
      const ry = num(attrs, 'ry', rx)
      return [x, y, w, h, rx, ry].every(Number.isFinite) ? rectPath(x, y, w, h, rx, ry) : undefined
    }
    case 'line': {
      const v = [num(attrs, 'x1', 0), num(attrs, 'y1', 0), num(attrs, 'x2', 0), num(attrs, 'y2', 0)]
      return v.every(Number.isFinite) ? `M${f(v[0]!)} ${f(v[1]!)}L${f(v[2]!)} ${f(v[3]!)}` : undefined
    }
    case 'polyline':
    case 'polygon': {
      const p = pointsOf(attrs.points)
      if (p.length < 4 || p.length % 2 !== 0) return undefined
      const parts: string[] = []
      for (let i = 0; i < p.length; i += 2) parts.push(`${i === 0 ? 'M' : 'L'}${f(p[i]!)} ${f(p[i + 1]!)}`)
      return parts.join('') + (tag === 'polygon' ? 'Z' : '')
    }
    default:
      return undefined
  }
}

/** The SVG path data of a lucide icon, one entry per drawn shape. Unknown names throw, listing the closest names. */
export function iconPaths(name: string): IconPath[] {
  const key = resolveIconName(name)
  if (!key) throw unknownIcon(name)
  const out: IconPath[] = []
  for (const [tag, attrs] of ICONS[key]!) {
    const d = shapeToPath(tag, attrs as Record<string, string | number | undefined>)
    if (d !== undefined && VECTOR_PATH_D_RE.test(d)) out.push({ d })
  }
  return out
}

/** A vector element that draws a lucide icon in `color`, in a box of `box.size` px. Stroke only, round caps and joins. */
export function iconElement(name: string, box: IconBox, color: string, strokeWidth = 2): ElementInput {
  const paths = iconPaths(name)
  if (paths.length === 0) throw new Error(`Icon "${name}" has no drawable paths`)
  return {
    type: 'vector',
    x: box.x,
    y: box.y,
    w: box.size,
    h: box.size,
    rotation: 0,
    locked: false,
    opacity: 1,
    viewBox: { x: 0, y: 0, w: 24, h: 24 },
    paths: paths.slice(0, 200).map((p) => ({
      d: p.d,
      fill: 'transparent',
      stroke: color,
      strokeWidth,
      lineCap: 'round' as const,
      lineJoin: 'round' as const,
    })),
    preserveAspectRatio: true,
  }
}

/** Icon names in kebab-case, optionally filtered by a substring (ignoring case, dashes and spaces). */
export function listIcons(query?: string): string[] {
  const q = query ? stripName(query) : ''
  const names = KEYS.map(kebab)
  if (!q) return names
  return KEYS.filter((key) => stripName(key).includes(q)).map(kebab)
}

// WCAG contrast utilities and theme enforcement. Text against the background must reach
// 4.5:1 (AA normal text). Accent colours (used for shapes, chart series and highlights) must reach 3:1
// against the background, which is the AA rule for graphical objects.

export const TEXT_MIN_CONTRAST = 4.5
export const ACCENT_MIN_CONTRAST = 3

export interface Rgb {
  r: number
  g: number
  b: number
}

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`Not a hex colour: ${hex}`)
  let h = m[1]!
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, 1 to 21. Order does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

interface Hsl {
  h: number
  s: number
  l: number
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: h * 60, s, l }
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = l * 255
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const hn = h / 360
  return { r: hue(hn + 1 / 3) * 255, g: hue(hn) * 255, b: hue(hn - 1 / 3) * 255 }
}

/**
 * Returns a colour at least `min` contrast against `background`. The colour keeps its hue and
 * saturation and only its lightness moves, in whichever direction needs the smaller change.
 * If no shade reaches the minimum, black or white (whichever contrasts more) is returned.
 */
export function ensureContrast(color: string, background: string, min: number): string {
  if (contrastRatio(color, background) >= min) return toHex(parseHex(color))
  const start = rgbToHsl(parseHex(color))
  let best: { hex: string; delta: number } | undefined
  for (const direction of [-1, 1] as const) {
    for (let step = 1; step <= 100; step++) {
      const l = start.l + direction * step * 0.01
      if (l < 0 || l > 1) break
      const hex = toHex(hslToRgb({ ...start, l }))
      if (contrastRatio(hex, background) >= min) {
        if (!best || step * 0.01 < best.delta) best = { hex, delta: step * 0.01 }
        break
      }
    }
  }
  if (best) return best.hex
  return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? '#000000' : '#ffffff'
}

export interface ThemeColors {
  background: string
  surface: string
  text: string
  muted: string
  accent: string
  accent2: string
  accent3: string
  accent4: string
}

/** Enforces the theme rules: text and muted text 4.5:1 on the background, accents 3:1 on the background. */
export function enforceThemeContrast(colors: ThemeColors): { colors: ThemeColors; adjusted: string[] } {
  const adjusted: string[] = []
  const bg = toHex(parseHex(colors.background))
  const fix = (key: keyof ThemeColors, min: number) => {
    const before = toHex(parseHex(colors[key]))
    const after = ensureContrast(before, bg, min)
    if (after !== before) adjusted.push(`${key} ${before} → ${after}`)
    return after
  }
  const out: ThemeColors = {
    background: bg,
    surface: toHex(parseHex(colors.surface)),
    text: fix('text', TEXT_MIN_CONTRAST),
    muted: fix('muted', TEXT_MIN_CONTRAST),
    accent: fix('accent', ACCENT_MIN_CONTRAST),
    accent2: fix('accent2', ACCENT_MIN_CONTRAST),
    accent3: fix('accent3', ACCENT_MIN_CONTRAST),
    accent4: fix('accent4', ACCENT_MIN_CONTRAST),
  }
  return { colors: out, adjusted }
}

/** Pairs that break the rules, for tests and for warnings. Empty when the theme is fine. */
export function contrastViolations(colors: ThemeColors): string[] {
  const out: string[] = []
  for (const key of ['text', 'muted'] as const) {
    if (contrastRatio(colors[key], colors.background) < TEXT_MIN_CONTRAST) out.push(`${key} is below ${TEXT_MIN_CONTRAST}:1`)
  }
  for (const key of ['accent', 'accent2', 'accent3', 'accent4'] as const) {
    if (contrastRatio(colors[key], colors.background) < ACCENT_MIN_CONTRAST) out.push(`${key} is below ${ACCENT_MIN_CONTRAST}:1`)
  }
  return out
}

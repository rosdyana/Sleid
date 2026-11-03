// The deck canvas is 1920x1080 px. PowerPoint's wide layout is 13.333 x 7.5 in.
export const CANVAS_PX = { w: 1920, h: 1080 }
export const SLIDE_IN = { w: 13.333, h: 7.5 }

/** Canvas pixels to inches. 1920 px = 13.333 in. */
export function inches(px: number): number {
  return px * (SLIDE_IN.w / CANVAS_PX.w)
}

/** Canvas pixels to points. Same scale as the slide: 1 px = 0.75 pt at 96 dpi, times 13.333*96/1920. */
export function points(px: number): number {
  return px * 0.75 * ((SLIDE_IN.w * 96) / CANVAS_PX.w)
}

const NAMED: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  orange: 'FFA500',
  purple: '800080',
  gray: '808080',
  grey: '808080',
  silver: 'C0C0C0',
  navy: '000080',
  teal: '008080',
}

/** A six-digit hex colour for PowerPoint (no #), or undefined for transparent and unknown values. */
export function pptxColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (v === '' || v === 'transparent' || v === 'none') return undefined
  const hex = /^#?([0-9a-f]{6})$/.exec(v)
  if (hex) return hex[1]!.toUpperCase()
  const short = /^#?([0-9a-f]{3})$/.exec(v)
  if (short) return short[1]!.split('').map((c) => c + c).join('').toUpperCase()
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(v)
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()
  return NAMED[v]
}

/** Transparency percent for PowerPoint from an opacity in [0, 1]. */
export function transparencyFor(opacity: number): number {
  return Math.round(Math.min(Math.max(1 - opacity, 0), 1) * 100)
}

/** The first family in a CSS font stack, mapped to a name PowerPoint can use. */
export function pptxFontFace(stack: string | undefined, fallback: string): string {
  if (!stack) return fallback
  const first = stack.split(',')[0]!.trim().replace(/^["']|["']$/g, '').trim()
  if (!first) return fallback
  const generic: Record<string, string> = {
    'sans-serif': 'Arial',
    serif: 'Georgia',
    monospace: 'Consolas',
    'ui-monospace': 'Consolas',
    'ui-sans-serif': 'Arial',
    'system-ui': 'Arial',
    cursive: 'Comic Sans MS',
    fantasy: 'Impact',
  }
  return generic[first.toLowerCase()] ?? first
}

// Escaping and sanitising helpers. Every value that reaches HTML, an attribute
// or a style string goes through one of these. Browser-safe, no DOM.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Finite numbers only. Anything else becomes 0, so a NaN or Infinity can never leak into CSS.
export function num(value: unknown, fallback = 0): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : String(fallback)
}

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.%\s,]+\)|hsla?\(\s*[\d.%\s,degrem]+\)|[a-zA-Z]{3,24}|transparent)$/

export function safeColor(value: unknown, fallback = 'transparent'): string {
  return typeof value === 'string' && COLOR_RE.test(value.trim()) ? value.trim() : fallback
}

// 300 covers a full stack such as "Inter, Helvetica Neue, Arial, sans-serif" with room to spare.
const FONT_RE = /^[A-Za-z0-9 ,'"\-_.]{1,300}$/

export function safeFontFamily(value: unknown): string | undefined {
  return typeof value === 'string' && FONT_RE.test(value.trim()) ? value.trim() : undefined
}

// A theme font may be a single family or a full stack. Either way a generic fallback is appended.
export function fontStack(family: string, generic: string): string {
  const safe = safeFontFamily(family)
  if (!safe) return generic
  return /(serif|sans-serif|monospace|cursive|fantasy|system-ui)\s*$/.test(safe) ? safe : `${safe}, ${generic}`
}

// Accepts a number (px) or a string such as "24px", "1.5rem", "80%".
export function safeLength(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`
  if (typeof value === 'string' && /^\d+(\.\d+)?(px|pt|em|rem|%)?$/.test(value.trim())) return value.trim()
  return undefined
}

// Signed lengths for letter-spacing: a number (px) or "-0.02em", "1px". Negative values are allowed. No percentages.
export function safeSignedLength(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`
  if (typeof value === 'string' && /^-?\d+(\.\d+)?(px|em)?$/.test(value.trim())) return value.trim()
  return undefined
}

// Only http(s) and mailto links. Anything else (javascript:, data:, relative) is dropped.
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.trim())
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

// Images: http(s), inline raster data URLs, or root-relative paths.
/** A relative path to an exported asset, e.g. `assets/0f3c…png`. Only the export bundle uses these. */
const BUNDLE_ASSET_RE = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/

export function safeBundleAssetPath(value: unknown): string | undefined {
  return typeof value === 'string' && BUNDLE_ASSET_RE.test(value.trim()) ? value.trim() : undefined
}

export function safeImageSrc(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (v === '') return undefined
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return v
  if (v.startsWith('/') && !v.startsWith('//')) return v
  if (safeBundleAssetPath(v)) return v
  const href = safeHref(v)
  return href && href.startsWith('http') ? href : undefined
}

// Embeds: http(s) only.
export function safeEmbedUrl(value: unknown): string | undefined {
  const href = safeHref(value)
  return href && href.startsWith('http') ? href : undefined
}

// M10. CSS box-shadow / drop-shadow values from a model shadow. Every number is finite and the colour is checked.
// `withSpread` is for box-shadow only. text-shadow and drop-shadow() have no spread argument.
export function shadowList(
  shadow: { x: number; y: number; blur: number; spread?: number | undefined; color: string },
  withSpread = true,
): string {
  const spread = withSpread ? ` ${num(shadow.spread ?? 0)}px` : ''
  return `${num(shadow.x)}px ${num(shadow.y)}px ${num(shadow.blur)}px${spread} ${safeColor(shadow.color, 'transparent')}`
}

const GRADIENT_RE = /^(linear|radial|conic)-gradient\([#\w\s%(),.\-]+\)$/

// CSS gradients only. Rejects url(), semicolons, braces and quotes.
export function safeGradient(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!GRADIENT_RE.test(v) || /url\s*\(/i.test(v)) return undefined
  return v
}

// Background image URL for CSS url("..."). Only http(s).
export function safeCssUrl(value: unknown): string | undefined {
  const bundle = safeBundleAssetPath(value)
  if (bundle) return `url("${bundle}")`
  const href = safeHref(value)
  return href && href.startsWith('http') ? `url("${href}")` : undefined
}

const TOKEN_RE = /^[A-Za-z0-9_+#.-]{1,32}$/

export function safeToken(value: unknown): string {
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : ''
}

const CLASS_RE = /^[a-z][a-z0-9-]{0,40}$/

// For enum-like values placed in class names (layouts, effects). Falls back to empty.
export function safeClass(value: unknown): string {
  return typeof value === 'string' && CLASS_RE.test(value) ? value : ''
}

// Throws if inline text would close the enclosing <style> or <script> element.
export function assertInlineSafe(text: string, tag: 'style' | 'script', source: string): string {
  const re = new RegExp(`</${tag}`, 'i')
  if (re.test(text)) throw new Error(`${source} contains a closing </${tag}> sequence and cannot be inlined`)
  return text
}

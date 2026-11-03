// M10. TipTap attributes for the textStyle mark: font size, family, weight and letter spacing. TipTap's TextStyle
// mark keeps only the attributes an extension declares, so without these a text box loses its marks when it is
// edited. Kept free of TipTap and React imports, so the parse and render rules can be unit-tested without a DOM.
// TextEditor.tsx wires these into a global attribute extension.

type Style = { style: string }

function nonEmpty(raw: string | undefined): string | null {
  const v = (raw ?? '').trim()
  return v === '' ? null : v
}

/** A 100-900 weight (as a number, so the renderer accepts it) or the keywords 'bold' and 'normal'. Anything else is dropped. */
export function parseWeight(raw: string | undefined): number | 'bold' | 'normal' | null {
  const v = (raw ?? '').trim()
  if (v === 'bold' || v === 'normal') return v
  if (!/^\d{3}$/.test(v)) return null
  const n = Number(v)
  return n >= 100 && n <= 900 ? n : null
}

function styleOf(prop: string, value: unknown): Style | Record<string, never> {
  if (value === null || value === undefined || value === '') return {}
  return { style: `${prop}: ${String(value)}` }
}

interface AttrSpec {
  default: null
  parseHTML: (element: HTMLElement) => unknown
  renderHTML: (attrs: Record<string, unknown>) => Style | Record<string, never>
}

export const TEXT_STYLE_ATTRS: Record<'fontSize' | 'fontFamily' | 'fontWeight' | 'letterSpacing', AttrSpec> = {
  fontSize: {
    default: null,
    parseHTML: (el) => nonEmpty(el.style.fontSize),
    renderHTML: (a) => styleOf('font-size', a.fontSize),
  },
  fontFamily: {
    default: null,
    parseHTML: (el) => nonEmpty(el.style.fontFamily),
    renderHTML: (a) => styleOf('font-family', a.fontFamily),
  },
  fontWeight: {
    default: null,
    parseHTML: (el) => parseWeight(el.style.fontWeight),
    renderHTML: (a) => styleOf('font-weight', a.fontWeight),
  },
  letterSpacing: {
    default: null,
    parseHTML: (el) => nonEmpty(el.style.letterSpacing),
    renderHTML: (a) => styleOf('letter-spacing', a.letterSpacing),
  },
}

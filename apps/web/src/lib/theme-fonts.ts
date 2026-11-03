// M10. Web fonts for the editor and the in-app present view. The renderer builds the Google Fonts URL (googleFontsHref);
// this file keeps one <link data-sleid-fonts> in document.head while a deck is shown, and parses the Theme panel's list.
import { useEffect } from 'react'
import { FONT_IMPORT_RE, type Theme } from '@sleid/model'
import { googleFontsHref } from '@sleid/render'

export const FONTS_LINK_ATTR = 'data-sleid-fonts'
/** The theme schema allows six families. Anything beyond that is dropped here, so the save is not refused. */
export const MAX_FONT_IMPORTS = 6

/**
 * Splits the Theme panel's comma-separated list into Google Fonts family values. A comma also separates an axis list
 * (`Roboto:ital,wght@0,400`), so a piece that does not start with a family name joins the family before it.
 * Each value is checked with FONT_IMPORT_RE. Duplicates are removed. Invalid values and any beyond the limit are returned as `dropped`.
 */
export function parseFontImports(text: string): { kept: string[]; dropped: string[] } {
  const pieces = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const entries: string[] = []
  for (const piece of pieces) {
    const startsFamily = /^[A-Za-z][A-Za-z0-9 ]*(:|$)/.test(piece)
    if (startsFamily || entries.length === 0) entries.push(piece)
    else entries[entries.length - 1] += `,${piece}`
  }
  const kept: string[] = []
  const dropped: string[] = []
  for (const entry of entries) {
    if (kept.includes(entry)) continue
    if (!FONT_IMPORT_RE.test(entry) || kept.length >= MAX_FONT_IMPORTS) {
      dropped.push(entry)
      continue
    }
    kept.push(entry)
  }
  return { kept, dropped }
}

/**
 * Keeps one stylesheet link for the theme's web fonts. It is updated in place when the theme changes, so text does not
 * flash, and removed when the component unmounts.
 */
export function useGoogleFontsLink(theme: Theme): void {
  const href = googleFontsHref(theme) ?? null
  useEffect(() => {
    const existing = document.head.querySelector<HTMLLinkElement>(`link[${FONTS_LINK_ATTR}]`)
    if (!href) {
      existing?.remove()
      return
    }
    const link = existing ?? document.createElement('link')
    if (!existing) {
      link.rel = 'stylesheet'
      link.setAttribute(FONTS_LINK_ATTR, '')
      document.head.appendChild(link)
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href)
  }, [href])
  useEffect(
    () => () => {
      document.head.querySelector(`link[${FONTS_LINK_ATTR}]`)?.remove()
    },
    [],
  )
}

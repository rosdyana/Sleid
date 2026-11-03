// Mermaid's configuration for a deck's theme (M9). Diagrams use the base theme with the deck's colours and body font,
// so they sit on dark themes too (the default theme draws white boxes with black text). Used by the render package
// (the HTML and PDF pages), the worker's diagram images, and the editor's diagram view.
import type { Theme } from './schema.ts'
import { readableTextOn } from './contrast.ts'

export function mermaidConfigFor(theme: Theme): Record<string, unknown> {
  const c = theme.colors
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      fontFamily: theme.fonts.body,
      background: c.background,
      primaryColor: c.accent,
      primaryBorderColor: c.accent,
      primaryTextColor: readableTextOn(c.accent, c.text),
      secondaryColor: c.accent2,
      secondaryBorderColor: c.accent2,
      secondaryTextColor: readableTextOn(c.accent2, c.text),
      tertiaryColor: c.surface,
      tertiaryBorderColor: c.muted,
      tertiaryTextColor: c.text,
      mainBkg: c.surface,
      nodeBorder: c.accent,
      nodeTextColor: c.text,
      lineColor: c.muted,
      textColor: c.text,
      titleColor: c.text,
      clusterBkg: c.surface,
      clusterBorder: c.muted,
      edgeLabelBackground: c.background,
    },
  }
}

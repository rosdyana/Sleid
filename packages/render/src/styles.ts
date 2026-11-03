// Theme tokens as CSS variables, and the base stylesheet for slide elements.
import type { Theme } from '@sleid/model'
import { fontStack, safeColor, num } from './html.ts'

export function themeCssVariables(theme: Theme): string {
  const c = theme.colors
  const f = theme.fonts
  const s = theme.sizes
  const vars: Record<string, string> = {
    '--sleid-background': safeColor(c.background, '#ffffff'),
    '--sleid-surface': safeColor(c.surface, '#f8f9fa'),
    '--sleid-text': safeColor(c.text, '#202124'),
    '--sleid-muted': safeColor(c.muted, '#5f6368'),
    '--sleid-accent': safeColor(c.accent, '#0b57d0'),
    '--sleid-accent2': safeColor(c.accent2, '#188038'),
    '--sleid-accent3': safeColor(c.accent3, '#e37400'),
    '--sleid-accent4': safeColor(c.accent4, '#a142f4'),
    '--sleid-font-heading': fontStack(f.heading, 'sans-serif'),
    '--sleid-font-body': fontStack(f.body, 'sans-serif'),
    '--sleid-font-mono': fontStack(f.mono, 'monospace'),
    '--sleid-size-title': `${num(s.title, 120)}px`,
    '--sleid-size-heading': `${num(s.heading, 72)}px`,
    '--sleid-size-body': `${num(s.body, 40)}px`,
    '--sleid-size-small': `${num(s.small, 28)}px`,
    '--sleid-radius': `${num(theme.radius, 0)}px`,
  }
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  return `:root {\n${body}\n}`
}

// Base styles for the slide canvas. Applied to both the editor preview and the
// exported HTML. Reveal's own CSS handles the scaling and fragments.
export const BASE_CSS = `
.reveal .slides section.sleid-slide {
  width: 1920px;
  height: 1080px;
  padding: 0;
  text-align: left;
  color: var(--sleid-text);
  font-family: var(--sleid-font-body);
  box-sizing: border-box;
}
.sleid-stage { position: absolute; inset: 0; overflow: hidden; }
.sleid-el { position: absolute; box-sizing: border-box; }
.sleid-body { position: relative; width: 100%; height: 100%; transform-origin: center center; }
.sleid-text { display: flex; flex-direction: column; width: 100%; height: 100%; overflow-wrap: anywhere; color: var(--sleid-text); font-size: var(--sleid-size-body); }
.sleid-text p { margin: 0 0 0.4em; }
.sleid-text ul, .sleid-text ol { margin: 0 0 0.4em; padding-left: 1.2em; }
.sleid-text ul { list-style: disc outside; }
.sleid-text ol { list-style: decimal outside; }
.sleid-text ul ul { list-style-type: circle; }
.sleid-text h1, .sleid-text h2, .sleid-text h3, .sleid-text h4, .sleid-text h5, .sleid-text h6 { margin: 0 0 0.3em; font-family: var(--sleid-font-heading); line-height: 1.15; }
.sleid-text[data-role="title"] { font-family: var(--sleid-font-heading); }
.sleid-shape .sleid-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.sleid-shape-text { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 0.5em; text-align: center; color: var(--sleid-text); }
.sleid-image { position: relative; width: 100%; height: 100%; overflow: hidden; }
.sleid-image img { position: absolute; display: block; width: 100%; height: 100%; }
.sleid-image-empty { background: var(--sleid-surface); border: 2px dashed var(--sleid-muted); }
.sleid-chart, .sleid-chart svg { width: 100%; height: 100%; display: block; }
.sleid-diagram { margin: 0; width: 100%; height: 100%; overflow: hidden; color: var(--sleid-text); display: flex; align-items: center; justify-content: center; background: none; box-shadow: none; }
/* Mermaid emits a fixed max-width; scale the SVG to fit its box like the editor does. */
.sleid-diagram > svg { width: 100% !important; height: 100% !important; max-width: none !important; }
/* Shown in place of a diagram that Mermaid could not draw. Muted, and never the diagram's source. */
.sleid-diagram-error { box-sizing: border-box; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; border: 3px dashed var(--sleid-muted); border-radius: 12px; color: var(--sleid-muted); font-family: var(--sleid-font-body); font-size: 32px; text-align: center; }
.sleid-table { width: 100%; height: 100%; border-collapse: collapse; color: var(--sleid-text); font-size: var(--sleid-size-small); }
.sleid-table th, .sleid-table td { border: 1px solid var(--sleid-border, var(--sleid-muted)); padding: 0.3em 0.5em; text-align: left; vertical-align: top; }
.sleid-table th { background: var(--sleid-surface); font-weight: 600; }
.sleid-code { margin: 0; width: 100%; height: 100%; overflow: hidden; box-sizing: border-box; padding: 24px; background: var(--sleid-surface); color: var(--sleid-text); font-family: var(--sleid-font-mono); font-size: var(--sleid-size-small); border-radius: var(--sleid-radius); white-space: pre; }
.sleid-embed { width: 100%; height: 100%; border: 0; display: block; }
.sleid-embed-blocked { display: flex; align-items: center; justify-content: center; background: var(--sleid-surface); color: var(--sleid-muted); font-size: var(--sleid-size-small); }
/* M10. Rect, rounded rect and ellipse fill the element box. The styles come inline (gradient, border, radius, shadow). */
.sleid-shape-box { position: absolute; inset: 0; box-sizing: border-box; }
.sleid-vector { display: block; width: 100%; height: 100%; overflow: visible; }
/* M10. Wipe: the element is shown and clipped to nothing, then the clip opens from left to right. Reveal's
   .reveal .fragment:not(.custom) (opacity 0, specificity 0,3,0) and .reveal .fragment.visible are beaten by these
   selectors (0,4,0 and 0,5,0). Reveal's !important fragment rule is print-only, and print renders no fragments. */
.reveal .slides .fragment.sleid-wipe { opacity: 1; visibility: inherit; clip-path: inset(0 100% 0 0); transition: clip-path 0.8s ease; }
.reveal .slides .fragment.sleid-wipe.visible { clip-path: inset(0 0 0 0); }
`

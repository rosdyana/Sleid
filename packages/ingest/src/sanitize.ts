// Reduces untrusted content to plain text. Scripts, styles, frames and tags never reach a prompt.
import { Window } from 'happy-dom'
import { Readability } from '@mozilla/readability'

const DROP_TAGS = ['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template', 'svg', 'head']

/** Removes control characters (keeps tabs and newlines) and collapses runs of blank space. */
export function cleanText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** For plain text and markdown: drops script and style blocks and any markup, so nothing HTML-like reaches a prompt. */
export function stripMarkup(input: string): string {
  const noBlocks = input.replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1\s*>/gi, ' ')
  return cleanText(noBlocks.replace(/<\/?[a-zA-Z][^>]*>/g, ' '))
}

/** Main text of an HTML page (Readability on a DOM with active content removed). Scripts never run. */
export function htmlToText(html: string, fallbackTitle: string): { title: string; text: string } {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableComputedStyleRendering: true,
    },
  })
  try {
    const doc = new window.DOMParser().parseFromString(html, 'text/html') as unknown as Document
    const title = doc.querySelector('title')?.textContent?.trim() || fallbackTitle
    for (const tag of DROP_TAGS) for (const el of Array.from(doc.querySelectorAll(tag))) el.remove()
    const article = new Readability(doc).parse()
    const body = article?.content ?? doc.body?.innerHTML ?? ''
    // Block boundaries become line breaks, so paragraphs do not run together.
    const withBreaks = body.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>|<br\s*\/?>/gi, '\n\n')
    const plain = withBreaks.replace(/<[^>]*>/g, ' ')
    const decoded = plain.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    return { title: article?.title?.trim() || title, text: cleanText(decoded) }
  } finally {
    window.close()
  }
}

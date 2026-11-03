// The file formats the Import dialog accepts. The format comes from the file name for the first check only; the
// server checks the content (magic bytes, UTF-8, JSON) and never trusts the name.
export type UploadFormat = 'pptx' | 'markdown' | 'json'

export const IMPORT_ACCEPT = '.pptx,.md,.markdown,.json'
export const IMPORT_HINT = 'PowerPoint (.pptx), Markdown (.md, .markdown) or JSON (.json)'

/** The format a file name suggests. Null for anything else. */
export function formatForFileName(name: string): UploadFormat | null {
  const lower = name.trim().toLowerCase()
  if (lower.endsWith('.pptx')) return 'pptx'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.json')) return 'json'
  return null
}

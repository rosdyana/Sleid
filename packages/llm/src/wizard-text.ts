// Visible-text rules for the wizard. Internal labels (S1, [S1]), citations ([1]) and ids never reach a title or a
// bullet: they belong in the speaker notes. The words an estimate or a placeholder carry are in the deck's language.

const LABEL = /\[?\bS\d{1,3}\b\]?/g
const CITATION = /\[\d{1,3}\]/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const LEFTOVER_SEPARATOR = /^[\s:\-–—•|]+/

/**
 * Removes internal labels from visible text: reference labels (S1, [S1]), citation numbers ([1]) and ids. A
 * label left at the start ("S1: data bulanan") takes its separator with it. Text with none of these is unchanged.
 */
export function stripSourceLabels(text: string): string {
  const withoutLabels = text.replace(UUID, '').replace(LABEL, '').replace(CITATION, '')
  if (withoutLabels === text) return text
  return withoutLabels
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(LEFTOVER_SEPARATOR, '')
    .trim()
}

/** The word an estimated figure carries, in the deck's language. Indonesian gets "perkiraan"; everything else "estimate". */
export function estimateWord(language: string): string {
  return language.toLowerCase().startsWith('id') ? 'perkiraan' : 'estimate'
}

/** The visible note on a slide the model could not write, in the deck's language. */
export function placeholderNote(language: string): string {
  return language.toLowerCase().startsWith('id')
    ? 'Tidak dapat dibuat — klik ✨ Ask AI untuk mencoba lagi.'
    : 'Could not be generated — click ✨ Ask AI to retry.'
}

/** The speaker-notes line that names the figures marked as estimates on a slide. */
export function estimateNote(language: string, figures: string[]): string {
  const list = figures.join(', ')
  return language.toLowerCase().startsWith('id')
    ? `Periksa sebelum presentasi: angka berikut tidak ada di sumber dan ditandai sebagai perkiraan: ${list}.`
    : `Check before you present: these figures are not in the references and are marked as estimates: ${list}.`
}

// Compares a saved version with the current deck, for the preview panel. Pure.
// Slides are matched by id. A slide is "changed" when its content differs, ignoring nothing:
// key order is normalised first, so two equal slides always compare equal.
import type { Deck } from './schema.ts'

export interface VersionDiff {
  /** Slides in the version that are not in the current deck. */
  onlyInVersion: number
  /** Slides in the current deck that are not in the version. */
  onlyInCurrent: number
  /** Slides with the same id whose content differs. */
  changed: number
  /** Slides with the same id and the same content. */
  unchanged: number
  titleChanged: boolean
}

/** JSON with object keys sorted at every level, so equal values give equal strings. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function compareDecks(current: Deck, version: Deck): VersionDiff {
  const currentById = new Map(current.slides.map((s) => [s.id, s]))
  const versionIds = new Set(version.slides.map((s) => s.id))
  let changed = 0
  let unchanged = 0
  for (const slide of version.slides) {
    const now = currentById.get(slide.id)
    if (!now) continue
    if (stableStringify(now) === stableStringify(slide)) unchanged++
    else changed++
  }
  return {
    onlyInVersion: version.slides.filter((s) => !currentById.has(s.id)).length,
    onlyInCurrent: current.slides.filter((s) => !versionIds.has(s.id)).length,
    changed,
    unchanged,
    titleChanged: current.title !== version.title,
  }
}

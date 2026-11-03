// Pure helpers for the History tab: grouping automatic versions by day. No server imports, so the tests can run them.
import type { VersionEntry } from '@sleid/db'

type Version = VersionEntry

export function groupByDay(versions: Version[], now: Date = new Date()): Array<{ label: string; items: Version[] }> {
  const groups: Array<{ label: string; items: Version[] }> = []
  const today = startOfDay(now)
  for (const v of versions) {
    const day = startOfDay(new Date(v.createdAt))
    const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000)
    const label = diffDays === 0 ? 'Today' : diffDays === 1 ? 'Yesterday' : day.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
    const last = groups.at(-1)
    if (last && last.label === label) last.items.push(v)
    else groups.push({ label, items: [v] })
  }
  return groups
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

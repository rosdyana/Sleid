// Pure role logic. No database or request access here, so it can be unit-tested directly.

export const DECK_ROLES = ['owner', 'editor', 'commenter', 'viewer'] as const
export type DeckRole = (typeof DECK_ROLES)[number]

/** Higher number = more power. */
const RANK: Record<DeckRole, number> = { owner: 4, editor: 3, commenter: 2, viewer: 1 }

/** True when `actual` is at least as powerful as `minRole`. */
export function roleAtLeast(actual: DeckRole, minRole: DeckRole): boolean {
  return RANK[actual] >= RANK[minRole]
}

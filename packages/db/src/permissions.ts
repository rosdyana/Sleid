// Role ordering and the rules that depend on it. Pure functions, so the same rules
// are used by server functions, the collab auth hook and the UI.
export const DECK_ROLES = ['owner', 'editor', 'commenter', 'viewer'] as const
export type DeckRole = (typeof DECK_ROLES)[number]

/** Roles a share link or invite can grant. Owner is never granted this way. */
export const SHARE_ROLES = ['editor', 'commenter', 'viewer'] as const
export type ShareRole = (typeof SHARE_ROLES)[number]

/** Higher number = more power. */
const RANK: Record<DeckRole, number> = { owner: 4, editor: 3, commenter: 2, viewer: 1 }

/** True when `actual` is at least as powerful as `minRole`. */
export function roleAtLeast(actual: DeckRole, minRole: DeckRole): boolean {
  return RANK[actual] >= RANK[minRole]
}

/** The stronger of two roles. Used so a grant never downgrades an existing role. */
export function higherRole(a: DeckRole, b: DeckRole): DeckRole {
  return RANK[a] >= RANK[b] ? a : b
}

/** Editors and owners change the document. Commenters and viewers get read-only editors. */
export function canEdit(role: DeckRole): boolean {
  return roleAtLeast(role, 'editor')
}

/** Commenters and viewers open a read-only editor. Commenters can still comment. */
export function isReadOnlyRole(role: DeckRole): boolean {
  return !canEdit(role)
}

/** Commenters, editors and owners can start threads and reply. Viewers read comments only. */
export function canComment(role: DeckRole): boolean {
  return roleAtLeast(role, 'commenter')
}

/** Editors and owners resolve or reopen any thread. Authors edit and delete their own comments, whatever their role. */
export function canResolveComments(role: DeckRole): boolean {
  return roleAtLeast(role, 'editor')
}

/** Editors and owners can invite people. */
export function canInvite(role: DeckRole): boolean {
  return roleAtLeast(role, 'editor')
}

/** Only the owner changes people's roles, removes people, and changes general access. */
export function canManagePeople(role: DeckRole): boolean {
  return role === 'owner'
}

/** An actor may grant `target` to someone else only if they can invite at all. Ownership is never granted. */
export function canGrant(actor: DeckRole, target: ShareRole): boolean {
  return canInvite(actor) && (SHARE_ROLES as readonly string[]).includes(target)
}

/** Role after a grant: the stronger of what they have and what is granted. */
export function roleAfterGrant(current: DeckRole | null, granted: ShareRole): DeckRole {
  return current ? higherRole(current, granted) : granted
}

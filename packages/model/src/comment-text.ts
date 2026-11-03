// Comment text: a small markdown subset plus @mentions. Pure, so the same rules run in the
// browser (rendering and the mention picker), on the server (mention ids are read from the body,
// never trusted from the client) and in MCP output. Nothing here produces HTML: the renderer maps
// these nodes to React text.
//
// Subset: **bold**, *italic*, `code`, line breaks, and mentions written as @[Name](userId).
// Nested marks are not supported; a marker that does not close on the same line stays literal.

export const COMMENT_MAX_LENGTH = 5000

const MENTION_SOURCE = String.raw`@\[([^\[\]\n]{1,100})\]\(([A-Za-z0-9_-]{1,100})\)`
const INLINE_SOURCE = `${MENTION_SOURCE}|\\*\\*([^*\\n]+)\\*\\*|\\*([^*\\n]+)\\*|\`([^\`\\n]+)\``

export type CommentInline =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; name: string; userId: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }

/** The markup the mention picker inserts for a member. The name is cleaned so it cannot end the markup early. */
export function mentionMarkup(name: string, userId: string): string {
  const safe = name.replace(/[[\]()\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'member'
  return `@[${safe}](${userId})`
}

/** Distinct user ids mentioned in a body, in first-seen order. */
export function extractMentionIds(body: string): string[] {
  const ids = new Set<string>()
  for (const match of body.matchAll(new RegExp(MENTION_SOURCE, 'g'))) ids.add(match[2]!)
  return [...ids]
}

/** Lines of inline nodes. A body with no line breaks is one line. */
export function parseCommentBody(body: string): CommentInline[][] {
  return body.replace(/\r\n?/g, '\n').split('\n').map(parseLine)
}

function parseLine(line: string): CommentInline[] {
  const out: CommentInline[] = []
  let last = 0
  for (const m of line.matchAll(new RegExp(INLINE_SOURCE, 'g'))) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'text', text: line.slice(last, at) })
    if (m[1] !== undefined) out.push({ kind: 'mention', name: m[1], userId: m[2]! })
    else if (m[3] !== undefined) out.push({ kind: 'strong', text: m[3] })
    else if (m[4] !== undefined) out.push({ kind: 'em', text: m[4] })
    else if (m[5] !== undefined) out.push({ kind: 'code', text: m[5] })
    last = at + m[0].length
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) })
  return out
}

/** Plain text for lists, notifications and agents: mentions become @Name, markers are removed. */
export function commentPlainText(body: string): string {
  return body
    .replace(new RegExp(MENTION_SOURCE, 'g'), '@$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
}

/** Trims and checks a comment body. Throws with a message a person can act on. */
export function validateCommentBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('A comment cannot be empty.')
  if (trimmed.length > COMMENT_MAX_LENGTH) throw new Error(`A comment can be at most ${COMMENT_MAX_LENGTH} characters.`)
  return trimmed
}

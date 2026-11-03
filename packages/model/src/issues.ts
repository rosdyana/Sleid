// Short, user-facing summary of zod issues. Used where a parsed input is refused.

export interface IssueLike {
  path: ReadonlyArray<PropertyKey>
  message: string
}

/** Up to `max` issues as `path: message`, with a count of the rest. */
export function summariseIssues(issues: ReadonlyArray<IssueLike>, max = 3): string {
  const shown = issues.slice(0, max).map((issue) => {
    const path = issue.path.map((p) => String(p)).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  const rest = issues.length - shown.length
  return rest > 0 ? `${shown.join('; ')} (and ${rest} more)` : shown.join('; ')
}

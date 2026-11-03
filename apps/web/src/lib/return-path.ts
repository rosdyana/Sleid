/** A same-origin path to return to after sign-in, or undefined. Rejects absolute and protocol-relative URLs. */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined
  return value
}

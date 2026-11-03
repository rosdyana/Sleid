// JSON repair for model replies. Local models often wrap JSON in prose or code fences,
// leave trailing commas, or truncate the closing brace. parseJsonCandidates returns the
// strings to try, from the most literal to the most repaired.

/** Removes a leading ```json fence and a trailing ``` fence, if present. */
export function stripFences(text: string): string {
  const trimmed = text.trim()
  const match = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed)
  return match ? match[1]!.trim() : trimmed
}

/** Removes commas that directly precede a closing brace or bracket, outside strings. */
export function removeTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

/** The first balanced {...} object in the text, honouring strings. Undefined when there is none. */
export function extractFirstObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Candidate JSON strings for a model reply, in the order to try them. Duplicates are removed. */
export function parseJsonCandidates(text: string): string[] {
  const stripped = stripFences(text)
  const extracted = extractFirstObject(stripped)
  const raw = [stripped, extracted, text]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .flatMap((c) => [c, removeTrailingCommas(c)])
  return [...new Set(raw)]
}

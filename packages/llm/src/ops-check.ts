// Checks for model-proposed deck-ops. Three rules, applied in order:
//   1. Every op must be in the ability's allowlist (for example rewriteText may only update elements).
//   2. Every op must pass the model package's zod schemas (parseOps).
//   3. The whole batch must apply cleanly to the current deck (target ids exist, no duplicates).
// Step 3 runs applyOps on a throwaway copy of the deck, so it is exactly the check the editor runs.
import { applyOps, deckToYDoc, OpError, parseOps, type Deck, type Op, type OpName } from '@sleid/model'
import { LlmError } from './errors.ts'

export type AllowedOps = ReadonlySet<OpName>

export function allowlist(...names: OpName[]): AllowedOps {
  return new Set(names)
}

/** Throws LlmError('invalid-output') for the first op that is not allowed. */
export function assertAllowed(ops: readonly Op[], allowed: AllowedOps, ability: string): void {
  for (const op of ops) {
    if (!allowed.has(op.op)) {
      throw new LlmError('invalid-output', `The model proposed a "${op.op}" change, which ${ability} is not allowed to make.`, {
        issues: [`${op.op} is not allowed for ${ability}`],
      })
    }
  }
}

/**
 * Parses raw ops (ids are filled in here, so the returned ops are what gets previewed and applied),
 * then checks the allowlist and the batch against the deck. Throws LlmError on any failure.
 */
export function checkOps(deck: Deck, rawOps: readonly unknown[], allowed: AllowedOps, ability: string): Op[] {
  let parsed: Op[]
  try {
    parsed = parseOps(rawOps)
  } catch (err) {
    const reason = err instanceof OpError ? err.reason : err instanceof Error ? err.message : String(err)
    throw new LlmError('invalid-output', `A proposed change is not valid: ${reason}`, { issues: [reason] })
  }
  assertAllowed(parsed, allowed, ability)
  if (parsed.length === 0) return parsed
  const doc = deckToYDoc(deck)
  try {
    applyOps(doc, parsed)
  } catch (err) {
    const reason = err instanceof OpError ? `${err.opName} #${err.opIndex}: ${err.reason}` : err instanceof Error ? err.message : String(err)
    throw new LlmError('invalid-output', `A proposed change does not fit this deck: ${reason}`, { issues: [reason] })
  } finally {
    doc.destroy()
  }
  return parsed
}

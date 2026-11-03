// Deep-partial patch semantics, shared by the plain-object path (validation)
// and the Yjs path (writes). Both must agree, or validation would approve a
// different deck from the one that gets written.
//
// Rules:
//   - a plain object in the patch merges into the existing object, key by key
//   - an array or primitive in the patch replaces the existing value
//   - null deletes the key (use it to clear optional fields)
//   - undefined is ignored
//   - "opaque" top-level keys (rich text, raw ECharts options, chart data) are
//     replaced whole, never merged, and are stored as JSON, not as Y.Map
import * as Y from 'yjs'

export type PlainObject = Record<string, unknown>

const NO_KEYS: ReadonlySet<string> = new Set()

export function isPlainObject(v: unknown): v is PlainObject {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// Copies values so the Yjs doc never shares references with caller objects.
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

export function mergePatch(base: PlainObject, patch: PlainObject, opaque: ReadonlySet<string> = NO_KEYS): PlainObject {
  const out: PlainObject = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) {
      delete out[key]
    } else if (isPlainObject(value) && !opaque.has(key)) {
      const current = isPlainObject(out[key]) && !opaque.has(key) ? (out[key] as PlainObject) : {}
      out[key] = mergePatch(current, value)
    } else {
      out[key] = clone(value)
    }
  }
  return out
}

export function writeFields(target: Y.Map<unknown>, patch: PlainObject, opaque: ReadonlySet<string> = NO_KEYS): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) {
      target.delete(key)
    } else if (isPlainObject(value) && !opaque.has(key)) {
      let child = target.get(key)
      if (!(child instanceof Y.Map)) {
        child = new Y.Map<unknown>()
        target.set(key, child)
      }
      writeFields(child as Y.Map<unknown>, value)
    } else {
      target.set(key, clone(value))
    }
  }
}

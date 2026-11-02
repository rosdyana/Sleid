import { describe, expect, it } from 'vitest'
import { safeReturnPath } from './return-path.ts'

describe('safeReturnPath', () => {
  it('keeps same-origin paths with their query', () => {
    expect(safeReturnPath('/d/6f1f2c1e-8a64-4a7b-9d55-0e7d3c2b1a10?share=abc')).toBe('/d/6f1f2c1e-8a64-4a7b-9d55-0e7d3c2b1a10?share=abc')
    expect(safeReturnPath('/')).toBe('/')
  })

  it('rejects absolute, protocol-relative and backslash URLs', () => {
    for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)', 'relative/path']) {
      expect(safeReturnPath(bad)).toBeUndefined()
    }
  })

  it('rejects non-strings and very long values', () => {
    expect(safeReturnPath(undefined)).toBeUndefined()
    expect(safeReturnPath(42)).toBeUndefined()
    expect(safeReturnPath('/' + 'a'.repeat(2048))).toBeUndefined()
  })
})

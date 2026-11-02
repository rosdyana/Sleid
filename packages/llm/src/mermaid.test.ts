import { describe, expect, it } from 'vitest'
import { cleanMermaid, validateMermaid } from './mermaid.ts'

describe('validateMermaid', () => {
  it.each([
    'graph TD; A-->B',
    'flowchart LR\n  A --> B',
    'sequenceDiagram\n  Alice->>Bob: hi',
    'classDiagram\n  class Animal',
    'stateDiagram-v2\n  [*] --> Still',
    'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
    'gantt\n  title Plan',
    'pie title Pets\n  "Dogs" : 3',
    'mindmap\n  root((Sleid))',
    'timeline\n  2024 : Launch',
    'journey\n  title Day',
    'quadrantChart\n  title Reach',
  ])('accepts %j', (source) => {
    expect(validateMermaid(source).ok).toBe(true)
  })

  it('skips comment and init lines before the keyword', () => {
    expect(validateMermaid('%% a comment\n%%{init: {"theme":"dark"}}%%\ngraph LR; A-->B').ok).toBe(true)
  })

  it('accepts a fenced block', () => {
    expect(validateMermaid('```mermaid\ngraph TD; A-->B\n```').ok).toBe(true)
  })

  it('rejects an unknown first keyword, an empty source and script content', () => {
    expect(validateMermaid('hello world').ok).toBe(false)
    expect(validateMermaid('   ').ok).toBe(false)
    expect(validateMermaid('graph TD; A-->B; click A "javascript:alert(1)"').ok).toBe(false)
    expect(validateMermaid('graph TD\n<script>x</script>').ok).toBe(false)
    expect(validateMermaid('x'.repeat(7000)).ok).toBe(false)
  })

  it('strips a fence when cleaning', () => {
    expect(cleanMermaid('```\ngraph TD; A-->B\n```')).toBe('graph TD; A-->B')
  })
})

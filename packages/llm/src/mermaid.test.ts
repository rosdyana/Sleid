import { describe, expect, it } from 'vitest'
import { cleanMermaid, validateMermaid } from './mermaid.ts'

// The sample the model wrote in the live run: "Shop appliances" is a bare node name, which Mermaid cannot parse.
const LIVE_RUN_SAMPLE = 'flowchart LR\n  Sunlight --> Panels --> Inverter --> Shop appliances\n  Inverter -->|surplus| Battery'

describe('validateMermaid', () => {
  it.each([
    'graph TD; A-->B',
    'flowchart LR\n  A --> B',
    'flowchart LR\n  A[Sun panels] -->|surplus| B(Battery)\n  B --> C{Use?}',
    'sequenceDiagram\n  Alice->>Bob: hi',
    'classDiagram\n  class Animal',
    'stateDiagram-v2\n  [*] --> Still',
    'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
    'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  Build :a1, 2024-01-01, 3d',
    'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2',
    'mindmap\n  root((Sleid))\n    Slides',
    'timeline\n  2024 : Launch',
    'journey\n  title Day\n  section Morning\n    Coffee: 5: Me',
    'quadrantChart\n  title Reach\n  x-axis Low --> High\n  y-axis Low --> High\n  Campaign A: [0.3, 0.6]',
  ])('accepts %j', async (source) => {
    expect(await validateMermaid(source)).toEqual({ ok: true })
  })

  it('skips comment and init lines before the keyword', async () => {
    expect((await validateMermaid('%% a comment\n%%{init: {"theme":"dark"}}%%\ngraph LR; A-->B')).ok).toBe(true)
  })

  it('accepts a fenced block', async () => {
    expect((await validateMermaid('```mermaid\ngraph TD; A-->B\n```')).ok).toBe(true)
  })

  it('rejects the live-run sample with the parser message and the line', async () => {
    const check = await validateMermaid(LIVE_RUN_SAMPLE)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.line).toBe(2)
    expect(check.message).toMatch(/^Parse error on line 2: Expecting /)
    expect(check.message).toMatch(/NODE_STRING/)
  })

  it('rejects an unknown first keyword, an empty source and script content', async () => {
    expect((await validateMermaid('hello world')).ok).toBe(false)
    expect((await validateMermaid('   ')).ok).toBe(false)
    expect((await validateMermaid('graph TD; A-->B; click A "javascript:alert(1)"')).ok).toBe(false)
    expect((await validateMermaid('graph TD\n<script>x</script>')).ok).toBe(false)
    expect((await validateMermaid('x'.repeat(7000))).ok).toBe(false)
  })

  it('names the keyword problem without a line number', async () => {
    const check = await validateMermaid('hello there')
    expect(check).toEqual({ ok: false, message: expect.stringMatching(/^the first line must start with one of: graph, flowchart/) })
  })

  it('strips a fence when cleaning', () => {
    expect(cleanMermaid('```\ngraph TD; A-->B\n```')).toBe('graph TD; A-->B')
  })
})

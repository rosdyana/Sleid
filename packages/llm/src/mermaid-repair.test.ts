import { beforeAll, describe, expect, it } from 'vitest'
import { validateMermaid } from './mermaid.ts'
import { repairMermaid } from './mermaid-repair.ts'

const LIVE_RUN_SAMPLE = 'flowchart LR\n  Sunlight --> Panels --> Inverter --> Shop appliances\n  Inverter -->|surplus| Battery'

describe('repairMermaid', () => {
  // The first validateMermaid call loads mermaid (and a DOM shim), which can exceed the 5 s test
  // timeout when the whole suite runs in parallel. Load it once here with a longer budget.
  beforeAll(async () => {
    await validateMermaid('flowchart LR\n  A --> B')
  }, 60_000)

  it('gives a bare multi-word node an id and a bracketed label, and the result parses', async () => {
    const repaired = repairMermaid(LIVE_RUN_SAMPLE)
    expect(repaired).toBe('flowchart LR\n  Sunlight --> Panels --> Inverter --> ShopAppliances[Shop appliances]\n  Inverter -->|surplus| Battery')
    expect(await validateMermaid(repaired)).toEqual({ ok: true })
  })

  it('handles a chain where a multi-word name sits between two edges', async () => {
    const repaired = repairMermaid('flowchart TD\n  A --> B C --> D')
    expect(repaired).toBe('flowchart TD\n  A --> BC[B C] --> D')
    expect((await validateMermaid(repaired)).ok).toBe(true)
  })

  it('uses the same id for the same label on every line', async () => {
    const repaired = repairMermaid('flowchart LR\n  Solar panels --> Inverter\n  Inverter --> Solar panels')
    expect(repaired).toBe('flowchart LR\n  SolarPanels[Solar panels] --> Inverter\n  Inverter --> SolarPanels[Solar panels]')
    expect((await validateMermaid(repaired)).ok).toBe(true)
  })

  it('keeps edge labels exactly as written, with and without arrows', () => {
    const repaired = repairMermaid('flowchart LR\n  Inverter -->|surplus to battery| Battery\n  Panels -.->|later use| Shop appliances')
    expect(repaired).toBe('flowchart LR\n  Inverter -->|surplus to battery| Battery\n  Panels -.->|later use| ShopAppliances[Shop appliances]')
  })

  it('reuses the id of an existing bracketed label, and avoids ids already in use', () => {
    expect(repairMermaid('flowchart LR\n  Shop[Shop appliances] --> Shop appliances')).toBe('flowchart LR\n  Shop[Shop appliances] --> Shop[Shop appliances]')
    expect(repairMermaid('flowchart LR\n  ShopAppliances --> Shop appliances')).toBe('flowchart LR\n  ShopAppliances --> ShopAppliances2[Shop appliances]')
  })

  it('handles statements separated by semicolons on one line', async () => {
    const repaired = repairMermaid('graph TD; A --> B C; B --> D')
    expect(repaired).toBe('graph TD; A --> BC[B C]; B --> D')
    expect((await validateMermaid(repaired)).ok).toBe(true)
  })

  it('does not touch statements that are not nodes, or lines with inline edge labels', () => {
    const source = [
      'flowchart LR',
      '  subgraph Kitchen Area',
      '    Oven --> Hob',
      '  end',
      '  style Oven fill:#f9f',
      '  classDef hot fill:#f00',
      '  A -- yes please --> B C',
    ].join('\n')
    expect(repairMermaid(source)).toBe(source)
  })

  it('leaves valid flowcharts, bracketed labels and comments unchanged', () => {
    const valid = [
      'flowchart LR',
      '  %% a comment with several words',
      '  A["Sun panels"] -->|surplus| B(Battery)',
      '  B --> C{Use now?} & D',
      '  A:::hot --> E',
    ].join('\n')
    expect(repairMermaid(valid)).toBe(valid)
  })

  it('is idempotent: a second pass changes nothing', () => {
    const once = repairMermaid(LIVE_RUN_SAMPLE)
    expect(repairMermaid(once)).toBe(once)
    const chain = repairMermaid('flowchart TD\n  A --> B C --> D; D --> E F')
    expect(repairMermaid(chain)).toBe(chain)
  })

  it('leaves diagrams that are not flowcharts exactly as they are', () => {
    const sequence = 'sequenceDiagram\n  Alice->>Bob: hi there friend'
    expect(repairMermaid(sequence)).toBe(sequence)
    const pie = 'pie title Pets\n  "Dogs" : 3'
    expect(repairMermaid(pie)).toBe(pie)
  })

  it('returns a fenced source unchanged when there is nothing to fix', () => {
    const fenced = '```mermaid\nflowchart LR\n  A --> B\n```'
    expect(repairMermaid(fenced)).toBe(fenced)
  })

  it('does not split words that only look like an edge start', () => {
    expect(repairMermaid('flowchart LR\n  Big Box-->Panel')).toBe('flowchart LR\n  BigBox[Big Box]-->Panel')
  })
})

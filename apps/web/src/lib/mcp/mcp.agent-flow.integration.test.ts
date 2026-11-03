// Integration: an agent builds a product introduction over MCP, the way the plan says. The flow imports the Kompast
// reference deck, creates a deck, takes Kompast's look, uploads five screenshots, adds a second language, adds ten slides
// from components, then checks the result with lint_deck and render_deck. Every tool call is counted and its arguments are
// recorded, so the test can check the call budget and that no call sets a position or size by hand.
// Set SAVE_SHEET=1 to write the two contact sheets to the scratchpad folder, for a visual check.
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TokenScope } from '@sleid/db'
import { clientFor, BROWSER_OK, CHROME, recording, startHarness, stopHarness, textOf, jsonOf, person, tokenFor, type Harness, type RecordingClient, type ToolResult } from './test-harness.ts'

const SHEET_DIR = '/private/tmp/claude-501/-Users-rosdyanakusuma-Ross-projects-sleid/68dc79f9-5d91-49b9-9fcf-47d11ae72ef4/scratchpad'
const SCOPES: TokenScope[] = ['decks:read', 'decks:write', 'decks:create']
const SCREENS = ['backlog', 'board', 'doc', 'home', 'shared-page']
const MAX_CALLS = 40

let h: Harness | null = null

beforeAll(async () => {
  h = await startHarness()
}, 120_000)

afterAll(async () => {
  await stopHarness(h)
}, 120_000)

/** Every key with one of the given names, anywhere in a value. Returns their paths. */
function keysNamed(value: unknown, names: string[], path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keysNamed(v, names, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [...(names.includes(k) ? [`${path}.${k}`] : []), ...keysNamed(v, names, `${path}.${k}`)])
  }
  return []
}

function pngOf(result: ToolResult): Buffer {
  const image = result.content.find((c) => c.type === 'image')
  expect(image, 'the render returned an image').toBeDefined()
  expect(image!.mimeType).toBe('image/png')
  return Buffer.from(image!.data!, 'base64')
}

interface StyleView {
  theme: { colors: Record<string, string>; sizes: Record<string, number> }
  typeScale: { heading?: { size: number; textTransform?: string }; label?: { size: number; textTransform?: string } }
  darkVariant?: { background: { type: string; value: string } }
}

describe('MCP agent flow: a product introduction from the Kompast look (M11 phase D)', () => {
  it('builds ten slides with components inside the call budget, checks them, and matches the reference look', async () => {
    if (!h) return
    const owner = await person(h, 'agent-flow-owner')
    const token = await tokenFor(h, owner.id, SCOPES)
    const mcp = await clientFor(h, token)
    const rec: RecordingClient = recording(mcp)
    const saveSheets = process.env.SAVE_SHEET === '1'

    // 1. The reference deck, imported from its json file (the import worker runs it, as in the web app).
    const kompastText = readFileSync(new URL('./fixtures/kompast.sleid.json', import.meta.url), 'utf8')
    const kompastId = jsonOf(await rec.call('import_deck', { format: 'json', text: kompastText, title: 'Kompast · Stakeholder Introduction' })).deckId as string

    // 2. The new deck, and its look taken from Kompast.
    const deckId = jsonOf(await rec.call('create_deck', { title: 'Sleid · Product introduction', startEmpty: true })).id as string
    expect(jsonOf(await rec.call('get_deck', { deckId, format: 'outline' }))).toMatchObject({ slideCount: 0 })
    const applied = jsonOf(await rec.call('apply_style_from_deck', { sourceDeckId: kompastId, targetDeckId: deckId, footerText: 'Sleid · Product introduction' }))
    expect(applied).toMatchObject({ theme: 'Kompast', slidesUpdated: 0, chrome: { footerText: 'Sleid · Product introduction' } })

    // 3. Five screenshots on the deck.
    const assetIds: string[] = []
    for (const name of SCREENS) {
      const base64 = readFileSync(new URL(`./fixtures/screens/${name}.png`, import.meta.url)).toString('base64')
      const up = jsonOf(await rec.call('upload_asset', { deckId, name: `${name}.png`, mime: 'png', base64 }))
      assetIds.push(up.assetId as string)
    }

    // 4. The second language, then the ten slides.
    expect(jsonOf(await rec.call('set_deck_options', { deckId, secondaryLanguage: 'zh-TW' }))).toMatchObject({ secondaryLanguage: 'zh-TW' })
    const slides: Array<{ slideId: string; components: Array<{ kind: string; instance: string }> }> = []
    const add = async (args: Record<string, unknown>) => {
      const result = await rec.call('add_slide', { deckId, ...args })
      expect(result.isError, textOf(result)).toBeFalsy()
      const made = jsonOf(result) as { slideId: string; components: Array<{ kind: string; instance: string }> }
      slides.push(made)
    }

    await add({
      variant: 'dark',
      components: [{ kind: 'header', region: 'center', props: { label: 'Product introduction', heading: 'Sleid', subtitle: 'Slides for teams, built from components', secondary: '為團隊而生的簡報工具，由元件組成' } }],
    })
    await add({
      components: [
        { kind: 'header', props: { label: 'The problem', heading: 'Decks take days, and the look drifts', subtitle: 'Every slide is drawn by hand, so each one differs.', secondary: '每張投影片都要手工調整，風格越來越不一致。' } },
        {
          kind: 'card_grid',
          props: {
            cards: [
              { icon: 'lock', tint: 'accent', title: 'Private by default', body: 'Only the people you invite can open a deck.', secondary: '預設私密，只有受邀者能開啟。' },
              { icon: 'link', tint: 'accent2', title: 'One source of truth', body: 'Every slide is built from the same components.', secondary: '每張投影片都由同一組元件組成。' },
              { icon: 'eye-off', tint: 'accent3', title: 'Nothing hidden', body: 'Lint and render show what a reader sees.', secondary: '檢查與預覽，所見即所得。' },
            ],
          },
        },
      ],
    })
    await add({
      components: [
        { kind: 'header', props: { label: 'Today versus after', heading: 'Less rework, one look', secondary: '減少重工，風格一致。' } },
        {
          kind: 'comparison',
          props: {
            beforeLabel: 'Today',
            afterLabel: 'With Sleid',
            rows: [
              { before: 'Restyle each slide by hand', after: 'Components take the theme' },
              { before: 'Check the layout by eye', after: 'Lint finds overlap and overflow' },
              { before: 'Translate line by line', after: 'Secondary lines sit beside each item' },
              { before: 'Export and hope', after: 'Render a contact sheet first' },
            ],
          },
        },
      ],
    })
    // Kompast slides 5 to 8: headline and bullets in the left column, the screenshot in a browser frame on the right.
    const features = [
      { heading: 'Backlog and board', bullets: ['Rank issues into a sprint', 'Drag work between columns', 'See the sprint in one place'] },
      { heading: 'Sprint board', bullets: ['Kanban columns you configure', 'Inline editing on every card', 'Burndown for the sprint'] },
      { heading: 'Docs next to issues', bullets: ['Write beside the work', 'Embed live issues in a page', 'Share a page by link'] },
    ]
    for (let i = 0; i < 3; i++) {
      await add({
        components: [
          { kind: 'header', region: 'left', props: { label: 'Feature', heading: features[i]!.heading, subtitle: 'Plan the work from one screen.', secondary: '在同一畫面規劃工作。' } },
          {
            kind: 'bullets_with_sublines',
            region: 'left',
            props: { items: features[i]!.bullets.map((text) => ({ text, secondary: '中文說明' })) },
          },
          { kind: 'browser_frame', region: 'right', props: { assetId: assetIds[i], alt: `The ${SCREENS[i]} screen of the product`, caption: ['Backlog: rank issues into a sprint.', 'Board: move work across columns.', 'Docs: write next to the work.'][i] } },
        ],
      })
    }
    await add({
      components: [
        { kind: 'header', props: { label: 'By the numbers', heading: 'Built on one stack', subtitle: 'What the deck is made of.', secondary: '簡報的組成。' } },
        {
          kind: 'stat_row',
          props: {
            stats: [
              { value: '9', label: 'component kinds', sub: 'header to numbered cards' },
              { value: '2', label: 'languages', sub: 'English and zh-TW' },
              { value: '1', label: 'theme per deck', sub: 'shared by every slide' },
            ],
          },
        },
      ],
    })
    await add({
      components: [
        { kind: 'header', props: { label: 'How it works', heading: 'From brief to deck in four steps', secondary: '從需求到簡報，四個步驟。' } },
        {
          kind: 'timeline',
          props: {
            steps: [
              { title: 'Plan', secondary: '規劃', subtitle: 'plan_deck', bullets: ['Brief, audience, length'], outcome: 'A slide list' },
              { title: 'Style', secondary: '風格', subtitle: 'apply_style_from_deck', bullets: ['Reuse a reference look'], outcome: 'Theme and logos' },
              { title: 'Compose', secondary: '組成', subtitle: 'add_slide', bullets: ['Components, not boxes'], outcome: 'Slides in order' },
              { title: 'Check', secondary: '檢查', subtitle: 'lint_deck', bullets: ['Fix what it reports'], outcome: 'Render and export' },
            ],
          },
        },
      ],
    })
    await add({
      components: [
        { kind: 'header', props: { label: 'Why it matters', heading: 'Decks that agents can build and check', secondary: '代理人可以建立並檢查的簡報。' } },
        {
          kind: 'bullets_with_sublines',
          props: {
            items: [
              { text: 'Components keep the layout right', sub: 'Placement, stacking and sizes come from the theme.', secondary: '版面、間距與尺寸都來自主題。' },
              { text: 'The checks run before you present', sub: 'Lint and renders are part of the workflow.', secondary: '簡報前就完成檢查與預覽。' },
              { text: 'Every change is an operation', sub: 'Open editors see the same change, live.', secondary: '所有變更都以操作完成，編輯器即時同步。' },
            ],
          },
        },
      ],
    })
    await add({
      variant: 'dark',
      components: [
        { kind: 'header', props: { label: 'The ask', heading: 'Try it on your next deck', subtitle: 'Start from the plan, then render it.', secondary: '從計畫開始，然後預覽。', size: 'ask' } },
        {
          kind: 'numbered_cards',
          props: {
            items: [
              { title: 'Plan the deck', body: 'plan_deck gives the slides and the calls.', secondary: 'plan_deck 會給出投影片與呼叫順序。' },
              { title: 'Build with components', body: 'add_slide with components, then lint.', secondary: '用元件建立投影片，再做檢查。' },
              { title: 'Check and share', body: 'Render the sheet, export, and share.', secondary: '預覽、匯出並分享。' },
            ],
          },
        },
      ],
    })
    expect(slides).toHaveLength(10)

    // The deck is exactly the ten slides: the cover first (dark), the ask last (dark, with numbered cards).
    const built = jsonOf(await rec.call('get_deck', { deckId, format: 'json' })) as {
      slides: Array<{ variant?: string; elements: Array<{ component?: { kind: string } }> }>
    }
    expect(built.slides).toHaveLength(10)
    expect(built.slides[0]!.variant).toBe('dark')
    expect(built.slides[9]!.variant).toBe('dark')
    expect(built.slides[9]!.elements.some((e) => e.component?.kind === 'numbered_cards')).toBe(true)

    // 5. The checks.
    const lint = jsonOf(await rec.call('lint_deck', { deckId })) as { ok: boolean; counts: Record<string, number>; issues: unknown[] }
    writeFileSync(`${SHEET_DIR}/agent-flow-lint.json`, JSON.stringify(lint, null, 2))
    expect(lint.issues, JSON.stringify(lint.issues, null, 2)).toEqual([])
    expect(lint.counts).toEqual({ error: 0, warning: 0, info: 0 })
    expect(lint.ok).toBe(true)

    if (BROWSER_OK) {
      const sheet = await rec.call('render_deck', { deckId, mode: 'sheet' })
      expect(sheet.isError).toBeFalsy()
      const bytes = pngOf(sheet)
      expect(bytes.readUInt32BE(16)).toBeGreaterThan(0)
      if (saveSheets) writeFileSync(`${SHEET_DIR}/agent-flow-sheet.png`, bytes)
      const reference = await rec.call('render_deck', { deckId: kompastId, mode: 'sheet' })
      expect(reference.isError).toBeFalsy()
      if (saveSheets) writeFileSync(`${SHEET_DIR}/kompast-sheet.png`, pngOf(reference))
      if (saveSheets) {
        // Each new slide at half size, for a closer look at the layout.
        const each = await rec.call('render_deck', { deckId, mode: 'slides', slideIds: slides.map((s) => s.slideId) })
        expect(each.isError).toBeFalsy()
        const pictures = each.content.filter((c) => c.type === 'image')
        pictures.forEach((p, i) => writeFileSync(`${SHEET_DIR}/flow-slide-${String(i + 1).padStart(2, '0')}.png`, Buffer.from(p.data!, 'base64')))
      }
    } else {
      console.warn(`[agent flow] CHROME_PATH (${CHROME || 'unset'}) is not a file, so the contact sheets were not rendered`)
    }

    // 6. The style of the new deck matches the reference on colours, heading and label sizes, and the dark background.
    const sourceStyle = jsonOf(await rec.call('get_deck_style', { deckId: kompastId })) as unknown as StyleView
    const targetStyle = jsonOf(await rec.call('get_deck_style', { deckId })) as unknown as StyleView
    expect(targetStyle.theme.colors).toEqual(sourceStyle.theme.colors)
    expect(targetStyle.typeScale.heading?.size).toBe(sourceStyle.typeScale.heading?.size)
    if (sourceStyle.typeScale.label) expect(targetStyle.typeScale.label?.size).toBe(sourceStyle.typeScale.label.size)
    expect(targetStyle.darkVariant?.background).toEqual(sourceStyle.darkVariant?.background)

    // 7. The budget, and no hand-placed geometry in any call.
    await mcp.close()
    expect(rec.calls.length).toBeLessThan(MAX_CALLS)
    for (const call of rec.calls) {
      expect(keysNamed(call.args, ['x', 'y', 'w', 'h'])).toEqual([])
    }
    if (saveSheets) writeFileSync(`${SHEET_DIR}/agent-flow-calls.json`, JSON.stringify({ count: rec.calls.length, calls: rec.calls.map((c) => c.name) }, null, 2))
  }, 900_000)
})

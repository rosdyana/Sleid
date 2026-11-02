# Sleid: web slide editor (reveal.js, Sheets-style UI, live co-edit, AI + MCP)

## Status

Living document. Update it as decisions change.

| Milestone | State |
|---|---|
| 0. Scaffold monorepo, compose, Better Auth Google login, Drizzle schema, DESIGN.md + README | **Done** (checks run, see below) |
| 1a. Model (zod schema, Yjs binding, deck-ops, undo) + reveal.js renderer + Markdown | **Done** (checks run, see M1a below) |
| 1b. Sheets-style editor UI, single user, reveal.js present | Pending |
| 2. Hocuspocus live co-edit, presence, sharing and roles, link tokens | Pending |
| 3. Export worker: PDF, PNG, PPTX, HTML, MD, JSON | Pending |
| 4. LLM providers + assistant panel + fx-bar "Ask AI" | Pending |
| 5. MCP server + access tokens | Pending |
| 6. Wizard + reference ingestion + research | Pending |
| 7. Comments, version history, presenter + phone remote | Pending |
| 8. Import: PPTX, Google Slides, Markdown | Pending |
| 9. Templates and brand kits | Pending |

### What M0 built, and decisions taken while building it

- Workspace: `apps/web` (TanStack Start 1.169.x, Vite 8, Nitro, Tailwind v4), placeholders `apps/collab`, `apps/worker`, `packages/{model,render,pptx,llm,ui}`.
- Auth: Better Auth with only `socialProviders.google`. The email+password test login is gated by `SLEID_TEST_AUTH=1`. It is disabled when `NODE_ENV=production`, and the server refuses to serve in that combination.
- Permissions: the role ordering is a pure function in `apps/web/src/lib/permissions.ts`. `requireDeckRole` (in `deck-access.server.ts`) reads membership from the DB. Missing and forbidden decks return the same error.
- `invites.role` and `share_links.role` use a `share_role` enum (editor, commenter, viewer), so ownership cannot be granted through a link or invite. The plan did not name the enum for `invites`; this is a choice made in M0.
- The title and star in the editor shell persist through `updateDeckFn`. Sharing is a disabled button until M2.
- Server functions use the TanStack Start 1.169 `.validator(...)` API.
- Database: Postgres 17 on host port 5433 (compose). Migrations run as the compose owner. No RLS and no app role, as the M0 brief says.

### Unverified

- Real Google sign-in has not been exercised. No Google OAuth client credentials were available, so the Google button only renders. The redirect URI and consent flow are unchecked.
- The smoke test uses the email+password test path, not Google.
- The production guard was checked by booting the built server. It refuses to serve with `SLEID_TEST_AUTH=1`, but the throw surfaces as an HTTP 500 on the first request, not as a process exit at boot.
- The Playwright bundled Chromium was not installed. The smoke test ran on the locally installed Google Chrome through `CHROME_PATH`.
- `drizzle-kit generate` output is checked by applying it to Postgres 17 once. No schema-level tests exist yet.
- Bytea columns (`deck_snapshots.ydoc`, `deck_updates.update`) are not exercised with real Yjs data until M2.
- No deployment, backup, or production build was run against a real Postgres beyond local dev.

### What M1a built, and decisions taken while building it

Scope: `packages/model` and `packages/render` only. The editor UI is M1b.

- **Single write path.** Every deck change is a deck-op, applied with `applyOps(doc, ops, origin)`. Ops are zod-validated and JSON-serialisable, so the UI, the assistant and MCP can all send them. `getDeckMap` and `deckToYDoc`/`yDocToDeck` are the only other entry points.
- **No partial apply.** `applyOps` works in three steps. (1) Parse every op with zod. (2) Dry-run the whole batch on a scratch copy of the doc. Any bad target, duplicate id or failed validation throws `OpError` (with `opIndex`, `opName`, `reason`) here, and the real doc is untouched. (3) Run the same batch on the real doc inside one `doc.transact(fn, origin)`. Step 3 cannot fail, because step 2 passed on the same state. The test suite checks that a failed batch fires no update event and leaves the encoded state vector unchanged.
- **Ids are fixed before the batch runs.** `addSlide`, `addElement`, `addSection` and `duplicateSlide` get their ids at parse time, so a later op in the same batch can refer to them. Layout placeholders get deterministic ids `${slideId}-${index}`. The dry run and the real run therefore see the same ids. Ids for duplicated elements are generated per run, and nothing references them.
- **Patch semantics** (`updateElement`, `updateSlide`, `setTheme`). A patch is deep-partial. Nested plain objects merge key by key, arrays and primitives replace, `null` deletes an optional key, and `undefined` is ignored. The merged result is validated with zod before any write. A key that zod would strip (an unknown top-level field) is rejected rather than silently dropped. Patches cannot change `id` or `type`.
- **Rich text is JSON for now.** Text `content`, `shape.text`, `chart.data` and `chart.echartsOverride` are stored as opaque JSON values and replaced whole on update. Every other element field is a Y.Map entry, so two users editing different keys of one element both survive a merge. M2 moves rich text to Y.XmlFragment for y-prosemirror. Callers use `yDocToDeck` and `applyOps`, so only `ydoc.ts` and `ops.ts` change then.
- **Rich text schema.** A permissive ProseMirror/TipTap subset. Known marks are typed (`bold`, `italic`, `underline`, `strike`, `code`, `link`, `textStyle`). Unknown nodes and extra keys pass through (`looseObject`). Renderers drop unknown node wrappers and keep their text.
- **Slide moves re-create the slide.** Yjs has no array move, so `moveSlide` deletes the slide's Y.Map and inserts a copy. Two known consequences, both noted in `ydoc.ts`. (a) An edit to the same slide made concurrently with a move can be lost. Replicas still converge, and the concurrency suite checks that case. (b) Two concurrent moves of one slide can leave a duplicate id, and `yDocToDeck` keeps the first occurrence. Case (b) is not tested yet. Revisit in M2: keep slide order as an array of ids over an id-keyed Y.Map, so a move never re-creates content.
- **Speaker notes are a plain string** (last writer wins). Y.Text can replace this later if concurrent note editing matters.
- **Undo.** `createUndoManager(doc, origins, { captureTimeout })` tracks the `deck` root. Its default `captureTimeout` is 0, so each `applyOps` batch is one undo step. The UI can pass a larger value to merge typing. Yjs restores the value recorded when a change was made. So undo can overwrite an untracked remote edit to the same key. The test covers this with a remote change on a different key.
- **Z-order** is a number per element. `front` and `back` go past the extremes, and `forward` and `backward` swap with the nearest neighbour. Two users reordering at once can produce ties. The renderer sorts by z, stable on array order.
- **`createDeck`** makes one title slide, so the editor opens with something to edit. Themes: "Sheets Light" (the default) plus Midnight, Warm Paper and High Contrast.
- **Renderer entry points.** `@sleid/render` (browser-safe, no fs) and `@sleid/render/node` (adds `renderStandaloneDeckHtml`, which reads reveal.js from node_modules). Present and print modes load reveal.js 5.2.1 from jsDelivr. Standalone mode inlines `reveal.css`, `reveal.js` and the notes plugin, which are the UMD builds, so they run as classic inline scripts. An inlined file that contains `</script>` or `</style>` makes the build throw.
- **Mermaid is not bundled.** Standalone output loads mermaid 12.2.0 from jsDelivr, and only when the deck has a diagram. A deck with diagrams is therefore not fully offline. Bundling mermaid is a later decision, since the bundle is large and the size was not measured.
- **Charts** render on the server as SVG (ECharts 6.1, `renderer: 'svg', ssr: true`), sized to the element. Pie and donut use the first value column. Scatter treats column 0 as numeric x. `echartsOverride` is deep-merged last, where objects merge and arrays replace. Chart SVG is also passed through a sanitiser that removes script tags, `on*` attributes and `javascript:` URLs.
- **Untrusted content in HTML.** Text is escaped. Links are kept only for http, https and mailto, and are emitted with `target="_blank" rel="noopener noreferrer"`. Images accept http(s), raster `data:` URLs and root-relative paths. Embeds accept http(s) only, in an iframe sandboxed without `allow-same-origin`. Colours, font families, lengths, gradients and token classes are checked against allow-lists before they reach a `style` or `class` attribute.
- **Markdown** (`deckToMarkdown` and `markdownToDeck`) covers the basic content only. Slides are separated by `---` lines, and an empty slide still makes a block so the slide count survives. Notes are written as `Note:`. Charts export as pipe tables and import as table elements. Subtitles export as plain paragraphs. Backgrounds, transitions, animations and positions are lost. Known gaps: a `---` line inside notes splits the slide, and a literal `*` pair in text imports as italics.
- **Dependencies (installed).** `@sleid/model`: yjs 13.6.33, zod 4.6.7 (declared `^4.6.5`, the same range apps/web uses, and locked to the same 4.6.7), nanoid 6.0.2, vitest 5.0.5 (dev). `@sleid/render`: `@sleid/model`, reveal.js 5.2.1 (the newest 5.x), echarts 6.1.0, @types/node 26.6.6 and vitest 5.0.5 (dev). The render tsconfig loads `node` types, since the Node-only entry point needs them.

### M1a verification

- `pnpm install`, `pnpm typecheck` and `pnpm test` from the repo root all exit 0. The root `vitest.config.ts` already includes `packages/*/src/**/*.test.ts`, so it needed no change. Root tests: 9 files, 102 tests. That is 60 in `packages/model` (6 files, including 19 per-op invalid-target cases that cover all 15 op types), 37 in `packages/render` (2 files), and the 5 existing `apps/web` permission tests.
- `tsc --noUnusedLocals --noUnusedParameters` is clean for both packages.
- The sample deck (`packages/render/scripts/sample.ts`, 4 slides with a bar chart and an animated callout) was written as standalone HTML. Slides 1 and 3 were screenshotted with playwright-core on the installed Google Chrome. The screenshots are in the session scratchpad, `sample-1.png` and `sample-3.png`, and both match the intended layout.
- Present mode was checked separately in Chrome. reveal.js loads from the pinned CDN. The animated callout starts hidden as a fragment, appears after one step, and the page logs no errors.

### Unverified

- The editor UI does not exist yet (M1b), so nothing in M1a runs in a live multi-user session. The concurrency tests use in-process `Y.applyUpdate` only, with no network or provider.
- Mermaid rendering has not been exercised in a browser. The sample deck has no diagram.
- The screenshots used the installed Google Chrome through `executablePath`, not Playwright's bundled Chromium.
- Fonts are referenced by name with a generic fallback. Inter is not loaded from anywhere, so on a machine without it the text falls back to the system sans-serif.
- Property-based tests were not written. Concurrency coverage is a fixed set of scenarios.

---


## Context
`projects/sleid` is empty. We'll build a lightweight web slide editor:
- reveal.js handles presenting and export.
- The chrome looks like Google Sheets.
- Login is Google-only.
- Live co-editing and sharing.
- Export to many formats.
- An MCP server lets AI agents build decks.
- LLM assistant on a pluggable provider (Azure Foundry, or a local OpenAI-compatible model) for text, charts, visuals, themes and effects.
- Extras you chose: comments, version history, presenter mode, import (PPTX, Google Slides, Markdown), templates and brand kits, and a **wizard**. The wizard takes optional reference files and URLs, can let the LLM research the topic, and builds a deck from a prompt.

Decisions made: reveal.js; TanStack Start + Postgres (same stack as Untumu and papereview); live co-editing in v1.

## Architecture

**One command layer drives everything.** A typed `deck-ops` set (addSlide, updateElement, setTheme, insertChart, reorder…) is the only way to change a deck. The UI, the AI assistant and the MCP tools all call it. Ops run against the deck's Yjs doc, so an AI or MCP edit shows up live for every collaborator, and undo works for all of them.

```
apps/web      TanStack Start: UI, server fns, /api/*, /mcp (Streamable HTTP)
apps/collab   Hocuspocus WebSocket server (Yjs), auth hook, Postgres persistence
apps/worker   pg-boss jobs: export (Playwright), import, wizard research/generation
packages/model     zod deck schema + Yjs binding + deck-ops (pure, unit-tested)
packages/render    deck → reveal.js HTML (used for present, HTML/PDF/PNG export, previews)
packages/pptx      deck ⇄ PPTX (pptxgenjs out, JSZip+XML parser in)
packages/llm       provider interface + Foundry / local adapters + prompts/schemas
packages/ui        Sheets-style chrome components
docker-compose     postgres, web, collab, worker (+ optional searxng)
```
Tooling: pnpm workspaces, TypeScript, Drizzle ORM, Vitest, and Playwright for tests.

### Deck model (`packages/model`)
- The canvas is 1920×1080, and elements are absolutely positioned. Element types: `text` (TipTap/ProseMirror content held in a Y.XmlFragment), `shape`, `image`, `chart` (an ECharts option plus a data grid), `diagram` (Mermaid source), `table`, `code`, `embed`.
- Each slide has a layout ref, background, speaker notes, a transition, and fragments/animations, which map to reveal fragments and auto-animate.
- A theme is a set of tokens: palette, fonts, sizes, radius, background styles. Brand kits and templates are themes plus layouts plus a logo.

### Editor UI (Sheets-like)
- Title bar with star and share button. Menu bar: File, Edit, View, Insert, Format, Slide, Arrange, Tools, Extensions, Help. A compact icon toolbar below it.
- An **fx bar** for the selected element. It edits text, the chart data range, Mermaid source, or an "Ask AI" prompt for that element.
- A left filmstrip, the center canvas (react-moveable for drag, resize, rotate, snapping and guides), and a right side panel for properties, theme, AI chat, comments and history.
- Bottom tabs for slide **sections**, styled like sheet tabs.
- Chart elements open a **mini spreadsheet grid** for their data. That's where the Sheets resemblance pays off. Paste from Excel works, as does CSV/XLSX import via SheetJS.
- Collaborator cursors and avatars come from Yjs awareness. Keyboard shortcuts match Google Slides and Sheets.

### Auth: Better Auth + Google
This is the easiest robust option. The `socialProviders.google` config plus the Drizzle adapter come to about 10 lines. Better Auth handles sessions, CSRF and account linking. You'll need a Google Cloud OAuth client with the redirect `/api/auth/callback/google`. Google Slides import asks for the extra `drive.readonly` scope only when the user starts an import (incremental consent).

### Sharing and live co-editing
- Tables: `decks`, `deck_members(role: owner|editor|commenter|viewer)`, `share_links(token, role, expires)`, `invites(email, role)`.
- The share dialog works like Google's: invite by email, plus "Anyone with link: viewer/commenter/editor".
- Hocuspocus `onAuthenticate` validates the Better Auth session cookie or a link token, then sets the connection to read-only for viewers and commenters. Persistence is a debounced Yjs update log plus compaction into `deck_snapshots`.

### Export (worker, `packages/render` + Playwright)
| Format | How |
|---|---|
| PDF | reveal.js `?print-pdf` printed by Playwright Chromium |
| PNG/JPG (per slide, zip) | Playwright screenshots |
| PPTX | pptxgenjs from the model (native, editable text, shapes and charts; images as fallback) |
| Standalone HTML (zip) | reveal.js bundle + assets, works offline |
| Markdown | reveal-style `---` separated |
| JSON | native deck, re-importable |

There's also a public "Publish to web" read-only present link.

### Import
- **PPTX**: JSZip + DrawingML parse into the model. Best effort: text, shapes, images, tables, notes, basic theme.
- **Google Slides**: Google Picker, then Drive export as PPTX, then the PPTX path.
- **Markdown**: reveal syntax.
- **JSON**: native format.

### LLM (`packages/llm`)
- `LlmProvider` interface: `chat`, `stream`, `structured(schema)`, `tools`. Two adapters:
  - **Azure Foundry**: Claude via `@anthropic-ai/foundry-sdk` (same as papereview), plus Azure OpenAI deployments through an OpenAI-compatible path.
  - **Local**: any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp).
- Configured per workspace in settings: endpoint, model and key. Keys are encrypted at rest. A "test connection" button checks the setup.
- Abilities, each returning **deck-ops** validated by zod:
  - write or rewrite text (shorten, tone, translate)
  - generate a chart (ECharts option + data) or a diagram (Mermaid)
  - generate a theme from a prompt or brand colors
  - suggest transitions and animations
  - speaker notes
  - alt text
  - one slide from a prompt
- Local models get a JSON-repair and retry step plus a smaller schema mode, because structured output from local models is less reliable.

### MCP server (`/mcp`, Streamable HTTP, `@modelcontextprotocol/sdk`)
- Auth uses personal access tokens created in Settings and scoped to a user. OAuth can come later.
- Tools: `list_decks`, `create_deck`, `get_deck` (outline + JSON), `apply_ops` (batch deck-ops), `add_slide`, `update_element`, `set_theme`, `insert_chart`, `list_templates`, `render_slide` (returns a PNG so the agent can see its work), `export_deck` (returns a URL), `share_deck`.
- Resources: the deck schema and the theme catalog. An agent can build a deck while you watch it appear live.

### Wizard (prompt → deck)
1. Goal, audience, length, tone, language, template or brand kit.
2. Optional references:
   - files: PDF via unpdf, DOCX via mammoth, PPTX/XLSX/CSV, images
   - URLs: fetched, then readability extraction
3. Optional "Let AI research": a web search tool. The search provider is configurable: SearXNG self-hosted (default, works with local LLMs) or the Brave or Tavily API. The LLM gathers sources and stores them with citations.
4. The LLM drafts an **outline you can edit** before generating.
5. Generation streams slide by slide into the live doc, as ops. Charts are built from the reference data. Citations go into speaker notes and an optional sources slide.

### Extras
- **Comments**: threads anchored to a slide and element, with mentions, resolve, and email notifications later. Stored in Postgres; Hocuspocus stateless messages push them to collaborators.
- **Version history**: auto snapshots every N minutes of activity, named versions, preview, and restore (a restore is applied as a new update).
- **Presenter mode**: the reveal notes plugin (timer, next slide, notes), plus a **phone remote** that pairs by QR code over the collab socket.
- **Templates and brand kits**: workspace library. The AI is constrained to the active kit's tokens and logo placement.

### More ideas (not in v1)
- AI accessibility checker for contrast, alt text and reading order
- Translate the whole deck into a new language copy
- Link analytics for views and time per slide
- Embed widget
- PWA offline editing (Yjs + IndexedDB)
- Audience Q&A and polls during a presentation
- "Rehearse" mode with AI feedback on your pacing

## Milestones (each ends green on its checks)
0. Scaffold the monorepo and docker-compose; Better Auth Google login; Drizzle schema; `docs/DESIGN.md` + README.
1. Model + deck-ops + Sheets-style editor, single user. reveal.js present mode.
2. Hocuspocus live co-edit, presence, sharing and roles, link tokens.
3. Export worker: PDF, PNG, PPTX, HTML, MD, JSON.
4. LLM providers + assistant panel + fx-bar "Ask AI".
5. MCP server + access tokens.
6. Wizard + reference ingestion + research.
7. Comments, version history, presenter + phone remote.
8. Import: PPTX, Google Slides, Markdown.
9. Templates and brand kits.

Per your CLAUDE.md, the `implementer` subagent will do the code edits milestone by milestone, with explicit files and checks. I'll review each diff and run the checks myself. `sleid` will get its own `git init`, since the parent `projects` repo is on an unrelated branch.

## Verification
- **Vitest**: deck-ops (including two Yjs docs converging under concurrent ops), schema validation, render snapshot, PPTX round-trip (export → import keeps text and positions), Markdown round-trip, LLM adapters against a fake OpenAI- and Anthropic-shaped server (request shape plus repair/retry).
- **Playwright e2e**:
  - Google login mocked with a test-only provider.
  - Create a deck, edit text, add a chart from the grid, present.
  - Two browser contexts co-edit and see each other's cursors and edits.
  - A viewer link cannot edit.
  - Export PDF and PPTX, and the files open (pptx validated by re-parse).
- **MCP**: an SDK client test drives `create_deck → apply_ops → render_slide → export_deck`. Manual check by adding `/mcp` to Claude Code and generating a deck while the editor is open.
- **Live LLM**: one manual run each on Foundry and Ollama, wizard prompt → deck with a URL reference. Anything not run live gets recorded in DESIGN.md as unverified.

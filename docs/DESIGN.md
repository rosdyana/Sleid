# Sleid: web slide editor (reveal.js, Sheets-style UI, live co-edit, AI + MCP)

## Status

Living document. Update it as decisions change.

| Milestone | State |
|---|---|
| 0. Scaffold monorepo, compose, Better Auth Google login, Drizzle schema, DESIGN.md + README | **Done** (checks run, see below) |
| 1. Model + deck-ops + Sheets-style editor, single user, reveal.js present | Pending |
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

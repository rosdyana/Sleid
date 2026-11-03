# Sleid: web slide editor (reveal.js, Sheets-style UI, live co-edit, AI + MCP)

## Status

Living document. Update it as decisions change.

| Milestone | State |
|---|---|
| 0. Scaffold monorepo, compose, Better Auth Google login, Drizzle schema, DESIGN.md + README | **Done** (checks run, see below) |
| 1a. Model (zod schema, Yjs binding, deck-ops, undo) + reveal.js renderer + Markdown | **Done** (checks run, see M1a below) |
| 1b. Sheets-style editor UI, single user, reveal.js present, slide ordering fix | **Done** (checks run, see M1b below) |
| 2. Hocuspocus live co-edit, presence, sharing and roles, link tokens | **Done** (checks run, see M2 below; open gaps listed there) |
| 3. Export worker: PDF, PNG, PPTX, HTML, MD, JSON, asset storage, publish to web | **Done** (checks run, see M3 below; open gaps listed there) |
| 4. LLM providers + assistant panel + fx-bar "Ask AI" | **Done** (checks run, see M4 below; open gaps and unverified items listed there) |
| 5. MCP server + access tokens | **Done** (checks run, see M5 below; open gaps and unverified items listed there) |
| 6. Wizard + reference ingestion + research | **Done** (checks run, see M6 below; open items listed there, including the research check on a live search provider and the visual defects of live run 3) |
| 7. Comments, version history, presenter + phone remote | **Done** (checks run, see M7 below; open items and unverified parts listed there) |
| 8. Import: PPTX, Google Slides, Markdown, JSON | **Done** (checks run, see M8 below; open items and unverified parts listed there. Real Google OAuth, Picker and Drive were not run.) |
| 9. Templates and brand kits | **In progress**: built-in templates, brand kit model, logo overlay, AI brand constraint (part A), the wizard, thumbnail and render fixes (part B), and the UI (part C). Not done: the m9 browser check, so the row stays open. See M9 below. |

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
- **Slide order** (known limitation from M1a, fixed in M1b): slides are now an id-keyed Y.Map with a fractional `order` key. See the M1b section.
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

### What M1b built, and decisions taken while building it

Scope: slide ordering in `packages/model`, persistence API in `apps/web`, and the single-user editor and present route in `apps/web`.

**Slide order (Part 1, fixes the M1a limitation).**
- `slides` is a Y.Map keyed by slide id. Each slide Y.Map has an `order` string from `fractional-indexing` 4.0.0 (`generateKeyBetween`). `yDocToDeck` sorts by `order`, then by id, and removes `order`. The plain `Deck` still has an ordered array.
- `moveSlide` writes only `order`. Two concurrent moves of one slide leave one value (last writer wins), so there is no duplicate. An edit made during a move is kept.
- Two inserts between the same neighbours get equal keys and sort by id. If a later op needs a key between two equal keys, `orderAt` respaces all the others first.
- Elements stay a Y.Array. `z` is already explicit, so converting them was not needed and was not done.
- Tests: 5 new concurrency cases (concurrent moves of one slide, move plus edit, move plus delete, concurrent inserts, respacing).

**Persistence (Part 2).** `apps/web/src/lib/deck-doc.server.ts`, `deck-doc.functions.ts`.
- State = latest `deck_snapshots` row merged with every remaining `deck_updates` row (`Y.mergeUpdates`). Loads run in one REPEATABLE READ transaction, so a concurrent compaction cannot make them disagree.
- Appends and compaction both update the `decks` row first. That row lock serialises writers per deck, so compaction sees every committed update, and nothing can be appended between its read and its delete.
- Compaction runs when the update log passes 200 rows. It writes a new snapshot and deletes the updates it folded in. Old snapshots were kept for M7 history at the time; M7 decided that compaction states are not history, so only the newest is kept (see M7).
- The first open of a deck with no snapshot creates one from `createDeck(decks.title)`, with the doc `id` set to the deck id.
- `appendDeckUpdate(deckId, update, title)` takes a third argument, the doc title. It writes `decks.title` in the same transaction, so the list title follows the document. The plan's signature had no title argument; this is the one deviation in Part 2.
- `pushDeckUpdateFn` (editor+) checks base64 and the 2 MB byte cap, applies the update to a copy of the state, and rejects it unless `yDocToDeck` still parses. `getDeckStateFn` (viewer+) returns the base64 state. `copyDeckFn` (viewer+) copies the state into a new deck owned by the caller.
- `deck-doc.server.test.ts` runs against the compose Postgres (127.0.0.1:5433). It covers first snapshot, append plus title sync, compaction at the threshold (201 appends leave 0 update rows and one new snapshot), and copy. It skips with a message when the database is unreachable.

**Editor client (Part 3).**
- One Y.Doc per open deck (`doc-session.ts`). Every local change goes through `applyOps(doc, ops, 'local')`. Updates with origin `remote` are not pushed. Pending updates are merged and pushed 500 ms after the last change. A failed push keeps the batch and retries after 3 s. The title bar shows Saving… / All changes saved / the error.
- `useDeck(doc)` uses `useSyncExternalStore` with a per-doc cache, invalidated before React's listener runs.
- Undo uses `Y.UndoManager` tracking origin `local`, with `captureTimeout` 0, so each batch is one step.
- StrictMode lesson: React StrictMode double-invokes `useMemo` and runs effect cleanups without a real unmount. The session is therefore not destroyed on unmount. Pending edits are flushed instead. An early version destroyed it, and the UI kept editing a dead doc.
- The canvas scales by layout (`left = x * scale`), not by a CSS transform. react-moveable then works in real pixels and divides by the scale once. 100% zoom means a 1280 px wide stage.
- Each gesture commits once when it ends. A click that moves nothing commits nothing.
- Text is edited with TipTap only while the box is being edited (double-click). Commit is on blur or Escape. TipTap's own Underline and Link are turned off inside StarterKit, and the standalone extensions are used instead.
- Text when not editing uses a small React rich-text renderer, not a read-only TipTap instance. This is a deviation from the plan, made to keep one TipTap instance per box out of the filmstrip.
- Charts use ECharts in the browser through `chartToEchartsOption`. Diagrams use Mermaid, loaded on demand with `securityLevel: 'strict'`.
- Filmstrip thumbnails use the same `SlideSurface` as the canvas, at a small scale, not iframes. Charts in thumbnails are small-scale ECharts, so their legends can crowd the plot.
- Images from a file are stored as a data URL, up to 2 MB, in the doc. M3 adds asset storage.
- Chart data grid: a drawer above the section tabs. Row 1 is the header and column A holds categories. A cell commit is one `updateElement`. Numeric-looking cells are stored as numbers. Paste TSV, and CSV or XLSX import through SheetJS.
- SheetJS is installed from the SheetJS CDN tarball, `xlsx@0.20.3`. The npm copy, 0.18.5, predates fixes for published advisories.
- Present (`/d/$deckId/present`, viewer+): reveal.js 5.2.1 bundled by Vite from npm, with the notes plugin. Slides come from `renderSlideHtml`. `?slide=N` starts there. No CDN is used on this route.
- Download HTML uses `renderDeckHtml(deck, { mode: 'present' })`, which loads reveal from jsDelivr. Standalone mode needs Node-side assets, so the download is not offline.
- Menus: every item is in one tree (`MenuBar.tsx`). Later-milestone items are listed and disabled with their milestone: PDF, PPTX and PNG (M3), AI assistant (M4), MCP access tokens (M5). Share is disabled until M2. The AI, Comments and History tabs are disabled until M4 and M7.
- Keyboard map is in `EditorShell.tsx`. Editable fields keep their native keys. The grid keeps its own paste handling.

**Known gaps (not done in M1b).**
- Viewers and commenters can open the editor. Their edits are applied locally and fail on push with "Deck not found", which the status line shows. A read-only editor is M2 work, with roles. **Resolved in M2**: read-only editor and server-side read-only connections.
- Multi-select drag: react-moveable works on one selected element. Several elements move with arrow keys, align and distribute, not by dragging together.
- Chart palette colours are not editable in the side panel. Theme fonts are typed names, not a font picker.
- Grid and guides toggle only outlines elements. There is no ruler.
- Cmd+Enter inside the presentation does not do anything. F5 opens present from slide 1.
- Table cells are not edited in place (the table element is inserted and can be moved and deleted).

### M1b verification

- `pnpm typecheck` exits 0 in every workspace. `tsc --noUnusedLocals --noUnusedParameters` is clean for `packages/model` and `apps/web`.
- `pnpm test` (root): 10 files, 111 tests, all passing. That is 65 in `packages/model`, 37 in `packages/render`, 4 for `deck-doc.server` against the local Postgres, and 5 for `apps/web` permissions.
- `pnpm --filter @sleid/web build` succeeds. The build warns about chunk size (ECharts, TipTap and Moveable in the client bundle) and about TanStack's `"use client"` directives. Both are known and not fixed.
- Editor e2e: `CHROME_PATH=... node apps/web/tests/smoke.mjs` against `SLEID_TEST_AUTH=1 pnpm dev`, using installed Google Chrome. It passed, with no page or console errors. Steps: sign in, create a deck, rename it, add a text box and type into it with TipTap, insert a bar chart, edit a data cell to 42, add a slide with Cmd+Enter, drag the new slide to the front, Undo, Redo, reload and check the title, the slide order, the text, and the chart data, then open present and check 2 reveal sections.
- Scratch checks outside the repo (not committed): canvas drag persists, Delete, menu keyboard behaviour (Escape, focus return, ArrowDown), the shortcuts dialog, a theme change, slide duplicate from the context menu, Make a copy, copy and paste, Cmd+D, two undos, a section, an image from URL, JSON download, and the toast for an invalid colour. All passed.
- Screenshots (session scratchpad): `editor-1.png` (new deck), `editor-2.png` (chart and grid open), `present-1.png` (present view).

### Unverified in M1b

- Diagram rendering (Mermaid) was not exercised in a browser.
- Speaker view (the S key in present) was not exercised.
- File upload of an image (only the URL path was exercised).
- TSV paste and CSV/XLSX import in the data grid were not exercised.
- Rotate and resize with react-moveable, and snapping to guides, were not exercised. Only a drag was.
- Clicking a section tab scrolls the filmstrip. Not exercised.
- `?slide=N` starts on slide N. The e2e checks the section count, not the start slide.
- Real multi-user editing in a browser. Concurrency is tested in-process with Y.applyUpdate, and the browser run is single-user.
- The viewer and commenter experience (see Known gaps).
- Runs used Google Chrome through `CHROME_PATH`. Playwright's bundled Chromium was not used.
- Production serving (`vite build` then `node .output/server/index.mjs`) was not run. Only the dev server was used.
- Snapshot growth under sustained editing is not measured.

### What M2 built, and decisions taken while building it

Scope: live co-editing through Hocuspocus (`apps/collab`), presence, roles end to end, sharing, per-user stars, a server-side ops entry point, and the shared DB package. The pieces are listed first, then the decisions.

**Packages and layout.**
- `packages/db` (`@sleid/db`): Drizzle schema (moved from `apps/web/src/db/schema`), the DB client factory `createDb(url)`, deck persistence (`loadDeckState`, `appendDeckUpdate`, `copyDeck`, `COMPACT_THRESHOLD`), roles (`getDeckRole`, `requireDeckRole`, `canEdit`, `canGrant`, ...), sharing (`grantMembership`, `acceptPendingInvites`, `createInvite`, `redeemShareLink`, `setGeneralAccess`, `setStarred`, ...) and collab tokens (`signCollabToken`, `verifyCollabToken`). Two subpath exports: `@sleid/db/permissions` (pure, safe for the browser bundle) and `@sleid/db/testing` (test helpers).
- **Migrations stay in `apps/web/drizzle`.** The schema moved; drizzle-kit reads it from `packages/db`. `pnpm db:generate` and `pnpm db:migrate` still run from the root.
- `apps/collab`: `config.ts` (env), `hooks.ts` (Hocuspocus hooks), `internal-api.ts` (internal HTTP), `server.ts` (`createCollabServer`, used by `index.ts` and by the integration test), `index.ts` (entry point).
- `apps/web`: `collab-client.server.ts` (typed client for the internal API), `collab-revalidate.server.ts`, `sharing.functions.ts`, `collab.functions.ts` (`getCollabTokenFn`), and the editor client in `components/editor/collab-session.ts` and `ShareDialog.tsx`. `doc-session.ts` and `pushDeckUpdateFn` are removed.

**Versions.** `@hocuspocus/server` and `@hocuspocus/provider` are both `^4.8.0` (4.8.0 is the current release). Both need `yjs` and `y-protocols` as peers (`y-protocols` `^1.0.7`). Hocuspocus 4 requires Node 22 or newer; the repo uses Node 24. `ws` 8.22.1 is used by the integration test. `drizzle-orm` is `^0.45.3` in every package.

**Collab tokens.** `signCollabToken` issues `base64url(JSON claims).base64url(HMAC-SHA256)` with claims `{ userId, deckId, role, name, image, exp }`, `exp` in epoch seconds, five minutes ahead. `verifyCollabToken` checks the signature (constant-time), the expiry and, when given, the deck. Every failure has a reason: `malformed`, `bad-signature`, `expired`, `wrong-deck`, `invalid-claims`. The secret must be at least 32 characters. `getCollabTokenFn` issues a token after a session and role check, and the provider calls it again on every reconnect.

**Hocuspocus hooks** (`apps/collab/src/hooks.ts`).
- `onAuthenticate`: verifies the token against `documentName` (the deck id), then re-reads the role from the database. The DB role wins over the token role. Editors and owners get a writable connection. Commenters and viewers get `connectionConfig.readOnly = true`. A non-member is refused with `not-a-member`.
- `onLoadDocument`: applies `loadDeckState` and records the state vector that the database already holds.
- `onStoreDocument`: debounced by Hocuspocus (2 s, at most 10 s). It appends the diff since the last store as one `deck_updates` row and syncs `decks.title`. Unchanged documents store nothing. A failed append restores the previous state vector, so the next store retries.
- `beforeSync` (**added beyond the plan**): before a writable client's SyncStep2 or Update is applied, it is applied to a scratch copy, and the result must still parse as a deck. Otherwise the connection is closed and nothing is applied. This keeps M1b's rule that a push which breaks the deck is refused. Read-only connections skip this check, because Hocuspocus drops their writes anyway.
- `beforeHandleAwareness` (**added beyond the plan**): presence identity (`user.id`, `user.name`) is replaced with the connection's authenticated identity. A client can still choose its colour and cursor, but cannot show itself as another user. The integration test checks this, and fails when the hook is disabled.
- `afterUnloadDocument`: frees the per-document state vector.
- The config sets `unloadImmediately: true`, so the last client leaving stores at once, and `maxPayload` 3 MB for WebSocket frames.

**Persistence decisions.**
- An update that no longer parses after a store is **logged loudly and still stored**. Dropping it would lose the user's work. The beforeSync guard makes this path rare. If it happens, the next load of that deck fails in the editor, and the log shows why.
- `decks.title` is written from the document title on every store. The dashboard reads it at page load, so a title can lag by up to about 2 seconds, and it refreshes on the next load.

**Internal API** (`apps/collab/src/internal-api.ts`). It runs on its own HTTP listener, `COLLAB_INTERNAL_HOST:COLLAB_INTERNAL_PORT` (default `127.0.0.1:3002`), not on the WebSocket port. Hocuspocus's own request handler writes a default response after the `onRequest` hook, so serving internal routes from the hook would conflict with it. Every request needs `x-sleid-internal`, compared as SHA-256 digests with `timingSafeEqual`.
- `POST /internal/decks/:deckId/ops` with `{ actor, ops }`: applies the batch with `applyOps(doc, ops, 'server:<actor>')` to the live document, so connected clients receive it through the normal broadcast. The batch is all-or-nothing. Success returns `{ ok: true, results }`. An invalid op returns 422 with `{ opIndex, opName, reason }`, and nothing is applied.
- `GET /internal/decks/:deckId/json`: `yDocToDeck` of the live document.
- `POST /internal/decks/:deckId/revalidate` (**added beyond the plan**): re-reads each connected user's role. A downgrade sets `connection.readOnly` in place. A user who has lost access is closed with code 4403. Called by the web app after a role change, a removal, or a general-access change, on a best-effort basis.

**Roles and sharing** (`packages/db/src/sharing.ts`, `apps/web/src/lib/sharing.functions.ts`).
- Owner: changes roles, removes people, sets general access. Editor: invites as editor, commenter or viewer. Commenter and viewer: see the people list only. Ownership is never granted by an invite or a link.
- `grantMembership` is one atomic `INSERT ... ON CONFLICT DO UPDATE` with a SQL rank comparison, so a grant can only raise a role. A test runs concurrent grants and checks the highest role wins.
- Invites: stored lower-case. If an account already exists for the email, it is added at once. Otherwise the invite waits and is accepted by `acceptPendingInvites` on the next authenticated navigation (`_authed` `beforeLoad`). No email is sent.
- General access is one active link per deck. "Restricted" revokes every link. Choosing a role keeps the existing token and changes its role, or creates a new link. The token is shown only to people who can invite.
- `/d/<id>?share=<token>`: a signed-in user redeems the link (`redeemShareLink`) and gets a membership with the link's role, unless they already have a stronger one. A signed-out visitor goes to `/login?redirect=<path>`. `safeReturnPath` keeps only same-origin paths.
- Commenters and viewers get a read-only editor with a "View only" badge. Comments are M7, so commenters have the same read-only UI as viewers for now.

**Starred per user.** `starred` moved from `decks` to `deck_members` in migration `0001`. The migration copies the star to every member of a starred deck. Before M2 only owners existed, so this is the owner's star. `setStarredFn` stars a deck for the caller only. The dashboard has an "All decks" and a "Shared with me" filter. "Shared with me" means the caller's role is not owner.

**Editor client** (`collab-session.ts`).
- One `Y.Doc` per open deck, synced by `HocuspocusProvider` with a token function. The editor renders only after the first sync, because the document is empty before then. A denied connection shows its reason.
- Local edits use origin `'local'`. `Y.UndoManager` tracks only `'local'`, so undo never reverts a collaborator's change. The plan said "the provider's local origin". The provider itself is the origin of remote updates, so a separate string constant is used for local edits.
- A read-only session throws on `apply`. `run()` in `actions.ts` refuses the change with a toast before that. The toolbar, side panel and fx bar sit in disabled fieldsets. The menu items outside a small allow-list are disabled with the note "View only". Moveable is not mounted, and text editing and grid edits are off. Keyboard shortcuts that change the deck are not handled.
- Status (title bar): "Connecting…", "Saving…" while changes wait for the server, "All changes saved", "Offline — changes will sync", or the denial reason. The provider's own offline detection took 38 seconds in a measured run, so the browser's `offline` event shows the status at once. On `online` the socket is detached and reconnected. A plain `disconnect()` would wait for a close handshake that a dead network never completes, and `connect()` would return early.
- Presence (awareness): each user has a stable colour. The fields are `user`, `slideId`, `selection` and `cursor`. Cursor updates are throttled to 50 ms (20 Hz). Remote selections are outlined in the collaborator's colour on the canvas, with their name. Remote cursors show only for collaborators on the same slide. The filmstrip shows a coloured dot for each collaborator on a slide. The title bar shows one avatar per person.
- The share dialog (`ShareDialog.tsx`) does everything in the plan: invite by email with role, role dropdown and remove (owner only), pending invites, general access, copy link.

**Ops endpoint client.** `apps/web/src/lib/collab-client.server.ts` exports `createCollabInternalClient({ baseUrl, secret, fetch })`, which is testable with a fake fetch, and `getCollabInternalClient()`, which reads `COLLAB_INTERNAL_SECRET` and `COLLAB_INTERNAL_URL`. Errors are `CollabInternalError` with the HTTP status.

**Deviations from the plan.**
- `COLLAB_INTERNAL_PORT`, `COLLAB_INTERNAL_HOST` and `COLLAB_INTERNAL_URL` are extra variables. The internal API has its own listener (see above).
- `updateDeckFn` is replaced by `setStarredFn`, because the title now syncs through the document. `pushDeckUpdateFn` is removed, because a push outside the live document would bypass the collab service. `getDeckStateFn` stays, for the present route only.
- `smoke.mjs`: the login URL matcher now accepts a `?redirect=` query. The unauthenticated redirect now carries a return URL, which the plan asked for. Nothing else in the smoke test changed.
- No collab container: `compose.yml` documents it, and a Dockerfile is a follow-up. See the gaps.
- The title bar's status text reads "All changes saved" (it had "in Sleid" in M1b), and "Saving…", "Connecting…", "Offline — changes will sync" and the denial text are added.

**Known gaps and limitations (decisions to revisit).**
- **Restricted does not remove people who joined through the link.** A redeemed link adds a membership row, and restricting the link does not remove it. The owner removes those people in the people list. A `via` column on `deck_members` would fix this and is a decision for you. **Resolved in M5** (`deck_members.via`, see M5).
- **Mid-session role changes are enforced on the server, but the editor UI keeps its role until reload.** After a downgrade, the server refuses the user's writes, but their local edits still show, and the status stays "Saving…" until reload. After an upgrade, the UI stays read-only until reload. If the internal API is down, the change applies on the next connect.
- **Rich text is last-writer-wins per element** (opaque JSON, unchanged from M1b). Two people typing into the same text box at the same time overwrite each other. Upgrade path: a `Y.XmlFragment` per text element bound with `y-prosemirror`. Only `ydoc.ts` and `ops.ts` change, because the rest of the app goes through them. Speaker notes are also a plain string, last-writer-wins.
- **Edits made offline** live in the browser's document until the connection returns. Closing the tab while offline loses them, and the page asks for confirmation when there are unsaved changes.
- **The token is checked at connect.** A live connection stays open past the token's five-minute expiry. Role changes are re-checked by `revalidate`, but a token expiry is not enforced on live connections. The provider reconnects with a new token.
- **Presence colours and cursors are client-chosen.** Identity is stamped by the server; the rest is not checked.
- **Present reads the persisted state** (`getDeckStateFn`), so it can miss the last ~2 seconds of live edits. **Resolved in M7:** present and presenter now read the live document through the collab service when it is up (see M7).
- **Single collab process.** The per-document state vectors live in memory. Two collab processes on one deck would each store, which is not supported.
- **No email for invites.** Pending invites appear when the invited address signs in.
- **Dashboard titles** come from the database at page load. They lag the document by up to ~2 seconds.
- **Commenter UI** is read-only, the same as viewer. **Resolved in M7:** commenters get the Commenting badge and can comment.
- **Viewers see the people list** in the share dialog (without invite controls or tokens).
- **Store of an unparseable deck** is logged and kept (see above).
- **Undo** still merges nothing across users: a local undo can overwrite a remote change to the same key, as in M1a.
- **Compose:** no collab container or Dockerfile. Run `pnpm dev`.

### M2 verification

Run on this machine: macOS, Node 24.14, pnpm 10.4.1, Postgres 17 (compose, 127.0.0.1:5433), Google Chrome through `CHROME_PATH`. The dev servers ran with `SLEID_TEST_AUTH=1`.

- `pnpm typecheck`: exit 0 in every workspace.
- `pnpm test`: **15 files, 153 tests, all passing, none skipped** (the database was reachable). M1b had 10 files and 111 tests. The new coverage is:
  - `packages/db`, 5 files: collab tokens (sign and verify, expired, wrong deck, tampered payload and signature, wrong secret, malformed, invalid claims, short secret); role gating and the no-downgrade helpers; `deck-doc` persistence (first snapshot, append with title sync, compaction at the threshold, copy); sharing against Postgres (concurrent grants, invite waiting and acceptance with mixed case, existing-account invites, owner and editor never downgraded, link redemption, expired and revoked links, restricted, token kept on a role change, owner row immune to member operations, stars per user); the 0001 migration on a scratch database (the star reaches every member, `decks.starred` is dropped).
  - `apps/collab`, integration against an in-process Hocuspocus on random ports, real Postgres, and `ws` clients: two editors converge after concurrent ops; a viewer's update is refused on the server and the server state is unchanged; an internal ops call reaches a connected client, returns per-op results, and is stored; a bad op rejects the whole batch with its index; the internal API refuses a wrong secret, a bad id and an unknown deck; a live change is stored and a reload equals it; an editor update that breaks the deck is refused and the connection closes; wrong deck, expired, bad signature and non-member are denied with their reasons; revalidate downgrades an editor in place and closes a removed member; presence shows the authenticated identity.
  - `apps/web`: `safeReturnPath`.
- Mutation check: with the awareness identity stamp disabled, the spoof test fails; with it on, it passes.
- `pnpm --filter @sleid/web build`: exit 0. The client bundle contains no `drizzle-orm`, `postgres`, `node:crypto`, `COLLAB_*` secrets or `DATABASE_URL`. Warnings are the same chunk-size ones as M1b.
- `apps/web/tests/smoke.mjs` (single user, through the collab service): **passed**, no page or console errors.
- `apps/web/tests/collab.mjs` (two browsers, plus a third for the viewer): **passed**, no page or console errors. It covers:
  - A creates a deck, titles it, invites B's email as editor (pending), sets "Anyone with the link: viewer", and sees the share link.
  - B signs up and finds the deck under "Shared with me". B's avatar and A's avatar appear on each other's screen.
  - A moves the title box: B sees it within 10 ms in the last run. B adds a slide: A sees it within 10 ms. A sees B's cursor on the canvas. The target was 3 s.
  - B goes offline and sees "Offline — changes will sync". B moves the title box, comes back online, and A receives the move.
  - A signed-out visit to the link goes to `/login?redirect=…`.
  - C opens the link and sees "View only". The title is read-only. The toolbar insert buttons, Undo and Insert > Text box are disabled. Delete and Backspace change nothing.
  - A forced write from a Node client with a valid viewer token: the server reports the connection as `readonly`, the server title is unchanged, and A's title is unchanged.
  - Screenshots: `share-dialog.png`, `collab-A.png`, `collab-B.png` (saved under `SCREENSHOT_DIR`). I looked at them. They show the colour-coded outline with the name, the remote cursor, the slide dot, the avatars and the share dialog.
- Playwright timing: the first run failed on two timing problems in the test, not the product: a dashboard reads titles at load, and a remote cursor appears only on the same slide. The fixed test reloads until the stored title shows. Neither change touched the product code.

### Unverified in M2

- Real Google sign-in (still unverified, as in M0).
- Restricted and link revocation in a browser (the database logic is tested, and the browser path is not).
- A commenter in a browser (the logic is shared with viewers, and only viewer is exercised end to end).
- A role change mid-session in a browser (the server path is covered by the integration test).
- Two people typing into one text box at the same time, in a browser.
- Remote selection outlines are checked by screenshot, not by an assertion.
- Behaviour with more than two or three collaborators, and snapshot growth under sustained editing.
- Firefox and Safari. Chrome only.
- Production serving (`node .output/server/index.mjs`) and a deployed collab service.
- The collab container image (not built).

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
- **Google Slides**: Google Picker, then Drive export as PPTX, then the PPTX path. (Built in M8, see below; a public link is also supported, and it is the first path built.)
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

### What M3 built, and decisions taken while building it

Scope: the export worker (`apps/worker`), asset storage, the job queue, publish to web, and the editor's File ▸ Download. The packages are `packages/pptx` (was a placeholder), plus two new small ones, `packages/storage` and `packages/jobs`.

**Layout.**
- `packages/storage` (`@sleid/storage`): a `StorageDriver` interface (`put`, `get`, `delete`), a local-disk driver (temp file and rename, keys checked against a strict pattern, no `..`), and an S3 stub that throws on construction. `resolveDataDir` resolves relative `ASSET_DIR` and `EXPORT_DIR` against the repository root, so the web app and the worker agree on where files are.
- `packages/jobs` (`@sleid/jobs`): a thin wrapper over pg-boss `^12.35.0` (the untumu range; 12.38.0 is installed). One queue, `export-deck`, with no retries: an export failure is written to its row, not retried. `createJobQueue` takes a `queueName` option, which only the tests use.
- `packages/pptx` (`@sleid/pptx`): `deckToPptx(deck, { resolveAsset, rasterizeDiagram })`. pptxgenjs writes the file, then JSZip post-processes each slide part.
- `packages/db` gains `assets`, `exports` (the table keeps its name, and the TypeScript symbol is `exportJobs`) and `decks.published_token`, `published_at`, `published_indexable`. Migration `0002_new_rogue.sql` is generated by drizzle-kit and applied locally.
- `packages/db/src/export-spec.ts` is pure (zod plus file naming), with its own subpath `@sleid/db/export-spec`, so the editor can import types from it without pulling in the database code.
- `packages/db/src/deck-read.ts`: `readDeck` reads the live document from the collab internal API and falls back to `loadDeckState` when the collab service is down or does not have the deck. Publish and export both use it.
- `packages/render`: `renderDeckHtml` has three additions. `mermaid` picks a local classic script or the jsDelivr module. `showNotes` (print mode only) enables reveal's `separate-page` notes. Print output has no fragment markup, so reveal makes one page per slide. The same change lets bundle-relative paths (`assets/<name>`) through the image and CSS URL checks. `rewriteAssetRefs` and `collectAssetIds` (in `deck-assets.ts`) map `/api/assets/<uuid>` to bundle paths.
- `apps/web`: `assets.server.ts` routes are thin wrappers over `lib/http-handlers.server.ts`, which takes the database, storage and user id as parameters so the tests can call it directly. Server functions: `startExportFn` (viewer and up), `getExportFn` (the requester only), `getPublishStateFn` and `setPublishedFn` (editor and up), `getPublishedDeckFn` (no sign-in). Routes: `POST /api/decks/:deckId/assets`, `GET /api/assets/:id`, `GET /api/exports/:id/file`, and the public page `/p/:token`.
- `apps/worker`: `index.ts` (entry), `service.ts` (pg-boss handler), `runner.ts` (one job from start to finish; never throws for an export problem), `formats.ts` (one producer per format), `bundle.ts` (copies assets into a per-job temp folder, copies mermaid), `static-server.ts` (serves that folder on 127.0.0.1), `browser.ts` (one Chrome, a context with network blocking).

**Export pipeline.**
- The worker reads the deck through `readDeck`. It asks the collab service first, so it sees the last edits, and falls back to the saved state.
- PDF, PNG/JPG and HTML zip work in a temp folder: `index.html` (or one page per slide), `assets/<id>.<ext>` for the images that belong to this deck, and `mermaid/mermaid.min.js` when the deck has a diagram. Those pages are served from 127.0.0.1 and loaded in Chrome. Other URLs are refused.
- PDF waits for reveal to report ready and for `.pdf-page` to exist, then prints at 1920 px × 1080 px with no margins and `printBackground`. The page count is the visible slide count plus one per slide with notes when notes are on.
- PNG/JPG loads one page per slide and takes a screenshot of the 1920 × 1080 stage. For scale below 1 the viewport is smaller and the device scale is 1, because screenshots at a fractional device scale hung in Chrome during testing. Scale 2 uses device scale 2.
- PPTX reads images through `resolveAsset`. `/api/assets/<id>` is read from storage only if the asset belongs to this deck. Data URLs are decoded. Anything else gets nothing. Diagrams are rasterised by a Chrome page that loads the same mermaid build, at the element's size, at 2× device scale.
- The markdown and JSON formats are produced by the worker too, so the MCP milestone can use them. The editor still makes them in the browser.
- The download route answers only the user who asked for the export. Status 409 means the file is not ready. `Content-Disposition` gives an ASCII fallback and the real name in `filename*`.

**Decisions.**
- **Hidden slides.** PDF, PNG and JPG leave hidden slides out unless the option is set. PPTX keeps them and marks each one `show="0"`, which is how PowerPoint stores a hidden slide. HTML zip keeps them too, since the reveal output marks them with `data-visibility`.
- **Embeds and external images are not fetched.** The brief asked for embeds as PNGs and for no open-internet fetches. Both cannot hold, so embeds get a labelled link box in PPTX, and in PDF and PNG they render as blank frames.
- **Assets.** The `assets.bytes` column holds the size of the stored file. The SVG rule is strict: the upload refuses scripts, event handlers, external entities, foreignObject, iframe, embed and object. The response also carries `Content-Security-Policy: sandbox`. The upload is checked against the file's first bytes, not against the claimed type.
- **Publish.** Publishing while already published keeps the token. Turning it off clears it, so turning it back on issues a new link. The public page reads the live document. A deleted or unknown token gives the same 404 as an unpublished one. `noindex` is the default, and the owner can opt out of it.
- **Worker exports read the live document.** When the collab service is down, the worker reads the saved state and logs that. The saved state can miss the last ~2 seconds of edits, which is the same rule as the present route (M2).
- **Viewers can export.** An export only reads the deck, so viewers and commenters get the same download items. Their exports still go through the same queue.
- **Failure messages.** A job that fails stores a readable message in `exports.error`. The stack trace stays in the worker log. The message names `CHROME_PATH` when the browser cannot start.

### PPTX fidelity (per element type)

Verified means a unit test reads the XML or a render was checked. LibreOffice was used for a visual check of the end-to-end deck only (one chart slide, with the image and the diagram). PowerPoint itself was not opened.

| Element or slide part | Output | Fidelity | Checked |
|---|---|---|---|
| Text box (`text`) | Native text box, runs with bold, italic, underline, strike, colour, size, font and link. Bullets and numbers as paragraph bullets. Alignment and vertical alignment. | High for plain and marked-up text. Line height and letter spacing are not carried over. | XML: text runs, `b="1"`, bullets, hyperlink. Render: the text box on the first slide (LibreOffice). |
| Shape (`shape`) | DrawingML preset: rect, roundRect, ellipse, triangle, rightArrow (arrow), line, star5. Fill and stroke. Opacity becomes fill transparency. Shape text is a text box with the shape geometry. | Good for the presets. Our arrow and star geometries are not the same as PowerPoint's presets, so proportions differ slightly. | XML: each preset present, alpha 50 % for opacity 0.5. Not rendered. |
| Image (`image`) | Native picture. `fit` maps to `contain` and `cover` sizing. Asset and data-URL images are embedded. | Good for asset and data-URL images. `crop` is **not** applied (the full image is placed). External URLs are not fetched and are left out. An SVG is placed as-is and not checked visually. | XML: media part present. Render: the image on the chart slide (LibreOffice). |
| Chart (`chart`) | Native chart part for bar, stacked-bar, line, area, pie, donut and scatter, with theme colours (or the chart's own colours) and the title and legend flags. | Good structure, editable in PowerPoint. ECharts overrides (`echartsOverride`) are not applied. Blank cells become 0. Axis and label styling are PowerPoint defaults with the palette. | XML: one chart part per chart type, value present. Render: the bar chart (LibreOffice). |
| Diagram (`diagram`) | PNG of the Mermaid output, rendered by Chrome at the element's size. If the PNG fails, a placeholder box reads "Diagram could not be drawn" (fixed in M5: it used to write the source). | Matches the Chrome render. Not editable in PowerPoint. | XML: picture present (with a PNG passed in), source text present (without). Render: the diagram on the chart slide. |
| Table (`table`) | Native table. Header row bold, header fill, border colour. Columns share the width equally. | Good. The model has no per-column widths, so columns are equal. Cell text is plain. | XML: table, cell text. Not rendered. |
| Code (`code`) | Monospace text in a filled rectangle. | Plain text only, no syntax colours. | XML: monospace face and lines. Not rendered. |
| Embed (`embed`) | Labelled text box with the URL as a hyperlink. | **Not** an embed. Deliberate, see the decisions. | XML: URL and hyperlink. |
| Speaker notes | Notes slide per slide with notes. | Full. | XML: notes text present. |
| Background | Colour, or gradient reduced to its first colour, or image (from the asset store). Theme background when the slide has none. | Colour and gradient are good. Gradients lose the second stop. Image backgrounds are not in the tests. | XML: solid background present. |
| Hidden slide | Kept, with `show="0"`. | Full. | XML: `show="0"` on the hidden slide only. |
| Transitions, animations and fragments | Dropped. | Not carried over (PowerPoint has its own, which we do not write). | — |
| Rotation | `rotate` on each element. | Unverified. | — |
| Fonts | The first family of each stack. Generic names map to Arial, Georgia or Consolas. Inter is not embedded. | If the font is missing on the machine, PowerPoint substitutes one. | — |
| Units | 1920 px = 13.333 in (6349.84 EMU per px). 1 px = 0.5 pt. | Positions checked within 20 EMU. | XML: x, y, cx for two elements. |

### Deviations from the plan

- **Embeds** are a labelled link in PPTX and blank frames in PDF and PNG (not PNG renders). Reason: the open-internet block.
- **Hidden slides** are kept and marked hidden in PPTX (the brief said skip them). PDF, PNG and JPG skip them unless asked.
- **Fonts** are not bundled for exports. Reveal and the theme use the family names; Chrome falls back to the system fonts. Mermaid is bundled.
- **Asset storage.** The `assets` table has a `bytes` column for the size, and the brief did not say which meaning it wanted. The S3 driver is a stub that refuses to start.
- **`exports.file_key`** is the export id, and the file name is in its own column. The brief's "asset path" was not specific.
- **Worker shares the collab internal secret** (`COLLAB_INTERNAL_SECRET`). Without it, the worker reads the database only.
- **The worker is not in compose.yml** (no container image yet, as with the collab service).

### Known gaps and limitations (decisions to revisit)

- **Nothing deletes files.** Deleting a deck removes its `assets` rows (cascade) but not the files under `ASSET_DIR`, and no export file is removed. Storage grows. A sweep job is a follow-up.
- **No quotas or rate limits** on uploads or on export requests.
- **Stuck exports.** The row goes to `running` when the worker starts a job. If the worker dies mid-job, pg-boss expires the job but does not touch the row, so the row stays `running` and the editor shows "Exporting…" until a reload shows the same state. Not tested. A reaper is a follow-up.
- **Upload size.** The body is read before the size check, so a request with no `Content-Length` can use memory up to the request limit. The limit is 10 MB plus form overhead when the header is present.
- **Images from external URLs** are blank in every export. The brief's "no open internet" rule is the reason.
- **Crop is not exported** to PPTX, and charts lose ECharts overrides there.
- **Export options are not in the MCP tool yet.** The worker supports markdown and JSON for MCP, but no MCP tool calls the worker.
- **Single worker process.** Two workers would both run jobs (pg-boss handles the claim), which is fine, but there is no progress reporting, only queued, running, done and failed.
- **Publish** does not rate-limit, and the public page loads the deck JSON through the server (no CDN caching).

### M3 verification

Run on this machine: macOS, Node 24.14, pnpm 10.4.1, Postgres 17 (compose, 127.0.0.1:5433), Google Chrome through `CHROME_PATH`, LibreOffice (`soffice`) for the PPTX render, and `sips` for the PDF renders. The dev stack ran with `SLEID_TEST_AUTH=1`, and the worker ran with the same `.env` and secrets.

- `pnpm typecheck`: exit 0 in every workspace.
- `pnpm test` (root, with `CHROME_PATH`): **22 files, 197 tests, all passing, none skipped.** M2 had 15 files and 153 tests. Without `CHROME_PATH`, the five browser-dependent worker tests skip with a message, and the rest pass.
  - `packages/storage` (6): round trip, missing key, key validation and escape refusal, the S3 stub, data directory resolution.
  - `packages/pptx` (8): one part per slide, text runs, bullets, hyperlink, notes, media, hidden `show="0"`, EMU positions, the 16:9 layout, all seven chart types, tables, code, embeds, shape presets with opacity, diagrams with and without a PNG, px to pt.
  - `packages/render` (37, existing): unchanged apart from the new options; the mermaid tooltip rule is emitted only for decks with diagrams.
  - `packages/db`: export spec (schema defaults, rejections, file names, `Content-Disposition`), publish (token issue and keep, unpublish, indexing flag, deleted and short tokens), deck read (live, fallback on error, fallback on 404). The M2 suites still pass.
  - `apps/web` (http-handlers, against Postgres): upload by role (viewer 403, non-member 404, anonymous 401), size 413, mime 415, byte mismatch 415, SVG with active content 415, empty file 400; read by role and publish state; SVG with `Content-Security-Policy: sandbox`, exact `content-type`, `nosniff`; export download only for the requester, 409 before done.
  - `apps/worker` (integration, pg-boss on its own queue, Postgres, real Chrome): JSON and Markdown; PPTX re-opens with 2 visible plus 1 hidden slide, chart and media present, hidden `show="0"`; HTML zip has `index.html`, the bundled image, 3 sections and no CDN URL; PDF has 2 pages (hidden slide skipped), 1440 × 810 pt; PDF with notes has 3 pages; PNG zip at scale 0.5 has 960 × 540 images; a single PNG at scale 1 is 1920 × 1080; a missing slide fails with "That slide is not in the deck".
- `pnpm --filter @sleid/web build`: exit 0.
- `apps/web/tests/smoke.mjs` (single user): **passed**, all steps including the present view.
- `apps/web/tests/collab.mjs` (two browsers plus a viewer): **passed**, all steps.
- `apps/web/tests/export.mjs` (new, against the dev stack with the worker): **passed**, 21 checks. It built a deck with text, a bar chart, an uploaded PNG and a Mermaid diagram. It exported PDF (options dialog) and PPTX from File ▸ Download, and the downloaded files were checked (PDF header and 2 pages; PPTX re-opens with 2 slides, a chart part and a media part, and the text run). It published the deck, opened `/p/<token>` logged out (2 slides, the chart, the footer, `noindex`), unpublished it, and got 404.
- Screenshots (under `SCREENSHOT_DIR`, which was the session scratchpad): `export-pdf-1.png` and `export-pdf-chart.png` (rendered from the downloaded PDF with `sips`), `export-pptx-1.png` and `export-pptx-2.png` (LibreOffice render), `publish-public.png` (the public page). The chart page shows the native chart, the uploaded gradient image and the Mermaid diagram. The image overlaps the chart because the editor centres both inserts on the same spot. That is the test deck's layout, not an export problem.

### Unverified in M3

- **Opening the HTML zip from `file://`** in a browser. The check was the file contents only (no CDN URL, sections present). Classic scripts should load from `file://`, but this was not clicked through.
- **Blocking of external requests** is implemented with a Playwright route (`context.route`) and is not asserted by any test. No export was run with an external URL to confirm the request is refused.
- **PowerPoint.** The file was re-read by JSZip and rendered by LibreOffice. It was not opened in PowerPoint or Keynote, so strict-validation issues are not ruled out.
- **Fonts** in exports depend on the machine.
- **Real Google sign-in** (still unverified, as in M0).
- **Larger decks.** The tests use a 3-slide fixture and a 2-slide deck. Export time and memory for 50+ slides with images were not measured.
- **Scale 2 PNG** was not run. Scale 0.5 and scale 1 (single slide) were checked by pixel dimensions in the integration test.
- **The public page with the collab service down** uses the same fallback as exports (`readDeck`, unit-tested). It was not run in the browser.
- **Firefox and Safari.** Chrome only.
- **The production build** (`node .output/server/index.mjs`) and a deployed worker. Only the dev stack was run.
- **The worker container image** (not built, as with collab).

### What M4 built, and decisions taken while building it

Scope: `packages/llm` (was a placeholder), the `llm_providers` and `llm_usage` tables, the settings page, the assistant panel, the fx-bar Ask AI, the Tools items and the text context menu. No live model was available, so every adapter is tested against fake HTTP servers, and the live runs are listed as unverified.

**Layout.**
- `packages/llm` (`@sleid/llm`, server-side only). `types.ts` (the `LlmProvider` interface: `generate` and `stream`), `errors.ts` (typed `LlmError`, `redact`), `retry.ts`, `http.ts`, `json.ts` (repair), `structured.ts`, `secret-box.ts` (AES-256-GCM), `contrast.ts`, `layout-guard.ts`, `mermaid.ts`, `context.ts` (deck context and the untrusted-data rules), `ops-check.ts` (allowlist and deck check), `factory.ts`, `adapters/` (`foundry-claude.ts`, `openai-chat.ts` (shared core), `azure-openai.ts`, `openai-compatible.ts`), `abilities/` (one file per ability, `common.ts`, `index.ts` (registry and allowlists), `chat.ts`), `testing.ts` (a scripted provider for tests). `@sleid/llm/testing` exports the scripted provider.
- `packages/db`: `schema/llm.ts` (`llm_providers`, `llm_usage`, two enums) and `llm.ts` (queries). Migration `apps/web/drizzle/0003_llm_providers_and_usage.sql`, generated by drizzle-kit and applied locally.
- `apps/web`: `lib/llm-config.server.ts` (env), `lib/llm-settings.server.ts` (provider rules, resolution, test), `lib/llm-settings.functions.ts` (server functions, no key in any response), `lib/ai.server.ts` (role check, rate limit, deck load, alt-text images, usage), `lib/ai.functions.ts` (`runAbilityFn`), `lib/ai-chat.server.ts` and the route `routes/api/decks/$deckId/ai/chat.ts`, `routes/_authed/settings/ai.tsx`. Editor: `components/editor/assistant.ts` (hook and NDJSON reader), `AiPanel.tsx`, `AiMenus.tsx` (Ask AI, rewrite, Tools items, theme dialog); `EditorShell`, `SidePanel`, `Chrome` (fx bar), `MenuBar` (Tools), `Canvas` (context menu) and `actions` (preview block) changed.

**Providers.**
- **Claude on Foundry** uses `@anthropic-ai/foundry-sdk` pinned to **1.1.0** and `@anthropic-ai/sdk` pinned to **1.3.0**, the versions papereview has installed (its ranges are `^1.1.0` and `^1.3.0`; the newest published releases at install time were 1.1.1 and 1.4.0). The client is built the same way as papereview's `llm.server.ts`: a bare resource name, or the portal URL normalised to `.../anthropic/`, and the key in `x-api-key`. The SDK's own retries are off (`maxRetries: 0`), so one retry policy covers every adapter. The SDK sets `name` to `Error` on its error subclasses, so errors are mapped by constructor name. `temperature` is not sent to Foundry (papereview found the Opus 5.x line rejects it).
- **Azure OpenAI** is plain fetch to `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`, with the `api-key` header.
- **Local models** (`openai-compatible`) take a base URL that ends in `/v1` and an optional bearer key. Ollama, LM Studio, llama.cpp and vLLM all use this path.
- Structured output has three modes: `json_schema` (`response_format`), `tools` (one forced function call) and `prompt` (JSON-only, in the system prompt). `auto` tries `json_schema` first, then the fallback (`prompt` for local servers, `tools` for Azure). A 400 that says the mode is unsupported moves to the next mode, and the choice is kept for that provider instance. Foundry uses one forced tool whose `input_schema` is the schema.
- **Local reasoning models** (M4 live fixes): see "Reasoning models and streamed structured output" below. Structured calls to `openai-compatible` servers stream by default (`streamStructured`); Azure keeps plain calls.
- Every adapter applies a timeout, honours the caller's `AbortSignal`, retries 429 and 5xx at most twice (502 and 504 once only, M4 live fixes; honouring `Retry-After`), and maps failures to `auth`, `rate-limit`, `bad-request`, `network`, `timeout`, `server`, `invalid-output` or `aborted`. Messages run through `redact`/`scrubError` with the request's secrets, and nothing in `packages/llm` logs.

**Structured output (`structured.ts`).** One call. The reply is parsed after repair: the literal text, then the text without fences, then the first balanced `{...}`, each also without trailing commas. A reply that fails validation gets one corrective request that includes the zod issues. A second failure is `LlmError('invalid-output')`. Compact mode strips `description`, `title`, `examples` and `default` from the JSON Schema, which is what small local models need. Abilities keep their schemas; "fewer optional fields" is not automated.

**Abilities, prompts and op allowlists.** Every prompt is built in its ability file from `ROLE` and `SAFETY_RULES` (`abilities/common.ts`, `context.ts`) and a task sentence. The chat system prompt and the tool descriptions are `CHAT_SYSTEM` and `CHAT_TOOLS` in `abilities/chat.ts`. The allowlist is `ABILITY_OPS` in `abilities/index.ts`, and a test pins it.

| Ability | Ops it may propose | What the model returns | Built by code |
|---|---|---|---|
| `rewriteText` (improve, shorten, expand, formal, casual, translate, fix-grammar, bulletize, custom) | `updateElement` | `{ paragraphs[] }` | Rich text from paragraphs (bullet list for bulletize). The model never writes rich-text JSON. |
| `generateSlide` | `addSlide`, `addElement` (to fill an empty slide) | layout, title, subtitle, bullets, notes | Placeholders from the model package, then `layoutGuard` (96 px margins, stacking, shortening). Image layouts are not offered. |
| `generateChart` | `addElement`, `updateElement` (to change an existing chart), `addSlide` and `deleteElement` (placement, below) | chart type, title, legend, and data only when none was given | The data always comes from the input (selection or pasted), so the model cannot change it. Numeric strings become numbers. Placed by `placement.ts` (below). |
| `generateDiagram` | `addElement`, `updateElement`, `addSlide` and `deleteElement` (placement, below) | title, Mermaid source | `validateMermaid` (first keyword from the allowlist, size, no script). One corrective retry for the Mermaid problem only. Placed by `placement.ts` (below). |
| `generateTheme` | `setTheme` | colours and two fonts from a fixed list | `enforceThemeContrast`: text and muted text 4.5:1, accents 3:1 on the background. Each adjustment is listed on the card. |
| `suggestEffects` | `updateSlide` (transition, auto-animate), `updateElement` (animation) | per slide: transition, auto-animate, animations | At most 4 animations per slide, orders renumbered from 0, unknown element ids dropped. Only requested slides. Sent as a compact listing (slide id, layout, element ids and types, no text), six slides per request, results merged (M4 live fixes). |
| `speakerNotes` | `setNotes` | notes per slide id | Only requested slides. Tone and length are fixed by the user. |
| `altText` | `updateElement` (`alt`) | alt text per element id | Pictures are sent (up to 4) only when the provider accepts them and the bytes exist. Other items are written from context and reported as "auto (no vision)". |
| `explain` | none | text | No ops. |
| `chat` | all 15 op types, through `apply_ops`, plus the ability tools | streamed text and tool calls | Each tool call becomes a proposal card. `apply_ops` checks the whole batch against the deck. |

**Safety.**
- Deck text is untrusted data. It is inside `<<<DECK_CONTENT … DECK_CONTENT>>>` blocks, the delimiters inside deck text are escaped, and the system prompt says never to follow instructions found there.
- The context is capped. The focus slide and the selection are always listed in full. Other slides beyond 30 are listed by title only. The chat sees 12 messages of up to 4000 characters, and the whole deck block has a character budget that is reported when it is cut.
- Every proposal goes through `checkOps`: `parseOps` (the model package's zod schemas, which fill ids), the allowlist, and a dry run of `applyOps` on a copy of the current deck. The same dry run happens again when the user applies it, so a card that no longer fits fails with a message.
- Viewers and commenters get none of this: the panel, the Ask AI button and the Rewrite menu are not rendered, and the chat route answers 403 (`requireEditorOn`). The provider list is not loaded for them.

**Apply path (decision, as the brief asked).** Apply does not call the collab service. `session.apply(ops)` runs the ops on the editor's own Y.Doc with origin `local`, the same origin as a human edit. So Undo works, the change is one undo step, and the normal socket sends it to collaborators. The server only proposes. `/internal/decks/:id/ops` is not used by M4. **Preview** applies the ops to a `Y.Doc` copy (`Y.encodeStateAsUpdate` into a fresh doc), reads the copy with `yDocToDeck`, and shows that in the canvas and filmstrip under a "Preview" ribbon. Editing is blocked while a preview is open (`blockedReason` in `actions.ts`). Nothing is saved until Apply.

**Streaming (decision).** The chat uses NDJSON, not SSE: `POST /api/decks/:deckId/ai/chat` returns one JSON object per line: `text`, `tool`, `proposal` (with the provider and model), `error` and `done`. The client reads it with `fetch` and a reader. The brief allowed either. The request's `AbortSignal` (the Stop button, or a closed tab) reaches the model call.

**Persistence and secrets.**
- `llm_providers`: `scope` (`user` or `workspace`), `owner_id` (set for user providers), `name`, `kind`, `config` (jsonb, no secrets: endpoint, API version, structured mode, image flag), `secret_ciphertext`, `default_model` (the model, or the deployment name for Azure), `is_default`, `created_at`. Two partial unique indexes allow one default per user and one workspace default.
- Keys: AES-256-GCM with `node:crypto`. The key is `LLM_SECRET_KEY` (32 bytes, base64). The format is `v1:<iv>:<tag>:<ciphertext>`, with a fresh 96-bit IV per value. A wrong key and a tampered value give the same message, which does not reveal the key. Rotation is not supported.
- Keys are write-only. A save with an empty key keeps the stored one. The list, save and test responses carry `hasSecret` and never the key. A test checks the serialised JSON. A key is also kept out of error messages (`scrubError`) and out of request bodies (checked in the browser check).
- Visibility: a user sees their own providers and the workspace ones. Only administrators (`ADMIN_EMAILS`, compared case-insensitively) can save, edit or delete workspace providers.
- A deployment default (`SLEID_LLM_*`) is listed as "Server default", is never editable, and is used when the user has no default of their own.
- Resolution order when a request names no provider: the user's default, the workspace default, the server default. A request for a provider the user cannot see is refused.
- `llm_usage`: one row per assistant run (`ability`, `ok`, tokens, latency, provider). A chat request writes one row for its whole turn sequence. The rate limit counts these rows, so a failed request also counts. The count and the insert are not atomic, so a burst of concurrent requests can pass the limit by the number in flight. Defaults: 30 requests per 600 seconds (`AI_RATE_LIMIT_MAX`, `AI_RATE_LIMIT_WINDOW_SECONDS`).

**Editor UX.**
- AI tab in the side panel (editors and owners only). It has a provider picker (default preselected), the conversation, and proposal cards. A card shows its change count, the provider and model, the tokens and any warnings, with Preview, Apply and Discard. Failed single-purpose runs have "Try again". Chat history is kept only in the page.
- fx bar **✨ Ask AI** (enabled for editors): a text box gets Rewrite (the modes) and Translate or custom instruction; a chart gets Change to… (any type), Change… (instruction) and Explain; a diagram gets Change diagram; an empty slide gets Fill this slide; with nothing selected, Generate a new slide from a prompt.
- Right-click on a text box: Rewrite ▸ the same modes.
- Tools ▸ AI assistant (opens the panel), Generate speaker notes, Suggest transitions & animations, Write alt text for images, Generate theme… (a dialog with a prompt and brand colours). The four Tools actions work on the current slide and up to seven after it (eight slides; alt text covers the images, charts and diagrams on them, up to 30 elements).
- Settings › AI (from the dashboard): list, add, edit, delete, make default, and Test connection (one short request, which reports OK with the model and latency, or the reason it failed). The page shows "Key: ••••• set".

**Deviations from the brief.**
- **Pasted chart data** is accepted by the ability (`data`), but no UI or chat path offers a paste box. Not done.
- **`logoColors`** for the theme is not implemented, because the model has no logo yet.
- **Chart "add series"** is not a separate action. "Change to…" and the instruction prompt cover it.
- **Rate limit** is a sliding window count in the database, not a token bucket (the brief gave the window as an example).
- **Tools actions** cover up to eight slides, not the whole deck, so one request stays within a sensible output size.
- **Chat `apply_ops`** may propose any of the 15 op types, including deletes. That is intended, because the chat is the user's own request, and each proposal is a card the user must apply. The allowlist is not narrowed for chat.
- **Foundry**: no temperature is sent (see above).
- **Compact schemas** strip descriptions only. The schema itself is not reduced.
- **Dependency versions** are pinned to papereview's installed SDK versions (see above), not to the newest published ones.

**Known gaps and limitations (decisions to revisit).**
- **Stale proposals.** A proposal is computed against the deck when it is requested. If someone edits the same text before Apply, the apply overwrites that edit (the ops do not compare old values). A card whose targets are gone fails with a message instead.
- **Undo during a preview** is allowed (the undo keys are not blocked), and the preview does not refresh. Discard it, or apply again.
- **Alt text without vision** is marked in the summary and the warnings only. The alt string itself does not say so.
- **Pictures for alt text** come from uploaded assets and `data:` URLs only. External URLs are not fetched, as in M3.
- **Usage for streamed local replies** without a usage frame is estimated (characters divided by four), and is flagged `estimated`.
- **Structured mode memory** lives in the provider instance. After a restart, the first call on a server that refuses `json_schema` tries it again.
- **Streams are not resumed.** A connection that drops mid-reply shows an error, and the user asks again.
- **Chat history and proposals** are not stored. A reload starts a new conversation.
- **One server-default provider** is supported (`SLEID_LLM_*`).
- **The model output is not reviewed** beyond the checks above. Wording, factual claims and chart numbers (when proposed by the assistant) need the author's review. The card warns for proposed chart data.

### M4 security fix: endpoint policy (SSRF)

**Problem.** Provider endpoints are chosen by the user, and the server fetched them. A user provider could point at `127.0.0.1:3002` (the collab internal API), Postgres, a dev server, a private network, or cloud metadata (`169.254.169.254`, `fd00:ec2::254`). Error messages could echo the response body back to the user.

**Decisions.**
- **One policy module.** `packages/llm/src/url-policy.ts`. `assertAllowedEndpoint(url, { allowPrivate }, lookup)` checks the scheme (http or https only), refuses credentials in the URL, and accepts any port. It resolves the host with `dns.promises.lookup(host, { all: true })` (an IP literal is not resolved) and refuses the endpoint if **any** address is refused. Refused: loopback, private (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), unspecified (0.0.0.0/8 and `::`), multicast, broadcast, reserved (240/4, documentation and benchmarking ranges, 2001:db8::/32, Teredo 2001::/32), and unique-local (fc00::/7). The embedded IPv4 of an IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible, NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) address is judged on its own. Those forms were added beyond the brief, because each one is a way to reach the same IPv4 address.
- **Always refused, even with `allowPrivate`:** link-local (169.254.0.0/16, fe80::/10) and the metadata address `fd00:ec2::254`.
- **Pinned connection (DNS rebinding).** `createPinnedFetch(policy)` checks the URL and then sends the request through an undici `Agent` whose `connect.lookup` returns only the vetted addresses. The Host header and TLS server name stay the original host name. The lookup is not repeated for the connection. Every adapter request uses the pinned fetch, and the Foundry SDK gets it as its `fetch` option. `redirect: 'manual'` is set, and a 3xx answer is an error (`bad-request`, "answered with a redirect"), so no redirect is followed.
- **Scope policy** (`networkPolicyFor` in `apps/web/src/lib/llm-config.server.ts`):
  - a **user** provider: `allowPrivate` is `LLM_USER_ALLOW_PRIVATE_URLS === '1'`, and the default is off;
  - a **workspace** provider (administrators only) and the **server default** (`SLEID_LLM_*`): `allowPrivate` is true.
  - Every scope refuses the always-refused addresses.
- **When the check runs.** On save (create and update), and before every request in `resolveProvider`, because DNS and the flag can both change after a save. A provider saved while the flag was on is refused once the flag is off, and the test shows it.
- **What the user sees.** For a user provider, a failure shows only the status (`The provider answered HTTP 401 Unauthorized. Check the API key.`), from `publicMessage` in `packages/llm/src/errors.ts`. Network and timeout failures show a fixed message, because the detail (`ECONNREFUSED 127.0.0.1:3002`) would show which ports answer. Messages from our own checks (no status) keep their text. Workspace and server-default providers keep the provider's text, with the key removed, because an administrator set them up. The full detail (kind, status, scrubbed text, truncated to 500 characters) goes to the server log as `[assistant] provider failed`. The chat stream and the ability path both use this (`AbilityEnv.hideDetails` and `onFailure`).
- **Tests stay hermetic.** `SettingsDeps.lookup` replaces DNS in the web tests. The existing fake-server tests run with the flag on, because they use 127.0.0.1, and the policy tests turn it off explicitly. The policy itself is not changed for them.

**Checks.** `packages/llm/src/url-policy.test.ts` (73 tests): the class table for IPv4 and IPv6 (every written form, zone ids, mapped, compatible, NAT64, 6to4), numeric host forms (`2130706433`, `0x7f.0.0.1`, `0177.0.0.1`), the scheme and credential rules, host names through a stubbed resolver (one private address among public ones is refused, `localhost` is refused without a lookup), the pinned fetch against a local server (it connects to the vetted address, a second lookup cannot redirect it, a refused address never connects, a redirect is returned and not followed, a streamed body stays readable, the OpenAI-shaped and Foundry adapters work through it). `apps/web` settings tests: 127.0.0.1:3002 refused for a user with the message, a private host name refused unless the flag is on, metadata refused for every scope, a workspace provider on a private address allowed without the flag, the policy re-checked on each request, the environment default checked. The browser check (`apps/web/tests/ai.mjs`) runs with `LLM_USER_ALLOW_PRIVATE_URLS=1` on the dev server, because it adds the fake server on 127.0.0.1 as a user provider.

**Residual risk.** With `LLM_USER_ALLOW_PRIVATE_URLS=1`, a user can still probe a private network by timing the responses (a refused connection and a timeout look different, even with the fixed messages). Keep the flag off on a server that more than one person uses.

**Built-in theme (pre-existing finding).** Warm Paper's `accent3` was `#c9962b`, 2.47:1 on its background. It is now `#b48627` (3.055:1), the nearest shade that keeps the hue (40 degrees, from the same `ensureContrast` search the generated themes use). The contrast test now asserts that every built-in theme passes the AI-theme rules with no adjustment.

### M4 verification

Run on this machine: macOS, Node 24.14, pnpm 10.4.1, Postgres 17 (compose, 127.0.0.1:5433), Google Chrome through `CHROME_PATH`. The dev stack ran with `SLEID_TEST_AUTH=1`, `COLLAB_TOKEN_SECRET`, `COLLAB_INTERNAL_SECRET` and a scratch `LLM_SECRET_KEY` passed in the environment (not written to `.env`). The fake model server is `apps/web/tests/fake-openai-server.mjs`, started by `tests/ai.mjs`.

- `pnpm typecheck`: exit 0 in every workspace. `tsc --noUnusedLocals --noUnusedParameters` is clean for `packages/llm`, `packages/db` and the M4 files in `apps/web`. Two findings predate M4 and were left alone: an unused `useMemo` import in `EditorShell.tsx` and an unused `a` in `MenuBar.tsx`.
- `CHROME_PATH=… pnpm test` (root): **36 files, 335 tests, all passing, none skipped.** M3 had 22 files and 197 tests. After the endpoint-policy fix (below): **38 files, 423 tests, all passing, none skipped.** The M4 files are 14 files and 138 tests:
  - `packages/llm` (11 files): contrast (WCAG ratios, shade search, theme enforcement, and the built-in themes); layout guard (margins, stacking, shortening, idempotence); Mermaid (keyword allowlist, comments, fences, script rejection); JSON repair; retry (429 and 5xx at most twice, no retry for other kinds, abort during a wait); secret box (round trip, fresh IV, wrong key, tampering, key format); structured (repair, corrective retry with the issues, typed failure, provider errors pass through, compact schemas); the **Foundry adapter** against a fake Anthropic-Messages endpoint (request shape: model, forced tool, `tool_choice`, `x-api-key`, path under `/anthropic/`, no temperature; 429 with `Retry-After`; 5xx retried twice; 401 once and not in the message or the logs; abort; timeout; SSE stream; picture blocks; tool-use blocks); the **OpenAI-shaped adapters** against a fake `chat/completions` endpoint (Azure URL and `api-key`; `json_schema`; forced tool; the fallback from `json_schema` to tools and to the prompt mode, remembered per instance; 429; redaction of a key echoed by the server; SSE with text and tool deltas; bearer only when a key is set; unreachable server; invalid reply; images only when supported); the **abilities** with scripted replies (each applies cleanly to a fixture deck; the allowlist; the Mermaid retry; the theme contrast fix; suggestions capped at four; notes only for requested slides; alt text with and without pictures; explain changes nothing); **prompt injection** (the deck text reaches the model only in the delimited block, the rules are in the system prompt, a rewrite that tries to delete a slide still yields only `updateElement`, `deleteSlide` is refused by the allowlist, delimiters cannot be closed by deck text); the context budget; the chat loop (tool results return to the model, invalid tool input is reported and the chat continues, `apply_ops` is checked, the step cap, a user message is needed).
  - `apps/web` (3 files, against Postgres): configuration parsing; provider settings (encrypted save, key never in a response, visibility, admin-only workspace providers, key kept on edit, refusal without `LLM_SECRET_KEY`, endpoint checks, one default per user, the server default is read-only, resolution with the stored key sent as the bearer token, Test connection OK and scrubbed on failure, rate limit counts failed requests, editors only); the chat route (401, 400, 403 for a viewer, 400 for a non-member, 409 with no provider, NDJSON with text, a tool call becoming a proposal, one usage row, and a failure line with the key redacted).
- `pnpm --filter @sleid/web build`: exit 0. The client JavaScript contains no `createCipheriv`, `node:crypto`, `foundry`, `LLM_SECRET_KEY`, `DATABASE_URL` or `COLLAB_INTERNAL_SECRET`.
- Browser checks, all against the dev stack, with the final code:
  - `apps/web/tests/smoke.mjs`: **passed**, 22 checks, no page or console errors.
  - `apps/web/tests/collab.mjs`: **passed**, 24 checks, no page or console errors.
  - `apps/web/tests/export.mjs`: **passed**, 21 checks, no page or console errors.
  - `apps/web/tests/ai.mjs` (new): **passed**, 32 checks, no page or console errors. It covers: add the fake local model in Settings › AI; Test connection → "OK · fake-local · N ms"; the key is not in the page; the fx-bar Ask AI makes a slide proposal; Preview shows the slide with the ribbon and the filmstrip shows it; Apply adds it; Undo removes it; Redo brings it back; Ask AI ▸ Shorten replaces the text with the shorter text; a chart from a prompt in the panel; Apply adds the chart; Tools ▸ Generate theme with a brand colour gives "Brand Calm" with the contrast adjustment listed; Apply changes the theme; a second browser (editor) sees the new slide within 143 ms of A's Apply click and sees the theme; a viewer has no AI tab, no Ask AI button and no composer; the chat route answers 403 to the viewer; the fake server received the key only as the bearer token and never in a body; the slide ability used a JSON schema request; the chat used a streamed request.
- Screenshots (under `SCREENSHOT_DIR`, which was the session scratchpad): `ai-settings.png` (the provider list with Test connection OK), `ai-preview.png` (the Preview ribbon, the previewed slide in the canvas and filmstrip, and the card), and `ai-panel.png` (the panel with the applied shorten card, the chart request and its card). I looked at all three.

### M4 live verification and fixes

Run against a real local model: `https://gpt.knowhub.my.id/v1` with `qwen3.8-flash-next-q2_0` (262k context, a reasoning model: each reply has `content` and `reasoning_content`, and `response_format: json_schema` is accepted). The endpoint is behind Cloudflare. The check is `apps/web/scripts/live-llm-check.ts`: the twelve steps (eleven abilities and one chat turn with a tool call), applied to one deck, rendered to `slide-N.png` with Chrome. About 55 live requests were made in total, including the diagnosis (an estimate: the script does not count requests). The first live run (before these fixes) passed 10 of 12.

**What the first live run found.**
- **Placement.** A 1400×700 diagram at (260, 260) covered the title and subtitle of a section slide.
- **Empty answer.** `explain` returned "The assistant returned an empty answer." once. The cause was not confirmed: the same prompt, replayed twice later, returned answers with `finish_reason` `stop`. The fix covers the case where the budget is spent on thinking (see below), but it was not reproduced, so the cause is open.
- **Gateway timeout.** `suggestEffects` (five slides, one request) failed with Cloudflare HTTP 502 after about 61 seconds. It reproduced on a second call.
- **Structured budget.** With streaming on, the server reports a spent budget as an in-stream error frame, not as `finish_reason` `length`: `{"error": {"code": "structured_output_failed", "message": "structured output was incomplete (finish_reason=length); increase the output budget"}}`. It sends `: keep-alive` comment lines while it reasons. The first streamed `suggestEffects` (six slides, 1500 tokens) failed on this twice. Both are handled now.

**Placement (`packages/llm/src/placement.ts`, `abilities/place-element.ts`).** `generateChart` and `generateDiagram` only. (`generateSlide` fills an empty slide, so there is nothing to place around.)
- Obstacles are the non-empty elements, each grown by the 24 px stacking gap. An empty text box (a placeholder with no text) is not an obstacle.
- The safe area is the 96 px margin (1728 × 888). Charts keep 1600:720, diagrams 1400:700. The minimum is 640 × 360.
- First choice: the space below the lowest non-empty element, centred, when the largest box of the aspect ratio that fits there is at least the minimum.
- Second choice: the largest free box anywhere in the safe area, from candidate corners (the safe area's corner and the edges of the obstacles plus the gap). Ties go to the higher, then the more left, box.
- No room: the element goes on a **new slide after the target**, with the `title-content` layout, the ability's title, and the element placed below that title. The warning names both slides ("Slide 4 had no free space for the diagram, so it is on a new slide (slide 5).").
- Empty placeholder text boxes that the new element covers are deleted in the same batch (`deleteElement`). The code deletes only empty text boxes, and a test checks that a non-empty element is never listed.
- **Allowlists.** `generateChart` and `generateDiagram` gained `addSlide` (for the new-slide case) and `deleteElement` (for placeholders only). The brief named `deleteElement`; `addSlide` is needed as well for the new-slide case. A test pins that only these two abilities and `chat` may delete.

**Reasoning models and streamed structured output (`adapters/openai-chat.ts`).**
- `reasoning_content` is never output. When the server reports no usage, the estimate counts it, because it was generated.
- A reply with no content and no tool call that stopped at the length limit (`finish_reason` `length`, or the in-stream error frame above) is retried once at `min(3 × max_tokens, 8192)`, and only if that is larger. Still empty: `LlmError('bad-request', "The model used its whole budget thinking and returned no answer. Raise max tokens or turn off thinking for this provider.")`. It has no status, so it is shown to the user as written, including for user providers.
- The rule applies to the json_schema, tools and prompt modes (through `generate`), and to the plain stream (retried before anything is shown, so the user never sees the first attempt).
- **Thinking controls** are provider options for `openai-compatible` only: `disableThinking` (sends `chat_template_kwargs: {"enable_thinking": false}`) and `reasoningEffort` (sends `reasoning_effort`). Both are off by default and set in Settings › AI. They are sent on the first request. A 400 that names one of them turns them off for that adapter instance, and the request is sent again without them. Not tested against the live endpoint; the live runs used the defaults. The unit tests use a fake server that refuses the parameter.
- **Streamed structured output** (`streamStructured`, default on for `openai-compatible`). A json_schema call sends `stream: true`, collects the content and the error frames, and then parses and validates as before. Keep-alive comments are ignored. An error frame that says the budget ran out is treated as `finish_reason` `length`. Any other error frame is `LlmError('server')` with the key removed. A 400 that mentions streaming turns streaming off for that instance and the call is sent plain. A JSON reply to a streamed request is read as JSON. Azure and Foundry keep plain calls.
- **502 and 504** are retried once. Other 5xx are still retried twice.

**Compact prompts (provider option).** Compact (schemas without descriptions) is `compactPrompts` in the provider config. It is on by default for `openai-compatible` and off for Claude on Foundry and Azure OpenAI, and the settings page shows it. Before this change the same default came from the kind in `ai.server.ts` with no switch. The environment default (`SLEID_LLM_*`) follows the kind default and has no switch of its own. `live-llm-check.ts` passes `compact: true`, which is the openai-compatible default.

**Latency (one live call each, same deck).**

| Step | Before | After |
|---|---|---|
| suggest effects, single call | 61 s, HTTP 502 (failed) | 24 s, ok, 17 ops |
| suggest effects, inside the full runs | 60 s, HTTP 502 (failed) | 56 s (run 2), 41 s (final run), both ok |

**Final live run, 12 of 12 steps ok** (`report.json` in the scratchpad, the same run that produced the renders).

| Step | ms | Result |
|---|---|---|
| generate title slide | 4390 | ok |
| generate content slide | 4834 | ok |
| generate chart | 5172 | ok (warning: the data was proposed by the assistant) |
| generate diagram slide | 4556 | ok |
| generate diagram | 6008 | ok (below the section title, no warning) |
| rewrite shorten | 3942 | ok |
| rewrite translate | 3612 | ok |
| generate theme | 19015 | ok (two colours adjusted for contrast, listed) |
| speaker notes | 12814 | ok |
| suggest effects | 41249 | ok (5 slides, batch of 5) |
| explain | 6460 | ok |
| chat with tools | 11160 | ok (1 proposal) |

Live runs after the fixes were 11 of 12 (suggest effects failed on the in-stream budget error, fixed since), then 12 of 12 (suggest effects 56 s), then the final 12 of 12. In the run before the final one the section slide had a subtitle, so the diagram went to a new slide (slide 5), as designed. In the final run the section slide had no subtitle, so the diagram went below the title.

**Renders (`slide-N.png`, final run).** Each slide was rendered in its own page (the capture was changed for this: a shared page measured Mermaid diagrams on hidden slides as 16 px boxes, and a hash change did not wait for reveal's transitions). I looked at all five slides.
- No element overlaps text. The chart (96, 96, 1728 × 778) and the diagram (580, 604, 760 × 380) are fully on the slide and inside the safe area.
- The chart landed on the deck's default blank slide, which had no content, so it fills the safe area.

**Quality notes (honest).**
- The bakery slide asked for three benefits and came back as one sentence in the body, not bullets. The text is plausible, but a single line does not match the request.
- The diagram is a five-node left-to-right flow with a branch. Mermaid draws it at 980 px natural width, scaled into 760 px, so it is small. Its node labels are in the DOM but do not paint in the Chrome screenshot (empty boxes). This is in the deck renderer (`packages/render`), not in the assistant, and it was not investigated further.
- The chart data is model-proposed (the warning says so). The numbers are plausible; nobody has checked them.
- Theme colours changed between runs, and each change is listed on the card.
- `explain` produced a good answer in both replays. The one empty answer in the first run is not explained.
- The `suggestEffects` latency varies: 24 to 56 seconds for the same kind of call. The cause (a retry at a bigger budget, or long reasoning) is not logged.

**Dev stack (`apps/web/tests/ai.mjs`).** Passed, 32 checks, with the dev server started with `LLM_USER_ALLOW_PRIVATE_URLS=1 SLEID_TEST_AUTH=1`, a scratch `LLM_SECRET_KEY`, and the collab secrets from the environment. The fake server (`apps/web/tests/fake-openai-server.mjs`) now answers a streamed json_schema request with the JSON as content, as the real server does. Before, it answered with a tool call, which the streamed path (correctly) rejected. The servers were stopped afterwards.

**Unit tests.** `packages/llm`: 230 tests in 14 files, including `placement.test.ts` (empty slide, title and subtitle section, title-content with a full body, a slide with only empty placeholders, no deletion of a non-empty element, below-first preference, the beside search, and the minimum size), the placement cases in `abilities.test.ts`, `openai-chat.test.ts` (the length retry, the budget error, the thinking params with fallback, streamed structured output, the stream fallback, the JSON-reply fallback, error frames, 502 once, budget arithmetic), and the suggest batching. `apps/web` settings tests cover the compact default, the saved choice, and the thinking params reaching the server.

**Not done.**
- The thinking controls were not tested live (see above). The live server's support for `chat_template_kwargs` and `reasoning_effort` is unknown.
- The placement applies to `generateChart` and `generateDiagram` only. Chat proposals (`apply_ops`) can still place an element over existing content.
- Environment-default switches for compact prompts and thinking (`SLEID_LLM_*`) were not added.
- No fix for the diagram's labels in the deck renderer.

### M4 Mermaid validation fix

**Problem.** A live run of `generateDiagram` (qwen3.8-flash-next-q2_0) returned `Shop appliances` as a bare node id. The keyword check accepted it, so the slide held a diagram Mermaid could not parse. Present mode and exports then showed raw source or a failed box.

**Decisions.**
- **The real parser.** `validateMermaid(source)` (`packages/llm/src/mermaid.ts`) is async. It runs the size cap, the script check and the first-keyword check, then `mermaid.parse` (mermaid 12.2.0, now a dependency of `@sleid/llm`). It returns `{ ok: true }` or `{ ok: false, message, line? }`. The message is Mermaid's `Parse error on line N: Expecting …`, shortened.
- **DOM shim: happy-dom 21.0.4.** Mermaid's DOMPurify needs `window` when mermaid is imported. Plain Node failed for pie and mindmap (`DOMPurify.addHook is not a function`) and passed for flowchart and sequence. happy-dom made all twelve keyword types parse. It was chosen over jsdom because it has 7 runtime dependencies, against 20 for jsdom 27. jsdom was not tried, since happy-dom worked. The shim is installed only around the one-time `import('mermaid')`, and its globals are then removed. Parsing still works without them (checked), so no global DOM is left in the server process. If the import fails, the keyword check is used alone, with one warning in the log.
- **Timeout and size.** A parse that takes more than 5 s (`MERMAID_PARSE_TIMEOUT_MS`) is an error. The parser is synchronous, so the timeout stops the wait, not the parse; the 6000-character cap bounds the work.
- **Retry.** The first invalid reply gets one corrective request. It carries the parser message, the text of the failing line, and the rules. The system prompt has the rules from the start (`MERMAID_RULES` in `generate-diagram.ts`): node ids are single words; labels go in brackets (`ShopAppliances[Shop appliances]`); edge labels use `-->|label|`; no fences; no HTML; no links or scripts.
- **Auto-repair (`packages/llm/src/mermaid-repair.ts`).** If the retry is still invalid, `repairMermaid` runs once and the result is checked again. If that fails too, the ability throws `invalid-output` with the parser message, and no op is proposed.
- **Fixer scope.** Flowcharts (`graph` and `flowchart`) only. It rewrites a node written as two or more bare words into an id and a label: `Shop appliances` becomes `ShopAppliances[Shop appliances]`, and `B C` in `A --> B C --> D` becomes `BC[B C]`. The same text gets the same id on every line, and an existing `Id[Label]` is reused. Generated ids avoid ids already in use and Mermaid's reserved words. Edge labels (`-->|surplus|`), brackets, quotes, `&`, and statements such as `style`, `classDef`, `click` and `subgraph` are left alone. A line with an inline edge label (`A -- text --> B`) is not touched. Source with nothing to fix comes back unchanged, so repeating the fix changes nothing.
- **Renderer fallback (`packages/render/src/render.ts`).** Each diagram is drawn in its own `try`. When `mermaid.render` throws, that `<pre>` is replaced by `<div class="sleid-diagram-error" data-sleid-diagrams="error">Diagram could not be drawn</div>`, styled with `--sleid-muted`. The source is never shown. The other diagrams are still drawn. The root `data-sleid-diagrams` is `done` once every diagram has been tried, so exports do not wait on a failed one. It is `error` only when mermaid itself cannot load. In that case every undrawn source is replaced too. The module build now imports mermaid inside the `try`, so a failed CDN load also reaches the attribute. Before, the attribute was never set, and the exporter waited out its 60 s timeout. The worker (`apps/worker/src/formats.ts`) logs the number of placeholders.
- **Packaging.** `packages/llm` has `mermaid@^12.2.0` and `happy-dom@^21.0.4`. Adding happy-dom also adds it as an optional peer of `vitest` in the lockfile, so each workspace's vitest entry changed. The runtime is unaffected. The web build bundles happy-dom and mermaid into the server output, and no client code imports `@sleid/llm` at runtime.

**Not done.**
- **PPTX.** Fixed in M5: a failed diagram is a placeholder box, not the source text.
- The parser checks syntax only. A diagram that parses but draws badly is not caught.

**Checks.**
- `packages/llm/src/mermaid.test.ts` (19 cases): thirteen valid samples across the keyword types (flowchart, sequence, pie, mindmap and the rest), the comment and fence cases, script rejection, the length cap, and the live-run sample rejected at line 2 with `Expecting … NODE_STRING`.
- `packages/llm/src/mermaid-repair.test.ts` (12 cases): the live-run sample is repaired and parses; `A --> B C --> D`; the same label on two lines; edge labels kept; existing bracket ids reused; id collisions; semicolon statements; non-node statements and inline edge labels untouched; valid input unchanged; idempotence; non-flowchart diagrams untouched; a fenced input; `Big Box-->Panel` not split.
- `packages/llm/src/abilities/abilities.test.ts` (+2): a scripted model returns the invalid sample, then a valid one. The second request carries the parser message, the failing line and the rules. A scripted model returns the invalid sample twice, and the fixer repairs it. The system prompt carries the rules before the other instructions.
- `apps/worker/src/mermaid-fallback.test.ts` (Chrome, `CHROME_PATH`, skipped without it): the bundled mermaid of the exports draws the good diagram, puts the placeholder where the bad one was, shows no source, marks only the bad element, sets the root to `done`, and uses the muted colour from the theme.
- Live (`apps/web/scripts/live-llm-check.ts`, `LIVE_LLM_STEPS=diagram`): see the table in the M4 section below.

### M4 Mermaid validation: live check

Three runs of the diagram step against `https://gpt.knowhub.my.id/v1` with `qwen3.8-flash-next-q2_0`, from `createDeck` plus one `generateDiagram` call each. Three ability calls and three model requests in total, within the budget of ten. Each run's output was parsed by the new validator, and the renders were checked by eye.

| Run | Model requests | Path | Diagram |
|---|---|---|---|
| 1 | 1 | first reply valid | Sunlight, Panels, Inverter, Shop appliances, Battery with `surplus`. Every label drawn. |
| 2 | 1 | first reply valid | Sunlight, Solar panels, Inverter, Shop appliances, Battery with `surplus`. Every label drawn. |
| 3 | 1 | first reply valid | Sunlight, Panels, Inverter, Shop appliances, Battery with `surplus`. Every label drawn. |

Each reply used the id-and-label form that the new rules ask for. So the retry and the fixer did not run against the live model. Their behaviour is covered by the scripted tests above. The original bare-name failure was not reproduced live, because the rules now prevent it, and the old prompt was not run again to compare. The renders are in the session scratchpad (`live-llm-diagram/run1` to `run3`, `slide-1.png`).

**Checks run.** `pnpm typecheck`: exit 0. `CHROME_PATH=… pnpm test`: **41 files, 481 tests, all passing, none skipped** (39 tracked files and the 2 new ones: `mermaid-repair.test.ts` and `apps/worker/src/mermaid-fallback.test.ts`). `pnpm --filter @sleid/web build`: exit 0; the TanStack `"use client"` warning is still printed, as before.

**Unverified.**
- The built server's validator was not run. The build bundles happy-dom into an SSR library chunk and mermaid into a lazy chunk, and the output was only inspected, not executed.
- The retry and repair paths were not seen against the live model (see above).
- The PPTX fallback is unchanged (see "Not done").

### Unverified in M4

- **The endpoint policy against a live server.** The policy is tested with stubbed DNS and local fake servers. Connecting to a real public host through the pinned dispatcher, and a TLS (`https`) endpoint through it (SNI and certificate checks), were not run. The dev-server e2e ran with the flag on, so the refusal of `127.0.0.1:3002` by a running server was tested only at the settings level, not through the browser.

- **Live Claude on Foundry.** No Foundry credentials were available. The request shape, headers, tool use, errors and retries are tested against a fake Anthropic-Messages endpoint only. The SDK versions are pinned, but the live response was not seen.
- **Live Azure OpenAI.** Same position: the URL, headers and both structured modes are tested against a fake endpoint only.
- **Live local servers** (Ollama, LM Studio, llama.cpp, vLLM). Only one server was run (`qwen3.8-flash-next-q2_0` behind Cloudflare, see "M4 live verification and fixes"). Ollama, LM Studio, llama.cpp and vLLM were not run. The fake endpoint covers `json_schema`, forced tools, the JSON-only fallback, SSE and the thinking-parameter refusal. The LM Studio steps in the README (the Developer tab) are from the app's UI, not checked on a machine.
- **Output quality.** Every reply in the tests and the browser checks is scripted. No real model wrote a slide, a chart, a theme or a note, so the usefulness of the prompts is unverified.
- **Pictures for alt text** with a real vision model. The bytes path is tested with a fake provider only.
- **Rate limit under concurrency** across processes, and the Stop button's server-side abort (the signal is wired and read, but not tested).
- **Firefox and Safari.** Chrome only.
- **Production serving** (`node .output/server/index.mjs`) of the assistant. The build passes; the server was not run.
- **Live multi-user timing** beyond one collaborator and one viewer.

### What M5 built, and decisions taken while building it

Scope: a personal access token (PAT) system, the MCP server at `/mcp`, one-time export links, MCP audit, link-only membership ending on restrict (added during M5), the M4 PPTX fallback fix, and the Extensions menu item. The stdio bridge was not built (see "Not done").

**Layout.**
- `packages/db`: `schema/api-tokens.ts` (`api_tokens`, `mcp_audit`), `api-tokens.ts` (create, normalise, verify, list, revoke, scope and allowlist helpers, audit writes), `export-links.ts` (one-time links), `deck_members.via` and `share_link_id` (schema and grant rules in `sharing.ts`, role rule in `deck-access.ts`).
- Migrations `0004_noisy_domino.sql` (tokens, audit, export link columns) and `0005_link_membership_via.sql` (membership origin, with a hand-written owner backfill).
- `apps/web/src/lib/mcp/`: `http.ts` (the route's handler: bearer check, rate limit, body cap, transport), `server.ts` (tools, resources, prompt, audit and role checks per call), `compile.ts` and `rich.ts` (convenience tools to ops, outlines, plain text to rich text), `rate-limit.ts`, `deps.ts` and `deps.server.ts` (dependencies; the env factory is server-only), `errors.ts`.
- `apps/web`: `routes/mcp.ts` (POST, GET, DELETE), `routes/_authed/settings/tokens.tsx`, `lib/api-tokens.functions.ts`, the export route (accepts `?token=` one-time links), and the Extensions menu item.
- `apps/web/tests/mcp.mjs` (live editor check, below).

**Transport.** `@modelcontextprotocol/sdk` 1.32.2 with `WebStandardStreamableHTTPServerTransport`, so the TanStack route passes its web `Request` straight through, with no Node adapter. **Stateless**: no session id, a new server and transport per request, `enableJsonResponse: true` (plain JSON responses, no SSE). The SDK answers GET and DELETE itself in this mode (the SDK client connects fine). A stateful session would need persistence across processes, which is not needed for tool calls. Notifications are not pushed.

**Authentication.**
- A token is `sleid_pat_` plus 32 random bytes in base64url. The database stores its SHA-256 (hex) and a six-character hint, never the secret. The secret is shown once.
- Verification looks the token up by its hash (a unique index), then checks revocation and expiry in the same query. An unknown, revoked, expired or malformed token gets the same 401 response, with `WWW-Authenticate: Bearer` (and `error="invalid_token"` for a presented token). The comparison is an indexed equality lookup, not an in-application compare: the attacker never sees a hash to compare against.
- Expiry defaults to 90 days, with a maximum of 365. `last_used_at` is written at most every five minutes.
- Every tool call checks, in order: the token's scope (`decks:read`, `decks:write`, `decks:create`, `exports`, `ai`), the token's deck allowlist (`null` means all decks; a deck outside it reads as "Deck not found"), then the user's **current** role on the deck. A removed membership is refused on the next call. That was tested.
- Tokens are never placed in URLs. The web app's session is not used by MCP.

**Rate limit and body cap.** 120 HTTP requests per token per minute (`MCP_RATE_LIMIT_PER_MINUTE`), counted in memory per web process, so a multi-process deployment gets the limit per process. A 429 carries `Retry-After`. Request bodies are capped at 1 MiB (`MCP_MAX_BODY_BYTES`), checked on the declared length and again while the body is read.

**Writes and reads.**
- Every write goes through the collab internal API (`applyOps` as `mcp:<tokenId>`), so open editors see it live and Undo works for the editor. The web app writes nothing to the database behind collab's back. If collab is down, the call fails with "nothing was changed".
- `apply_ops` parses the ops with the model package's zod schemas first; a 422 from collab returns the failing op's index, name and reason, and nothing is applied.
- Reads use `readDeck` (live, falling back to the saved state).
- `create_deck` with a theme that cannot be applied removes the new row, so no empty deck is left behind.

**Convenience tools.** They compile to ops and reuse `placeNewElement` (now exported from `@sleid/llm`), so charts, diagrams and images are placed in free space exactly as the assistant places them. When the slide is full, the element goes on a new slide after its target. Two items overflowing onto the same target land in reverse order (the later one goes first). That is the existing placement rule, not changed here, and the outline shows the result. `insert_diagram` runs `validateMermaid` (the real parser) and returns the parse error to the agent. `update_text`, `add_slide` and the notes use the plain-text format (`- ` bullets, `**bold**`, `*italic*`; markers count only at word edges, so `2*3*4` stays literal).

**Rendering (`render_slide`).** Reuses the worker's PNG export with `slideId` and `scale`. The tool queues the job, polls the row every 250 ms, and waits up to 30 s. The PNG comes back as MCP image content, with a text block of ids and the pixel size. A render that does not finish in time says it is still queued. Requires `decks:read`.

**Exports (`export_deck`).** Formats `pdf`, `pptx`, `png`, `html`, `md` (mapped to `markdown`) and `json`. It requires `exports`, and viewers may export, as in the editor. It returns a one-time download URL, `/api/exports/<id>/file?token=sleid_dl_…`.
- **Decision: one-time signed links, not the PAT.** Each export gets its own random secret, valid 15 minutes. Only its SHA-256 is stored (`exports.link_token_hash`, `link_expires_at`, `link_used_at`). The link is consumed atomically by the first successful download of a finished export. A request before the export finishes gets 409 and keeps the link. A used, expired or unknown link gets 404. The download response carries `Referrer-Policy: no-referrer`.
- This lifts the M3 gap that MCP could not choose export options. The worker already supported these formats.

**Audit (`mcp_audit`).** One row per tool call: user, token id, tool, deck id (when named), ok, time in ms, and the short error text (at most 300 characters, never a stack). Refused calls are recorded too, including the deck named in the arguments. There are no foreign keys, so the history outlives the token, the deck and the user. A failure to write the row is logged and does not fail the call.

**Generate with AI (`generate_with_ai`).** Requires `ai` and editor access. It calls the existing `runAbilityForDeck`, so it uses the user's default provider, the M4 rate limit and usage rows, and the endpoint policy. It returns the proposed ops and changes nothing; the agent then calls `apply_ops`.

**Resources and prompt.** `sleid://schema/deck`, `sleid://schema/ops` (both from `deckJsonSchema()`), `sleid://themes`, and the template `sleid://decks/{deckId}` (outline; requires `decks:read` and the role check). Prompt `build_deck` (topic, audience, slide_count).

**Settings page.** `/settings/tokens` (Extensions ▸ MCP access tokens opens it in a new tab). Create: name, scopes, expiry, all decks or chosen decks (owner or editor decks only). The created token appears once with copy buttons for the Claude Code command and a JSON snippet. The list shows the hint, scopes, deck count, created, expires, last used and status; Revoke ends the token at once. The origin is read after mount, so the server render and the client render agree (a hydration error was fixed here).

**Link-only memberships (added during M5, from the coordinator).**
- `deck_members.via` is `owner`, `invite` or `link`, and `share_link_id` names the link that granted a `link` membership.
- Redeeming a link sets `link`. An explicit grant (email invite, a role change in the share dialog, MCP `share_deck`) sets `invite`, and so does an existing link member who gets an explicit grant. An `invite` never goes back to `link`. An owner stays owner.
- **Restrict, revoke and expiry.** `getDeckRole` counts a `link` membership only while its link is active (not revoked, not expired). So access ends at the next check, in the web app, in collab and in the internal API alike. `setGeneralAccess('restricted')` also deletes the link memberships that are now inactive, and `listPeople` removes them when the owner opens the list. The restrict action calls `revalidateOpenConnections`, so open connections of link-only people close at once (4403). Explicit members are not touched.
- **Migration 0005.** Owners get `owner`. Every other existing membership stays `invite`, because the database cannot tell who joined through a link. That is the conservative choice (a restricted link does not remove them). An owner who wants them gone removes them by hand. Documented in the migration as well.
- The share dialog shows "Joined via link" next to people who joined through a link.
- Grants now take a row lock (`SELECT … FOR UPDATE` after `INSERT … ON CONFLICT DO NOTHING`) instead of a single upsert. Concurrent grants still serialise and never lower a role (the existing concurrency test passes).

**Fixes made in M5 (outside the M5 feature list).**
- **Stale reads after an internal write (collab).** The internal API opened a direct connection, wrote, and disconnected. Hocuspocus unloads a document on disconnect with `unloadImmediately`, and the store runs on a timer after that. The next request reloaded the saved state from before the write. An agent's `get_deck` straight after `delete_slide` showed the slide still there. Fix: `direct.disconnect({ unloadImmediately: false })` in `apps/collab/src/internal-api.ts`, so the in-memory document is reused until its store completes. The MCP integration test covers this (the delete-then-read sequence).
- **PPTX diagram fallback (M4 leftover).** A failed diagram is a placeholder box, "Diagram could not be drawn", the same text as the renderer. The source is not written. Test: `packages/pptx/src/deck-to-pptx.test.ts`.
- **Hydration.** The new settings page reads the origin after mount (see above).

**Known gaps and limitations (decisions to revisit).**
- **No stdio bridge.** The brief made it optional and said to skip it if it did not stay small. Clients that cannot send headers use an external bridge (README), which has not been run against Sleid.
- **Live connections and expiry.** An expired link closes nothing by itself. Its members lose access on their next check, and on reconnect (the token is refused). A live connection stays open until the next revalidate (a restrict, a role change, or the owner's action). The same limit as the M2 token-expiry gap.
- **Rate limit and body cap are per process** (see above).
- **Overflow order** when several elements go on new slides after the same target (see Convenience tools).
- **Tokens can be scoped to any deck the user is a member of** when they are created (the UI offers owner and editor decks only). The per-call role check is what enforces access.
- **`render_slide` and `export_deck` need the worker running.** Without it, the call fails with a clear message and the export row is marked failed.
- **One-time links are bearer secrets.** Anyone with the link can download once within 15 minutes. The README says not to share them.
- **Publish and export of MCP-created decks** use the same path as the editor (live document with saved-state fallback).

**Not done.**
- The stdio bridge (`packages/mcp-stdio`). Skipped, as the brief allowed.
- An OAuth flow for Claude Desktop's custom connectors. Not offered; tokens are the only credential.
- A PAT list in the editor dashboard. Tokens are managed in settings only.

### M5 verification

Run on this machine: macOS, Node 24.14, pnpm 10.4.1, Postgres 17 (compose, 127.0.0.1:5433), Google Chrome (`CHROME_PATH`), Claude Code 2.1.316. Migrations `0004` and `0005` were applied to the local database.

- `pnpm typecheck`: exit 0 in every workspace.
- `CHROME_PATH=… pnpm test` (root): **45 files, 521 tests, all passing, none skipped.** M4 had 41 files and 481 tests. The new coverage:
  - `packages/db/src/api-tokens.test.ts` (14): secret format and hash-only storage, 90-day default, input rules (names, scopes, deck ids, expiry range), verification, unknown and malformed secrets, expiry at a given clock, revoke by the owner only, throttled last-used, scope and allowlist helpers, audit rows (fields and error truncation), one-time export links (not consumed before the export is done, once only, expiry).
  - `packages/db/src/link-membership.test.ts` (5): restrict removes link-only members and keeps explicit and upgraded ones; revoke and owner; lazy expiry and the people list; an explicit role change makes a member explicit; "Joined via link" data.
  - `apps/collab/src/collab.integration.test.ts` (+1): restricting a link closes the connection of a link-only editor, and an explicitly invited editor keeps syncing. Collab suite: 11 tests.
  - `apps/web/src/lib/mcp/mcp.unit.test.ts` (13): markdown to rich text (paragraphs, bullets, bold, italic, word-edge markers), slide compilation (placeholders, text boxes on blank slides, subtitles), slide and element resolution, outlines, PNG sizes, theme lookup, the rate limiter, bearer parsing.
  - `apps/web/src/lib/mcp/mcp.integration.test.ts` (7), with the SDK client over real Streamable HTTP, real Postgres, the in-process collab service, the in-process worker (pg-boss, Chrome) and local storage:
    - lists the 17 tools, 3 static resources, the template and the prompt, and reads the schema resources;
    - 401 for missing, unknown and revoked tokens, with `WWW-Authenticate`;
    - the workflow: create deck with a theme, three slides, a chart, a bad chart row refused, an invalid Mermaid source refused with the parser message, a valid diagram, update_text refused on a chart, the outline (six slides), JSON format, notes, move and delete, share as viewer (membership is `invite`);
    - `render_slide` returns a PNG (signature, 1920 × 1080); `export_deck` pptx completes, downloads with a `PK` zip, and the second download is 404;
    - a token without `decks:write` gets a scope error on `apply_ops`; a viewer gets role errors on writes and on `generate_with_ai`; a removed editor gets "Deck not found" on the next call;
    - the deck allowlist hides other decks;
    - the rate limit returns 200, 200, 200, 429 with `Retry-After`, and the body cap returns 413;
    - a failed call is in the audit with its deck id and error.
  - `packages/pptx` (+ updated test): the diagram placeholder, with no source text and no monospace.
- `pnpm --filter @sleid/web build`: exit 0. The client bundle has no `createCipheriv`, `COLLAB_INTERNAL_SECRET` or `sleid_pat_`. The one `LLM_SECRET_KEY` match is help text on the AI settings page, which was already there in M4.
- Browser checks against the dev stack (`pnpm dev` with `SLEID_TEST_AUTH=1`, `LLM_USER_ALLOW_PRIVATE_URLS=1`, a scratch `LLM_SECRET_KEY`, Chrome). Run twice: once before the link-membership change and once after it, with the servers restarted in between. Both runs passed:
  - `smoke.mjs`: 22 checks. `collab.mjs`: 24 checks. `export.mjs`: 21 checks. `ai.mjs`: 32 checks. All with no page or console errors.
  - `mcp.mjs` (new, below): 19 checks, no page or console errors.
- **Live editor check** `apps/web/tests/mcp.mjs`. A token was created through the settings page (Playwright). An editor was open on a new deck. The SDK client made these calls: list_decks, add_slide ×3, insert_chart on a blank slide, and an invalid insert_diagram. The open editor showed the cover in 8 ms, the bullet slide in 8 ms and the chart in 95 ms (budget 3000 ms). The invalid diagram was refused and nothing appeared in the editor. `render_slide` returned a 1920 × 1080 PNG. Screenshots (in `SCREENSHOT_DIR`): `mcp-tokens.png` (settings page with the copy-once panel), `mcp-live.png` (editor after the MCP edits), `mcp-render.png` (the PNG from render_slide).
- **Claude Code CLI**: `claude mcp add --transport http sleid-test http://localhost:3000/mcp --header "Authorization: Bearer <token>"` in a scratch directory, then `claude mcp list` showed `sleid-test: http://localhost:3000/mcp (HTTP) - ✔ Connected`, then `claude mcp remove sleid-test` (the list afterwards had no entry). The header value appeared only in redacted form in the CLI output. No agent session was run.
- The servers were stopped afterwards. The scratch user made for the CLI check was deleted.

### Unverified in M5

- **Real agent sessions.** No agent ran a deck build through MCP. The Claude Code check connected and listed the server, but no tool call came from Claude itself.
- **Claude Desktop and other clients.** Not tested. The `mcp-remote` bridge in the README is not verified.
- **Restrict in the browser.** The restrict path is covered by the database and collab tests, not by a browser run (the share dialog's restrict button was not clicked in a check).
- **Expiry on live connections.** Not tested in a running service (see the known gaps).
- **Multi-process rate limits** and body caps behind a load balancer: not tested.
- **Long decks and large exports** through MCP (the tests use 6-slide decks).
- **Concurrent MCP writers** on one deck: the collab path is the same as the editor's, and was not stress-tested.
- **Generate with AI through MCP** was not run against a live model (the live LLM was not called in M5; the test checks only the scope and the viewer refusal). The M4 live model check was not repeated.
- **Firefox and Safari.** Chrome only.
- **Production serving** (`node .output/server/index.mjs`) of `/mcp`. The build passes; the server was not run.

### What M6 built, and decisions taken while building it

Scope: the prompt-to-deck wizard end to end (brief, references, research, outline, live generation), the two new packages `packages/ingest` and `packages/research`, wizard tables and jobs, editor banner, MCP tools.

**Layout.**
- `packages/ingest` (`@sleid/ingest`): `extract.ts` (PDF via unpdf, DOCX via mammoth, PPTX via JSZip slide and notes XML, XLSX and CSV via SheetJS, TXT and MD, PNG and JPG as image references only), `sanitize.ts` (Readability on a happy-dom DOM with scripts, styles, frames and `head` removed), `chunk.ts`, `bm25.ts` (BM25 in TypeScript), `url.ts` (the URL fetch), `source.ts` (`IngestedSource`, caps, chunk and table helpers), `limits.ts`.
- `packages/research` (`@sleid/research`): `config.ts` (env, and the read-only status line), `providers.ts` (SearXNG, Brave, Tavily), `dedupe.ts`.
- `packages/llm`: `config.ts` (env policy helpers moved from the web app, which re-exports them), `wizard-schema.ts` (brief, outline, pure outline edits; also the `@sleid/llm/wizard-schema` subpath for the client), `wizard-slide-schema.ts`, `wizard-abilities.ts` (research queries, outline, one slide).
- `packages/db`: `schema/wizard.ts` (`wizard_runs`, `wizard_sources`), `wizard.ts` (queries). `llm_usage.deck_id` is now nullable (research and outline run before a deck exists). Migrations `0006_wise_owl.sql` (tables) and `0007_past_moon_knight.sql` (nullable `deck_id`, `wizard_sources.bytes`).
- `packages/jobs`: three wizard queues (`wizard-research`, `wizard-ingest`, `wizard-generate`), with a test-only name prefix.
- `apps/worker`: `wizard/jobs.ts` (ingest, research, generate), `wizard/provider.ts` (the run's provider: the same resolution order as the assistant, and the same pinned fetch), `wizard/collab.ts` (the collab internal client), `wizard/service.ts` (the queue wiring).
- `apps/web`: `lib/wizard.server.ts` (service), `lib/wizard.functions.ts` (server functions), `lib/wizard.deps.server.ts`, `routes/api/wizard/$runId/files.ts` (raw-body upload), `routes/_authed/wizard/new.tsx` (brief), `routes/_authed/wizard/$runId.tsx` (references, research, outline, generate), `components/editor/WizardBanner.tsx` (progress, cancel, Sources), the dashboard button, File ▸ From prompt…, the research line on Settings › AI, and two MCP tools.
- `deploy/searxng/settings.yml` and a `searxng` service in `compose.yml` behind the `research` profile, bound to 127.0.0.1:8888.

**Flow and state.**
- `draft` (references can be added or removed) → `ingesting` (research runs) → `draft` (references ready) → `outlining` (the outline is drafted in the web request, synchronously, as the other abilities are) → `ready` (the outline can be edited) → `generating` (a deck exists; the worker writes one slide at a time through the collab internal API as `server:wizard`) → `done`, `cancelled` or `failed`.
- The deck is created when generation starts (`startGeneration`), owned by the caller. The collab service creates its first document, and the worker deletes the default title slide in the same batch as the first new slide, so the editor never shows an empty deck for long.
- Cancel is checked before each slide. The slide in progress finishes, so the deck keeps what was written.
- A slide the model cannot write (invalid JSON after the retry, or an op batch the collab service refuses) becomes a placeholder with the outline's points and a note. The run goes on, and the warning is kept in `wizard_runs.error`.
- Ingest and research are separate jobs, so a slow page does not hold the run. A page that fails (for example, refused by the policy) fails only its own source.

**Decisions.**
- **Charts take their numbers from the reference table, never from the model.** The model names a source, a table index, a category column and value columns. Code copies the rows. A name that does not match gives no chart and a warning. Only a chart with no table behind it may use model-written numbers (`chartIllustrative`). That chart's title gets "(illustrative)", its notes say so, and the warning names it.
- **Citations are checked.** Notes may cite only reference numbers that exist. A slide that uses references but cites none gets a "Sources: [n]" line. The Sources slide lists every ready reference in the same numbering.
- **Only `addSlide` is proposed.** The model's answer becomes one `addSlide` op with the slide's elements. Extra keys in the answer are stripped by the schema, so an injected `ops` array has no effect. The allowlist is the same `checkOps` as the assistant. The setup slide and the default slide are removed by the worker's own ops, not by model output.
- **A visual never goes into a shared column.** A chart or diagram takes the right column with the body on the left. Layouts that cannot hold that (`two-column`, `section`, `title`, `quote`) are switched to `title-content`. A `blank` slide with text gets a title box. Both came from the live run (see below).
- **Outline references are symbolic.** The model names references S1, S2 ..., and the code maps them to source ids. An unknown label is dropped with a warning, and every save checks the ids again.
- **Uploads live in the storage driver, not in `assets`.** `assets.deck_id` is NOT NULL and a run has no deck until generation starts. The key is `wizard/<runId>/<sourceId>`. The row keeps the name, the size (`bytes`, against the 50 MB total) and the key.
- **The worker resolves the provider itself.** Same rules as the web assistant (the run's provider, then the user's default, the workspace default, the server default), the same decryption (`LLM_SECRET_KEY`), and the same pinned fetch. The copy in the worker mirrors the web app's `specFrom` and `configOf`. Two copies is a known smell; moving them into `packages/llm` is a follow-up.
- **URL fetch is always SSRF-safe.** `fetchPublicUrl` uses `createPinnedFetch({ allowPrivate: false })` regardless of provider scope. Redirects are followed by the fetch itself, and each hop is checked again (the test shows a redirect to `169.254.169.254` refused even when private addresses are allowed for a test). Limits: 5 redirects, 5 MB, 15 s, and content types HTML, XHTML, PDF, plain text, markdown and CSV.
- **The test-only policy override is a parameter, not a flag.** `fetchPublicUrl(url, { policy })` and the worker's `fetchUrl` option exist only for tests. Production never passes them. The web app's pre-check on `addUrl` has no override.
- **Research queries are five at most, de-duplicated.** Results are de-duplicated by a canonical URL (tracking parameters dropped), then at most eight pages are queued. SearXNG is the one private host research may reach, and only that host is called.
- **MCP.** `create_deck_from_prompt` runs the whole pipeline in the tool call, waiting up to 60 s for the references, then drafts the outline and starts generation. The response carries the deck id and run id. If the references are still being read after the wait, it returns the run id and status without a deck. `get_wizard_status` follows the run.

**Deviations from the brief.**
- File ▸ New ▸ From prompt is a flat menu item (File ▸ From prompt…), because the menu has no submenus.
- The Sources panel is a drawer opened from the editor banner, not a tab in the side panel. The side panel was not changed.
- Outline drafting is a synchronous server function, not a job. Only the three queued steps are jobs (research, ingest, generate).
- The generation concurrency setting (`WIZARD_CONCURRENCY`, up to 4 for cloud providers) is **not implemented**. Slides are written one at a time, in order. Parallel writes would need an index per slide and an order check, which was left out.
- `wizard_sources.file_key` is the storage key, not an asset id (see the decision above).
- Usage rows are written for each model call, with `deck_id` null for research and outline.

**Known gaps and limits (decisions to revisit).**
- **No robots.txt check** for user-given or search-found pages (the brief allowed skipping it; this is the note it asked for). Each page is fetched once per run, with a timeout.
- **Images are not read.** A reference image is listed by name. The brief's "pass to vision providers" is not done.
- **Prompt-injection defence is structural, not complete.** Reference text is data inside `<<<DECK_CONTENT` blocks, the system prompt says never to follow it, and the output is limited to `addSlide`. A model can still write misleading text inside a slide; the review step (the user reads the outline and the Sources) is the control.
- **No quotas beyond the limits above.** Wizard model calls run in the worker, not the assistant route, so `AI_RATE_LIMIT_MAX` does not count them. Their usage is recorded in `llm_usage`, and nothing caps it yet. A user can start many runs.
- **Deck creation before the first slide.** A run that fails before its first slide leaves an empty deck titled from the outline. Deleting it is manual.
- **The run waits for references, in the MCP tool only.** The web flow asks the user to press Draft outline when the references are ready.
- **Two copies of provider resolution** (web and worker), described above.
- **One worker process.** The wizard queues have no per-run lock beyond the generate queue's concurrency of 1. Two worker processes would work on different runs. A restart in the middle of a run is now recovered: on startup the worker marks any `generating` or `ingesting` run with no heartbeat for five minutes as `failed`, with the message "The worker stopped before this run finished" (the slides written so far are kept, and the run is not resumed). The M3 export reaper gap is unchanged.

### M6 verification

Run on this machine: macOS, Node 24.14, pnpm 10.4.1, Postgres 17 (compose, 127.0.0.1:5433), Google Chrome (`CHROME_PATH`). The live model is `qwen3.8-flash-next-q2_0` at `https://gpt.knowhub.my.id/v1`, a reasoning model with `json_schema` support.

- `pnpm typecheck`: exit 0 in every workspace.
- `CHROME_PATH=… pnpm test` (root): **50 files, 592 tests, all passing, none skipped.** M5 had 45 files and 521 tests. The new files:
  - `packages/ingest/src/ingest.test.ts` (25): each extractor on generated fixtures (CSV, XLSX with the five-sheet and 200-row caps, PDF via pdf-lib, DOCX and PPTX as minimal OOXML zips, text, image); mismatched and unknown types; the 20 MB refusal before reading; HTML sanitising; caps and chunking; BM25; the URL fetch against a loopback server with the test policy (HTML extraction, a redirect to a permitted address, a redirect to `169.254.169.254` refused, the redirect limit, an unsupported content type, the 1 MB body cap), and the production policy refusing loopback.
  - `packages/research/src/research.test.ts` (11): precedence, a status line that never contains a key, the SearXNG adapter against a JSON server (filters non-http results, reports HTTP errors, reaches its own host), Brave and Tavily through injected transports (headers, body, a non-JSON reply), canonical URLs and de-duplication.
  - `packages/llm/src/wizard.test.ts` (21): brief and outline schemas and pure edits; outline reference mapping; language and untrusted-block structure of the prompts; query de-duplication; a chart copied from the table; illustrative marking; a chart with no source left out; a chart naming a missing column refused; **only `addSlide` proposed, even with injected `ops` and an injected title**; the injected reference reaches the model only inside the data block; citation validation; notes off; a bad reply is an error; two-column and blank layouts for visuals.
  - `apps/worker/src/wizard/wizard.integration.test.ts` (5, real Postgres): a full run (CSV upload, local page, outline, five slides including a table chart, an illustrative chart, a diagram and a Sources slide); the chart numbers equal the CSV; the illustrative title and notes; the citations; the default slide removed; **cancel mid-run keeps two slides and stops**; **a bad reply becomes a placeholder and the run still finishes**; research queues one ingest per de-duplicated page; a refused URL fails only its own source. The collab service is replaced by an in-memory Yjs document applying the same ops (see the decision on the test seam below).
  - `apps/web/src/lib/wizard.server.test.ts` (9, real Postgres): ownership (another user gets not-found on every action), research refused without a provider, file type, empty and size refusals, a CSV stored under a run key and queued, URL refusal for loopback, link-local and `ftp:`, the cap and duplicates, outline save dropping unknown ids, and generation needing a drafted outline and making one deck.
  - `apps/web/src/lib/mcp/mcp.integration.test.ts`: the tool list now includes `create_deck_from_prompt` and `get_wizard_status`. The other MCP tests pass unchanged.
- `apps/web` build (`vite build`): exit 0. It regenerated the route tree for the wizard routes.
- **Live model check** (`apps/web/scripts/live-wizard-check.ts`, run with `node --experimental-strip-types`): the M6 brief (Indonesian, 8 slides, bakery owners), a six-row CSV of monthly electricity bills before and after solar, and the Wikipedia page "Solar power in Indonesia" fetched through the production policy. The run made **9 model calls** (1 outline, 8 slides), about 75k input and 11k output tokens in the last run. The run found two layout defects. Both were fixed and unit-tested, and the second run was clean:

| Step | First run | Second run (after the fixes) |
|---|---|---|
| Fetch the page | 1.9 s | 0.8 s |
| Outline | 20.2 s | 34.5 s |
| Slides, total | 150 s (8 slides, 12–46 s each) | 150 s (8 slides, 11–24 s each) |
| Slide warnings | 1 (overlap on the two-column diagram slide) | 0 |
| Charts | 1, numbers equal the CSV | 2, both numbers equal the CSV, neither illustrative |
| Diagram | none | 1 |
| Notes with citations | 8 of 8 | 8 of 8 |
| Language | Indonesian (113 Indonesian vs 8 English word hits) | Indonesian (95 vs 15) |

  The first run also had a blank closing slide (`blank` layout, text only in the notes), which is fixed. The slide JSON from the second run is in the session scratchpad (`live-wizard2/deck.json`).
- **Quality notes from the live output (honest).** The Indonesian is fluent and on-topic. The English hits are proper nouns and some terms ("solar rooftop"), not whole sentences. The first slide's title is a reasonable pitch line. The notes repeat points from the bullets more than they add. The charts are plausible, but the numbers came from the CSV and were not checked against any other source. Layout was checked only by the geometry code and the overlap warnings, **not by looking at a render**.

### M6 completion: live run 3, the fixes, recovery and browser coverage

This pass closes the M6 gaps: the defects seen in the live deck, the heartbeat recovery, the browser e2e and the re-run of the browser suites.

**Live run 3** (`apps/web/scripts/live-wizard-check.ts`, the same brief, CSV and Wikipedia page as run 2, research off, `qwen3.8-flash-next-q2_0` at `https://gpt.knowhub.my.id/v1`). Output in the session scratchpad under `live-wizard3/` (deck.json, outline.json, report.json, run.log, slide-1..9.png, contact.png). Timings: fetch page 0.8 s, outline 29.1 s, slides 1 to 5: 15.5 s, 62.2 s, 11.7 s, 16.5 s, 15.6 s. **Slides 6 to 8 were placeholders**: the model endpoint answered "fetch failed" about 0.5 s into each, so the run did not reach the model for them. The run was not repeated (one run was the instruction). Tokens: 51.7k in, 6.4k out. Warnings: one (the chart repeat below).

Visual review of every slide (contact sheet, and each slide at full size where needed):
- Slide 1 (cover): fine.
- Slide 2 (chart, two-line bullets on the left): the chart title "Tagihan Bulanan Sebelum dan Sesudah" sits whole inside the chart. The live run 2 clipped title is fixed.
- Slide 3: three bullets, text only, most of the slide empty. Acceptable, not a defect of the code.
- Slide 4 (five-node left-to-right flowchart): bullets above, diagram full width below, labels readable at 1920 px. Was a small diagram in run 2.
- Slide 5: the chart was left out because it repeated slide 2's data (the warning says so). The bullet "Penghematan dari Data S1" leaks the outline's reference label, see the remaining defects.
- Slides 6 to 8: the placeholders had no elements (a script defect, now fixed in the script: placeholders carry the outline's points, as the worker does). The shipped run's slides are blank.
- Slide 9 (Sources): lists the CSV and the Wikipedia page with their numbers. Present for the first time.

**Defects from run 2, each fixed with a unit test:**
1. **Chart titles clipped** (`packages/render/src/chart.ts`). The ECharts title had no width, so a long title ran off both sides of a narrow chart. The title now has the chart width minus 48 px padding and `overflow: 'break'`, wrapped to at most two lines (`fitTitle`, with an ellipsis for the rest), and the grid starts below the real title height. The wizard drops a table chart's own title when it is longer than 40 characters (the slide's title says what it shows); an illustrative chart keeps its "(illustrative)" marker. Tests: `packages/render/src/chart.test.ts` (6, including an SVG with a narrow chart and a long title, at most two title lines), `packages/llm/src/wizard.test.ts`.
2. **Duplicate content in two columns.** Cause: `buildSlideElements` gave the full bullet list to every body box, so both columns of a two-column slide held the same text. Fix: the bullets are split across the columns in order (`splitBullets`); a two-column slide with fewer than two bullets becomes title-content. A validator (`findDuplicateBodies`) drops any body box that repeats another on the slide, with a warning. Tests: `wizard.test.ts` (four).
3. **Closing slide without a title and with centred bullets.** Cause: the `quote` layout has a centred body box and no title box (the `blank` layout has no title either). Fix: `resolveWizardLayout` turns cover, quote, blank and title layouts into title-content on every slide but the first, and a section divider stays a divider only with no bullets and no visual. Bullets are always left-aligned. The title falls back to the outline's title when the model's is empty. Tests: `wizard.test.ts` (three).
4. **The same chart twice.** Cause: nothing tracked the charts already placed. Fix: the worker (and the live script) keep a set of chart data keys (columns and rows); a slide whose chart has the same data is left out, with a warning, and the set is updated only after the batch is applied. Test: `wizard.test.ts` (two-run check with one shared set).
5. **Small diagram in the right half.** Cause: the visual column was 904 px wide and the diagram's height limited its size. Fix: the visual column is now 1008 px (58% of the 1728 px safe width). A left-to-right flowchart with four or more nodes goes full width below the bullets (`isWideFlow`, `mermaidNodeCount`). Tests: `wizard.test.ts` (three).
6. **No Sources slide.** Cause, two parts: the brief's `includeSources` defaulted to false (in the schema and in the new-brief checkbox), and the live script never built the Sources slide (only the worker did). Fix: the default is now on (schema and form). The Sources slides come from one helper, `sourcesSlideOps`, which the worker and the script both use. Tests: `wizard.test.ts` (the default; the Sources helper, eight per slide).
7. **Theme.** The live script set `theme: 'Sheets Light'` on the brief but never applied a `setTheme` op, so the deck kept the empty deck's default theme. Sheets Light is that default, so the output looked the same. The script now applies the brief's built-in theme as the worker does. The "AI from brand colours" theme was not exercised by any live run.

**Remaining defects in live run 3 (all four fixed in M6 pass 2, see below):**
- **Invented figures in bullets.** Slide 2's bullets say "Tagihan sebelum rata-rata Rp3,38 juta" and "sesudah rata-rata Rp2,08 juta". The CSV's averages are Rp4,175,000 and about Rp2,447,000. The rule "numbers come from the references" is enforced for charts only; bullet text is model-written. A check that every figure in a bullet appears in the references would catch it.
- **Reference label leaked into a title.** Slide 5's title "Penghematan dari Data S1" shows the outline's internal label "S1".
- **Editor banner covers the editor header.** The wizard banner is `fixed` at the top of the editor and hides the deck title row while it runs (seen in `shots-m6/wizard-live.png`). Cosmetic; a layout change in the editor was out of scope.
- **Three slides lost to the endpoint.** Not a code defect, but the run has no retry for an unreachable endpoint between slides.

**Recovery (B3).** `wizard_runs.heartbeat_at` (migration `0008_freezing_leo.sql`) is set on every run status change and each time an ingest finishes (`touchWizardRun`). `recoverStaleRuns` runs when the worker starts: a run in `generating` or `ingesting` with no heartbeat for five minutes (or with no update at all) becomes `failed` with the message in `STALE_RUN_MESSAGE`. The generate job also does nothing for a run that is already cancelled, failed or done, so a retried job cannot rewrite it. Tests (real Postgres, `apps/worker/src/wizard/wizard.integration.test.ts`): a stale, a fresh, a finished and a no-heartbeat run, checked at two times; a late generate job writes nothing. The test uses timestamps, not a process kill.

**Browser e2e (B1), `apps/web/tests/wizard.mjs` (25 checks).** Dashboard, New from prompt, the brief, a CSV file and a web address (served by the local fake SearXNG), research on, the outline (rename, move, delete, reload keeps the change), generate, slides arriving through the collab service (the slide count rose 2 → 3 → 5 in the run), the banner's "Slide n of m", done, and the Sources list. No page or console errors. Screenshots (in `SCREENSHOT_DIR`): `wizard-brief.png`, `wizard-outline.png`, `wizard-live.png`.
- Fakes: `apps/web/tests/fake-openai-server.mjs` answers the wizard's `queries`, `outline` and `slide` calls (the slide reply takes its chart's columns and sourceId from the prompt's table block; `wizardSlideDelayMs` slows the slides so progress can be watched). `apps/web/tests/fake-searxng.mjs` answers `/search` and serves its own pages.
- Bug found and fixed: the run page imported `LIMITS` from the `@sleid/ingest` root, which loads happy-dom (Node only), so the browser showed "Something went wrong". Fixed with a `./limits` subpath export, and the route uses that.
- **Test-only private URL override.** The wizard's URL references may point at a loopback address only when `SLEID_TEST_PRIVATE_WIZARD_URLS=1` and `SLEID_TEST_AUTH=1` and `NODE_ENV` is not production (`testPrivateWizardUrls` in `packages/ingest/src/url.ts`). It is read in two places: the web `addUrl` pre-check and the worker's fetch. This is the one exception to "the policy is a parameter, not a flag"; the production policy is unchanged when the variable is unset. The e2e needs it because its page is local.
- The MCP suite also found a test-isolation bug: its wizard jobs shared the queue with the running dev worker, so the dev worker took them. The test queue now has a prefix (the option existed for this).

**MCP (B2).** `create_deck_from_prompt` then `get_wizard_status` until done, in `apps/web/src/lib/mcp/mcp.integration.test.ts`, with an in-process wizard worker, the real collab service and a fake model answering by schema name. The deck has three slides, and the first and last titles are the outline's.

**Verification (this pass).**
- `pnpm typecheck`: exit 0 in every workspace.
- `CHROME_PATH=… pnpm test` (root): **51 files, 614 tests, all passing, none skipped.** The M6 entry above had 50 files and 592 tests.
- Browser suites against the dev stack (`SLEID_TEST_AUTH=1`, `LLM_USER_ALLOW_PRIVATE_URLS=1`, `SLEID_TEST_PRIVATE_WIZARD_URLS=1`, a scratch `LLM_SECRET_KEY`, `SEARXNG_URL` at the fake, collab secrets, `CHROME_PATH` for the worker): `smoke.mjs` 22 checks, `collab.mjs` 24, `export.mjs` 21, `ai.mjs` 32, `mcp.mjs` 19, `wizard.mjs` 25. All pass, no page or console errors. The first run failed for setup reasons (no `CHROME_PATH` in the worker, no collab secrets in the suite's environment), not for product reasons, and was rerun in full.

**Decisions taken in this pass.**
- A chart repeated from an earlier slide is left out (not replaced by a different view). The wording allowed either; leaving it out is the simpler rule.
- A visual's width floor is 55% of the safe width; the rule is in code (1008 px of 1728 px), not in the model's prompt.
- The Sources slide is on by default, in the schema and in the form.

### Unverified after the M6 completion pass

- **Research on a live search provider.** SearXNG, Brave and Tavily were not run against a real service. The browser e2e uses the fake SearXNG (`apps/web/tests/fake-searxng.mjs`), and the research adapters are tested against fake servers.
- **Worker crash by a real process kill.** The recovery is tested with timestamps in Postgres, not by killing a worker process mid-run.
- **Concurrent runs on two workers.** Not tested.
- **Large references** (the 10-file and 50 MB limits are tested only on the refusal paths) and PDF or DOCX text quality beyond the generated fixtures.
- **Images are not read** by the model (see the known gaps above).
- **Live run 3 slides 6 to 8**: not produced by the model (endpoint outage). Their rendering was checked only as placeholders.
- **Firefox and Safari.** Chrome only, as before.

### M6 pass 2: numeric grounding, label leaks, failed-slide retry, banner layout

Closes the four defects left from live run 3. Branch `m6-wizard`, one commit, not pushed.

**Facts for tables (`packages/llm/src/wizard-facts.ts`).** Before a slide is written, code computes figures from the reference tables and puts them in the slide prompt as a `FACTS` block (inside the untrusted-data markers), one line per fact with the citation number and source id. Per numeric column: min, max, average, total, first and last. Per pair of columns with the same unit (a `(Rp)` or trailing unit word): the per-row difference (first minus second, up to 12 rows), its average and total, and the difference as a share of the first column. Formatting follows the deck language (4.175.000 in Indonesian, 4,175,000 in English). A slide gets its own sources' facts, or all of them when it names none. The source id is kept out of the parsed text, so its digits never count as supporting figures.

**Numeric checker (`packages/llm/src/wizard-numbers.ts`, rules in `writeWizardSlide`).**
- Every figure in a title, subtitle or bullet is read in both notations: `Rp4.175.000`, `Rp4,2 juta`, `4.2 million`, `4,175,000`, `38–43%`, `1,6–1,9 juta`. A figure with one separator reads both ways (`4.175` is 4175 or 4.175). A range takes the unit of the figure that has one.
- The tolerance is the rounding the figure shows: one decimal of a million is ±50 000 (so `Rp4,2 juta` covers 4 175 000), two decimals of a million is ±5 000, a grouped whole number may be rounded to its trailing zeros (`2.447.000` covers 2 446 667), a percentage is ±0.5 point.
- Supported figures come from the slide's own reference text, its FACTS and the table cells. Notes and chart data are not checked (chart data is copied from the table).
- Exempt: years (1900 to 2100), slide counts ("5 slides"), ordinals of ten or fewer, and day numbers before a month name.
- One corrective request for the slide, naming the unsupported figures. If the second reply still states one, the figure stays and is marked in the deck language: `(perkiraan)` in Indonesian, `(estimate)` otherwise, after each such figure. The speaker notes get a line naming them, and the run warnings get "Slide n: figures not found in the references were marked as estimates: …". The slide result carries the list (`estimates`).
- The checker is lexical. It cannot tell that a figure is attached to the wrong thing, and a wrong figure that happens to equal a source figure passes.

**Internal labels (`stripSourceLabels` in `wizard-text.ts`).** `S1`, `[S1]`, bracketed citation numbers and uuids are removed from every visible title, subtitle, bullet, outline title and key point, and chart title. A label left at the start of text takes its separator with it. A title that is only a label falls back to "Slide n". Citations stay in the speaker notes. The prompts name sources by their title in visible text. Limit: a real `S1` in deck text (Indonesian "Kelas S1") is removed too.

**Failed slides.**
- *Worker path, checked:* the worker's placeholder already carried the outline title and bullets (the integration test checks the bullet text). It had no visible note, only a line in the speaker notes. The live script's placeholder was the same. Both now add a muted note at the foot of the slide: "Could not be generated — click ✨ Ask AI to retry." (Indonesian: "Tidak dapat dibuat — klik ✨ Ask AI untuk mencoba lagi."). **The note's wording does not match the retry:** "✨ Ask AI" is the assistant, not the wizard retry, which is the banner's "Retry failed slides" button. The wording is as specified; change it when the note is revisited.
- *Recording:* `wizard_runs.failed_slides` (migration `0009_wizard_failed_slides`) holds `{slideId, number}` for each placeholder. Keying on the slide id means a retry finds the slide even after the user moved things.
- *Retry:* `retryFailedSlides` (server function `retryWizardFailedFn`) is allowed only for a `done` run with placeholders. It sets the run to `generating` and queues a `generate` job with `retry: true`. `runRetry` writes each placeholder again: `replaceSlideOps` deletes the old slide and adds the new one at the same index. A slide that fails again stays a placeholder. A placeholder the user deleted is skipped. The run ends `done` with the placeholders that remain. A retry that crashes leaves the placeholders as they were and the run `done`, so it can be retried again.
- *Surfaces:* the banner shows "Slide n could not be written and show the outline points." with the retry button. `get_wizard_status` returns `failedSlides` (1-based slide numbers).

**Banner layout.** The banner is no longer `fixed`. `EditorShell` takes a `banner` slot, rendered between the toolbar and the preview and formula bar, so it takes its own row. The title row is not covered (`shots-m6b/wizard-live.png`).

**Tests.** 
- `packages/llm/src/wizard-numbers.test.ts` (13): the notations, ranges, tolerance (including the live run's 3,38 and 2,08 juta cases), exemptions, marking.
- `packages/llm/src/wizard-grounding.test.ts` (19): FACTS (values, the difference pair, language, unit detection, the block), the corrective retry, the marked estimate in both languages, exemptions, the FACTS block in the prompt, label stripping in slides and in the outline, the placeholder (title, bullets, muted note, no overlap with the bullets), the in-place replace ops, chart keys.
- `packages/llm/src/wizard.test.ts`: one fixture bullet changed from "Hemat sekitar Rp 1,6 juta" to "Hemat setiap bulan". The figure is not in the fixture's source, so the checker now asks for a correction, and the scripted provider has no second reply.
- `apps/worker/src/wizard/wizard.integration.test.ts` (9, real Postgres): the placeholder's visible note and recorded id; a CSV figure from FACTS is corrected once, with the FACTS in the prompt; a retry that fails again keeps the placeholder, and the next retry replaces it at the same index.
- `apps/web/src/lib/wizard.server.test.ts` (10): the retry is refused unless done with placeholders, belongs to the owner, and queues one retry job.
- `apps/web/src/lib/mcp/mcp.integration.test.ts`: the fake model fails slide 2, so `get_wizard_status` returns `failedSlides: [2]` and the placeholder carries the outline's title.

**Verification (this pass).**
- `pnpm typecheck`: exit 0 in every workspace.
- `CHROME_PATH=… pnpm test` (root): **53 files, 649 tests, all passing, none skipped.** The M6 completion entry above had 51 files and 614 tests.
- Browser suites against the dev stack (same environment as before): `wizard.mjs` 34 `ok` lines (25 before: 8 new checks for the banner layout, the placeholder note and bullets, the retry replacing the placeholder in place, and the call counts, plus the placeholder screenshot), `smoke.mjs` 22, `mcp.mjs` 19. All pass, no page or console errors.
- `wizard.mjs` forces slide 3 to fail once (`failWizardSlideOnce` in `apps/web/tests/fake-openai-server.mjs`, a 400, which the provider layer does not retry). The check shows the placeholder with its bullet and note, then Retry failed slides removes both, and the slide count stays at five.

**Live run 4** (`apps/web/scripts/live-wizard-check.ts`, the same brief, CSV and Wikipedia page, research off, `qwen3.8-flash-next-q2_0` at `https://gpt.knowhub.my.id/v1`, no key). Output in the session scratchpad, `live-wizard4/`: deck.json, outline.json, facts.json, numbers.json, report.json, slide-1..9.png, contact.png. The run made 9 model calls (1 outline, 8 slides) and needed no corrective request, no placeholder and no retry. Warnings: 0. Tokens: 78.4k in, 11.9k out.

| Step | Time |
|---|---|
| Fetch the page | 0.8 s |
| Outline | 80.7 s (earlier runs 20 to 35 s; endpoint latency varies) |
| Slides 1 to 8 | 18.5, 33.4, 13.8, 14.2, 16.9, 27.8 (diagram), 18.8, 13.5 s; total 156.9 s |

Figures in the visible text (titles, subtitles, bullets): 28 occurrences, 4 exempt years (2021 three times, 2000 once), 24 checked, 24 supported, 0 unsupported, 0 marked. Checked by hand against the CSV and the fetched page (the notes too):

| Slide | Figure as written | Source | Verdict |
|---|---|---|---|
| 2, 3, 7 | Rp4.200.000, Rp4.100.000, Rp4.000.000 (before), Rp2.600.000, Rp2.550.000, Rp2.350.000 (after) | CSV, Jan, Feb, May | exact |
| 2, 5 | Rp4,2 juta (average before) | CSV average 4 175 000 | rounded |
| 3, 5, 6, 8 | Rp1,7 juta (average saving) | CSV average difference 1 728 333 | rounded |
| 5 | Rp10,4 juta (total saving, six months) | CSV total difference 10 370 000 | rounded |
| 5, 8 | 41,4% (saving as a share of the before total) | 10 370 000 / 25 050 000 | computed, one decimal |
| 7 | Rp1.650.000 (May saving) | 4 000 000 − 2 350 000 | computed, exact |
| 4 | 30,3% (coal, 2021) | page: "Coal (30.3%)" in 2021 total energy supply | exact |
| 4 | 11,6% (wind, solar and others, 2021) | page: "Wind, Solar, etc. (11.6%)" | exact |
| 4 | "hampir 60%", 2000 to 2021 | page: "increased by nearly 60%" | exact |
| 2, 3, 4, 7 | 2000, 2021 | years | exempt |

The chart on slide 3 has six rows from the CSV, all equal to the CSV, not illustrative. The diagram on slide 6 is a flowchart with four nodes, full width. Speaker-note citations: 8 of 8 slides. Label leaks: none (no S-label, no bracketed number in visible text). Language: Indonesian (103 Indonesian vs 8 English word hits).

Visual review of every slide (contact sheet, and full size for slides 3, 4 and 6):
- Slide 1 (cover): fine.
- Slide 2 (five bullets, the first three are the before-bills): fine, most of the slide empty.
- Slide 3 (chart with bullets): good, chart labels readable, chart equals the CSV.
- Slide 4 (two-column): correct text, but the split is uneven (two bullets left, one right), and the slide is mostly empty.
- Slide 5 (six bullets): fine.
- Slide 6 (full-width flowchart): readable at 1920 px, after rendering the diagram with Mermaid. (A first render without the Mermaid script showed the raw source; that was a render-tool setting, not the deck.)
- Slide 7 (bullets): fine, but two of its four bullets repeat the file name ("Penurunan terlihat pada tagihan-listrik.csv", "Data nyata dari tagihan-listrik.csv"). Filler.
- Slide 8 (next steps): fine.
- Slide 9 (Sources): "tagihan-listrik.csv — tagihan-listrik.csv" (title and origin are both the file name). The Wikipedia entry is titled "Energy in Indonesia - Wikipedia", because the URL's page is that article; the deck is about solar. Neither is a defect of this pass.

**Not done in this pass.**
- The retry was not exercised by the live run (no placeholder), only by the browser check (fake, forced failure), the worker integration test and the live script's dry run against the fake model.
- The live script does not call the server's retry path; it runs the same writer and replace ops. Its dry run used `LIVE_WIZARD_ALLOW_PRIVATE=1` against the local fake (the live run leaves it unset).
- The note's "✨ Ask AI" wording (see above).
- The "pending" theme op is lost if the first slide batch is refused. That was there before this pass and is unchanged.
- The Wikipedia figure check is one run against one page; the page can change.

### What M7 built, and decisions taken while building it

Scope: comments (threads, pins, mentions, resolve, MCP), version history (automatic checkpoints, retention, named versions, preview, restore, MCP), and presenter mode with a phone remote and a follow link. Branch `m7-collab-extras`, one commit, not pushed.

**Layout.**
- `packages/model`: `comment-text.ts` (mention markup, the comment markdown subset, plain text, validation), `deck-compare.ts` (version diff), `ydoc.ts` (`replaceDeckContent`, the restore writer, sharing the deck writer with `deckToYDoc`).
- `packages/db`: schema `schema/comments.ts` (`comment_threads`, `comments`, `comment_mention_reads`) and `schema/remote.ts` (`remote_sessions`); `schema/decks.ts` (`deck_snapshots.kind`, `deck_snapshots.editors`); modules `snapshots.ts` (checkpoints, retention, listing, preview read, pruning), `comments.ts`, `remote-session.ts` (token and session rows); `permissions.ts` (`canComment`, `canResolveComments`). Migration `0010_m7_comments_versions_remote.sql`.
- `apps/collab`: `checkpoints.ts` (the timing scheduler), `remote-state.ts` (last presenter state, in memory), `hooks.ts` (`onChange` for editors, `onStateless` for presenter state), `internal-api.ts` (snapshot, restore, broadcast, remote command and state).
- `apps/worker`: `retention.ts` (daily: version retention and removal of expired remote sessions).
- `apps/web`: `comments.functions.ts`, `comments.server.ts`, `comment-placement.ts`, `versions.functions.ts`, `remote.functions.ts`, `remote.server.ts` (token and session checks, rate limit, phone handlers), `remote.deps.server.ts`, the phone API routes `api/remote/$token/{state,command}.ts`; editor components `components/editor/comments/*`, `HistoryPanel.tsx`, `history-model.ts`; present components `present-channel.ts`, `remote-channel.ts`, `RemotePanel.tsx`, `PresenterView.tsx`; routes `_authed/d/$deckId/presenter.tsx`, `r/$token.tsx`; the MCP tools in `lib/mcp/server.ts`.

**Comments.**
- **Data.** Threads hold the slide, an optional element, the anchor `{x, y}` in slide coordinates (1920 by 1080), resolution, and the creator. Comments hold the author, the body (at most 5000 characters, also enforced by a database check constraint), the mention ids, edit time and a soft-delete time. Deleting keeps the row, so a thread keeps its shape for everyone.
- **Mentions.** A mention is the markup `@[Name](userId)`, written by the mention picker. The server reads the ids from the body, keeps only the ids of current deck members, and stores them. A mention is never trusted from the client. Mention notifications are in-app only: a badge on the Comments tab and on the dashboard, and a Mentions list. Opening the list records the time, and mentions newer than that are unread.
- **Permissions.** Commenters, editors and owners start threads and reply. A user edits or deletes only their own comments (the author check is in the data layer, so it holds for every role). Editors and owners resolve or reopen. Viewers read. The role checks are in the server functions and the MCP tools, through the same role helpers as the rest of the app.
- **Live.** A write goes to the database, then the collab service broadcasts `{channel: 'comments', type: 'comments', threadId}` as a stateless message to every connection on the deck. Each client fetches that one thread again and replaces it locally. The broadcast is best effort: if the collab service is down, the write still stands and collaborators see it on their next load.
- **Pins and anchors.** A thread on an element is pinned to the element's top-right corner when it is created, and the pin stays there if the element moves later. A slide thread is pinned to the centre unless the client gives an anchor. Pins are numbered per slide in creation order, the same number as in the panel.
- **Removed things.** A thread whose element is deleted stays and says "element removed". A thread whose slide is gone (for example after a restore) stays and says "slide removed". Neither is deleted.
- **Commenter mode.** A commenter opens the editor read-only with the "Commenting" badge and the Comments tab open. The fieldset that disables editing does not wrap the comment panels.

**Version history.**
- **Checkpoints** (`checkpoints.ts`, fake-clock tests). The first edit by an authenticated user starts two timers: an idle timer of two minutes, restarted by each edit, and a maximum of ten minutes. Whichever fires first writes an automatic checkpoint and clears both. The next edit starts them again. So a steady stream of edits gives a checkpoint about every ten minutes, and a pause gives one two minutes after it begins. A load does not count as an edit (its change has no user), so opening a deck writes nothing. The checkpoint is the live document's full state (so unsaved edits are included), written under the deck row lock. Its editors are the five most recent distinct users who edited (`deck_snapshots.editors`), and its author is the most recent one. MCP edits count as the token's user when the internal call names one.
- **Named versions** are snapshots of the live state with a name. "Before restore" is an automatic snapshot with a name set, so it is kept like a named version.
- **Retention** (`snapshotsToKeep`, pure and tested with a fixed clock, plus database tests). The newest snapshot of any kind is always kept, because a load starts from it.

| Kind | Kept |
|---|---|
| Named, or any snapshot with a name (including "Before restore") | Forever |
| Automatic, up to 24 hours old | All |
| Automatic, 1 to 7 days old | The newest per clock hour |
| Automatic, 7 to 90 days old | The newest per UTC day |
| Automatic, older than 90 days | Deleted |
| Internal (first open, log compaction) | Only the newest one in the deck |

  The job (`apps/worker/src/retention.ts`) runs one minute after the worker starts and then every 24 hours. Each deck is pruned under its row lock. Phone-remote session rows older than a day are removed in the same run. This is a decision: M1b's note said old compaction snapshots are kept for M7 history. They are not history (the automatic checkpoints are), and keeping every compaction state would grow storage without a reader for them.
- **Restore** (`handleRestore` in the collab internal API). The target deck is validated first, so a bad target writes nothing and returns 422. Then the current live state is saved as "Before restore", and the live document's content is replaced in one transaction with origin `server:restore` (`replaceDeckContent`). The result is exactly the target deck, and connected clients converge through the normal update path. The spec allowed this in place of deck-ops. Restore is not part of the local undo stack, which tracks only local edits, so Undo does not revert it. To go back, restore "Before restore".
- **Preview and diff.** A preview reads the snapshot and renders it read-only in the canvas, with the toolbar, formula bar, side panel and filmstrip edit actions disabled. The summary compares it with the current deck: slides only in the version, slides only in the current deck, slides changed, and whether the title differs. Viewers may preview; only editors and owners restore or name versions.
- **Listing.** History lists named versions first, then automatic checkpoints grouped by day, with the editors' initials. The list is fetched when the tab opens, after a naming or a restore, and on Refresh. It does not poll, so a checkpoint written while the tab is open appears on the next refresh.

**Presenter mode and phone remote.**
- **Presenter view.** The audience window (`/d/<id>/present`) is the reveal.js presentation. The presenter view (`/d/<id>/presenter`) shows the current and next slide, the notes, the elapsed time and clock, the slide counter, Prev and Next, and the remote panel. The two windows talk over `BroadcastChannel('sleid-present:<sid>')`. The presenter view needs no collab connection, because the audience window does the collab work. S in the audience window opens the presenter view for the same session. A session id is random (16 bytes), and a link without one gets one.
- **Notes popup.** The reveal.js notes plugin is no longer loaded, so the S key does not compete with its popup. The popup was not tested in a browser before this change, so whether it would have been blocked is not known. The in-app view replaces it either way.
- **Live deck.** The present and presenter routes read the live document through the collab service when it is up (`getPresentDeckFn`), and the saved state otherwise. A presentation opened right after an edit or a restore therefore shows the current deck. This resolves the M2 gap for these routes. The check that found it: after a restore, the audience window showed the four-slide state from before it.
- **Remote channel.** The phone does not open a collab socket. It has no login, and a collab token would need one. So the phone talks HTTP to the web app (`/api/remote/<token>/state` and `/command`), and the web app forwards each command to the collab internal API, which broadcasts `{channel: 'remote:<sid>', type: 'command', action}` to the deck. The audience window receives it and moves the reveal. The audience window publishes its state (slide, total, notes, title) on the same channel, and the collab service keeps the last state in memory for the phone (`remote-state.ts`, two hours at most) and relays it to everyone on the deck. The audience window sends its state every three seconds (a heartbeat), because the phone treats a presenter silent for ten seconds as not open, and a late follower needs the current slide.
- **Follow.** A viewer opens `/d/<id>/present?follow=<sid>`. It connects read-only and moves to each state the presenter reports. It cannot control the presenter.
- **Remote security.**
  - A remote token is `base64url(claims).base64url(HMAC-SHA256)`, with the claims `{deckId, sid, userId, exp}`. The HMAC key is derived from `COLLAB_TOKEN_SECRET` with a fixed label, so a collab token is never valid as a remote token (tested).
  - The token lasts 30 minutes. `createRemoteSessionFn` issues it to any user who can present (viewers and up), for their own session.
  - Each session has a row in `remote_sessions`. Closing the remote, or closing the presenter window (on `pagehide`), sets `revoked_at`. Every command and state read checks the row (not revoked, same deck, same user), then the user's current role on the deck. A removed presenter is refused on the next call.
  - Commands are limited to 20 per session per 10 seconds, per web process (the same in-memory fixed window as MCP).
  - Clients cannot send commands. The collab service accepts from clients only a `remote:` state message of a fixed shape, at most 16 KB, and drops everything else.
  - The phone page sends no referrer and is not indexed. The shared root layout still loads the Google Fonts stylesheet, as every page does.
  - The token is in the URL path, so it can reach server logs and browser history. This is accepted and documented in the README.
- **Deviations and limits.**
  - The reveal notes popup is not used (see above).
  - The phone's Next moves reveal one step, so a fragment counts as a step.
  - Hidden slides are not checked in the presentation.

**MCP.** `list_comments` (`decks:read`, viewers and up), `add_comment` (`decks:write`, commenters and up), `list_versions` (`decks:read`), `restore_version` (`decks:write`, editors and owners). The tool list in `mcp.integration.test.ts` now has 23 names, and one new integration test covers a commenter, a viewer, an editor and a bad version id, with a real collab write.

**Schema and migration.** Migration `0010` creates `comment_threads`, `comments` (with the length check and a GIN index on `mentions`), `comment_mention_reads`, and `remote_sessions`, and adds `deck_snapshots.kind` (default `internal`, so existing rows are internal) and `deck_snapshots.editors`. `drizzle-kit generate` produced it, and it was applied to the local database.

**Deviations from the M7 brief.**
- `comments.mentions` and `deck_snapshots.editors` are `text[]`, not `uuid[]`. User ids are text (Better Auth), as everywhere else in the schema.
- The phone's commands go through the web app and the collab internal API (described above), not through a collab socket from the phone.
- Present and presenter read the live deck (above).
- Restore uses `replaceDeckContent`, a single transaction, instead of a diff of ops. The brief allowed either.
- The diff summary compares the version with the current deck, one way: slides only in the version, only in the current deck, changed.
- "Before restore" is an automatic snapshot with a name, not a named one. The brief called it a named auto version.
- Compaction states are not history (see retention).
- `deck_snapshots.kind` has three values: `auto`, `named`, and `internal` (new, for first-open and compaction states).
- `getDeckStateFn` and the base64 helper were removed when the present routes changed. Nothing else used them.

**Known gaps and limitations (decisions to revisit).**
- **A viewer who knows a session id can change what the phone shows** (the slide and notes) until the presenter's next heartbeat, three seconds later. The session id is in the follow link, which viewers have. The phone cannot be controlled this way, and the presenter's own window is not affected. The fix is a per-session key that only the presenter holds. Not built.
- **Presenter state is in memory per collab process.** A collab restart clears it. The audience window's heartbeat puts it back within three seconds, while that window is open.
- **Rate limit and command counts are per web process.** Several web processes get the limit each.
- **Snapshot size.** Every automatic checkpoint and named version stores the full document state, not a delta. A deck with large images (images are stored as data URLs in the document) makes large snapshots, and the retention policy can keep several hundred for one deck (an estimate). Storage was not measured.
- **Thread loading** reads all threads of a deck in one call, with no paging.
- **Mentions** are resolved when the comment is written. A person added to the deck later is not mentioned in older comments.
- **Undo does not revert a restore**, and a local Undo after a restore can re-apply an earlier local edit over the restored content. Not checked in a browser.
- **Notifications** are the in-app badge and the Mentions list only (as the brief said). There is no email.
- **Multi-process collab** is still unsupported (as in M2). The checkpoint timers and the remote state live in one process.
- **The retention job** was tested with fake timers and with a prune of one deck in the real database. It has not run on its own in a worker for a day.

### M7 verification

Run on this machine: macOS, Node 24.14, pnpm 10.4.1, Postgres 17 (compose, 127.0.0.1:5433), Google Chrome (`CHROME_PATH`), used by the worker too. Dev stack: `pnpm dev` with `SLEID_TEST_AUTH=1`, a scratch `LLM_SECRET_KEY`, `LLM_USER_ALLOW_PRIVATE_URLS=1`, the collab secrets, and for the wizard `SEARXNG_URL=http://127.0.0.1:4412` and `SLEID_TEST_PRIVATE_WIZARD_URLS=1` with `node tests/fake-searxng.mjs 4412` running.

- `pnpm typecheck`: exit 0 in every workspace (13 `tsc --noEmit` runs).
- `CHROME_PATH=… pnpm test` (root): **66 files, 722 tests, all passing, none skipped** (exit 0). M6 had 53 files and 649 tests. The new coverage:
  - `packages/model`: comment markup (mention round trip, body parsing, plain text, validation), the version diff, and `replaceDeckContent` (one update, origin, a refused target changes nothing, a concurrent edit converges).
  - `packages/db`: retention by kind and age with a fixed clock; snapshot writes, listing without internal states, reading a version, pruning in Postgres; comment permissions by role; threads, replies, edit and delete by author only, resolve and reopen, filtering, mentions limited to members, the mention list with unread counts; remote token sign, verify, expiry, tampering, wrong secret and collab tokens refused; remote session create, reuse, revoke, pruning.
  - `apps/collab`: checkpoint timing with fake timers (idle, maximum interval under continuous edits, restart after a checkpoint, editors, two decks, failure, dispose); the remote state store; integration against real Postgres and real Hocuspocus clients: a named version keeps unsaved edits; restore converges two connected clients to exactly the target and writes "Before restore"; a bad restore target returns 422 and writes nothing; a broadcast reaches a viewer; presenter state reaches followers and the store; a client's own command or comment message reaches nobody; an edit starts an automatic checkpoint that records its editor.
  - `apps/worker`: the retention job's schedule with stand-ins for the prune steps, and its prune of one deck in the real database.
  - `apps/web`: anchors and the comment broadcast; the phone's server rules against real Postgres (expired token 410, closed remote 410, lost access 403, command routing, 429 with `Retry-After` after 20 commands, 409 when no presenter window is open, presenter staleness); pins, pin numbers, the element-removed and slide-removed labels, history grouping, session ids and URLs; the MCP tool list and the comment and version integration test.
  - Two kinds of test change were made for timing only. Two Mermaid tests that load the library cold got a 30-second timeout, because under full-suite load the first load took more than 5 seconds. The retention database test prunes its own deck, so it does not wait on every deck in the local database.
- Browser checks against the dev stack, all passing (exit 0 each). Their output is in the session scratchpad.
  - `smoke.mjs`: 22 checks.
  - `collab.mjs`: 24 checks.
  - `export.mjs`: 21 checks.
  - `ai.mjs`: 32 checks.
  - `mcp.mjs`: 19 checks.
  - `wizard.mjs`: 34 checks (with the fake SearXNG, research on).
  - `m7.mjs` (new): 45 checks, with no page or console errors. The only console entries filtered out are the phone's 410 responses after the remote is closed, which is the refusal under test.
  - What `m7.mjs` covers. A (owner), B (commenter) and C (viewer). B pins a comment with an `@` mention of A. A sees it live, between about 100 and 250 ms after B posted it across runs (budget 3 seconds), with the Comments dot and the banner, and the filmstrip count. The dashboard shows the mention badge and the Mentions list, and opening the list clears it. A replies and resolves; B sees the thread leave its open list. A deletes the commented element and the thread says "element removed". A names v1 (History), adds a slide and a title, previews v1 (three slides, the diff text, the editing controls off), restores it, and B converges to v1 (three slides, title "Quarterly v1") without a reload. "Before restore" appears in History. A opens the audience window from Present, presses S, and gets the presenter view on the same session. A makes the remote and reads the QR link from the DOM; the QR is an SVG. A phone context (390 by 844, touch) opens the link, shows Connected and 1 / 3, taps Next twice, and the audience window is on slide 3 with the phone showing slide 3's notes. C follows the presenter: slide 3, then slide 2 after Prev, then slide 3 after Next. Closing the remote stops the phone.
- Screenshots, in `SCREENSHOT_DIR` (`/private/tmp/claude-501/-Users-rosdyanakusuma-Ross-projects-sleid/c1400ba8-0388-449b-ad43-785f923a7331/scratchpad/shots-m7`): `comments.png`, `history-preview.png`, `presenter.png`, `phone-remote.png` (390 by 844). I looked at each. The presenter layout was fixed after the first look (the QR panel had squeezed the notes), and the first comment screenshot showed a typing bug in the mention caret (fixed, and the test now checks the full comment text).
- Fixes made during the run, each covered by a rerun: the mention caret placement; the toolbar and side panel are disabled during a version preview; the Comments and History tabs fit the panel; the present and presenter routes read the live deck; the presenter heartbeat; the presenter column layout; the timestamp width in History.

### Unverified in M7

- The reveal.js notes popup: not checked in a browser (see the decision above).
- Firefox and Safari. Chrome only.
- A real phone and a real network. The phone was emulated in Chrome with a 390 by 844 touch viewport.
- A QR code scanned by a camera. The URL was read from the DOM and checked.
- Long decks, many threads, and a deck with large images: performance and snapshot size.
- Two web processes or two collab processes (the limits are per process, as above).
- The retention job running daily in a worker over real time.
- Undo after a restore, in a browser.
- Hidden slides in presentations, the phone and follow mode.
- A follower who joins mid-presentation while the heartbeat is the only source of state (the follow check started after the presenter's last change, so it relied on the heartbeat).
- Mentions of a person added to the deck after the comment was written.
- Notifications beyond the in-app badge and list (no email, as the brief said).

## M8: Import (PowerPoint, Google Slides, Markdown, JSON)

Scope: the import core (converters, `import_jobs`, the worker job, the upload API and the MCP tool) from the first two commits of M8, then the three parts that finish it: Google Slides by public link (path A), Google Slides by the Drive Picker (path B), and the Import UI with the MCP body cap. Branch `m8-import`, not pushed.

**Layout.**
- `packages/pptx/src/import`: the PPTX converter (zip, package, theme, slide, chart, XML). `packages/model/src/import-json.ts`: the JSON format. `packages/render/src/markdown.ts`: Markdown.
- `packages/db`: `schema/imports.ts` (`import_jobs`, enums `import_format` with `google-slides`, `import_status`), `import-jobs.ts` (rows, the per-user count), `import-deck.ts` (the deck, its images and its first snapshot in one transaction). Migrations `0011_m8_import_jobs.sql` and `0012_m8_import_title.sql`.
- `apps/worker/src/import`: `runner.ts` (one job, end to end), `service.ts` (the queue).
- `apps/web/src/lib`: `import.server.ts` (the rules: the size caps, the magic bytes, the rate limit, the upload and status; the storage and queue are injected), `import.functions.ts` (server functions), `google-slides.ts` (the link parser, the redirect allowlist, the test override; pure), `google-slides.server.ts` (path A fetch), `google-drive-account.ts` (the account rules: scopes, Picker config, access token; pure), `google-drive.server.ts` (path B wiring and the live deps), `drive.server.ts` (the `DriveExporter`).
- `apps/web/src/routes/api/imports.ts` (`POST /api/imports`), `apps/web/src/lib/mcp/server.ts` (`import_deck`).
- `apps/web/src/components/import`: `ImportDialog.tsx`, `import-client.ts` (upload and polling), `import-format.ts`, `google-picker.ts` (the Picker, loaded on click only).
- Dashboard `routes/_authed/index.tsx` (the New split button), editor `MenuBar.tsx` (File ▸ Import slides…) and `EditorShell.tsx` (the dialog).
- Browser check `apps/web/tests/m8.mjs` (`test:e2e:m8`).

**What an import does.** The web app checks the bytes, stores them under `import/<id>`, inserts a `queued` row and queues a job, then answers 202 with the import id. The worker converts the file (PPTX, Markdown or JSON; a Google Slides import is a PPTX and takes the same path), moves the images into assets, creates the deck with its owner membership and its first snapshot, and records `done` with the deck id and the warnings. The dialog polls `getImportFn` once a second. A failure is written to the row with a message the user can read, and the uploaded bytes are deleted in every case.

**Decisions.**
- **Conversion runs in the worker.** A large PPTX takes seconds, so the request only stores and queues. The editor, the MCP tool and the dialog all wait for the same row. Concurrency is 2 (`import` queue).
- **MCP waits up to 60 seconds** (`IMPORT_WAIT_MS`). If the worker has finished by then, `import_deck` returns the deck id and URL with the warnings. If not, it returns an error that gives the import id, and says the import keeps running and to look for the deck with `list_decks`. A failed import returns its message as the tool error.
- **Security caps.** PPTX: 50 MB upload, 50 MB zip, 200 MB uncompressed, 5000 entries, 10 MB per image (the same as the editor's upload). Markdown and JSON: 5 MB, UTF-8, no NUL bytes; JSON must parse. Google Slides: the export is read while streaming, and stops at 50 MB even without a length header. The MCP request body is capped at 16 MB (see below).
- **Magic bytes, not the file name.** The extension picks the format for the dialog only. The server checks a PPTX for the zip local-file header (`PK`) before anything is stored, so a text file renamed to `.pptx` is refused at upload with "This is not a PowerPoint file: its content is not a zip package." The worker checks again while converting, through the zip reader.
- **Rate limit.** Ten imports per user per hour, counted in Postgres under an advisory lock on the user id, so it holds across processes. Failed imports count, because each one costs a fetch or a conversion.
- **Google Slides, path A (public link).** The link is parsed strictly: https, host `docs.google.com` (no port, no user name), path `/presentation/d/<id>/…`, an id of at least 20 letters, digits, `_` or `-`. The export URL is `https://docs.google.com/presentation/d/<id>/export/pptx`, fetched through the same pinned fetch the wizard uses for URL references (`createPinnedFetch`, which checks every address and connects only to the vetted ones). Redirects are followed by hand, at most 5, and each target must be `https` to `docs.google.com` or to a subdomain of `googleusercontent.com` (the bare domain is refused), on the default port. An HTML answer (Google's login page for a private presentation) or a 401 or 403 becomes "This presentation isn't public. Share it as 'Anyone with the link' or use Google Drive." The file id is recorded in `import_jobs.google_file_id`, and the format is `google-slides`.
- **Google Slides, path B (Drive Picker).**
  - *Consent is incremental.* `auth.server.ts` sets `accessType: 'offline'` for Google, so a refresh token is issued at sign-in. Connecting Drive calls `authClient.linkSocial({ provider: 'google', scopes: ['https://www.googleapis.com/auth/drive.file'], callbackURL })` (Better Auth 1.7.15 `linkSocial` with `scopes`). Better Auth merges the scope into the existing Google account row (`linkOAuthAccount` in `oauth2/link-account.mjs`), so a later sign-in does not ask for Drive.
  - *Tokens come from Better Auth.* The server finds the user's Google account row, checks that its `scope` includes `drive.file`, and calls `auth.api.getAccessToken({ body: { accountId, userId } })`. Better Auth refreshes the token when it is about to expire (`getValidAccessToken`). A missing scope asks the user to connect Drive (409). A failed refresh (revoked access) becomes the reconnect message (403).
  - *The Picker needs the token in the browser.* Google's Picker lists the user's files only with an OAuth token from the page, so `drivePickerTokenFn` returns the user's access token to the signed-in user who asked for it. The token carries the scopes Google granted that account (the sign-in scopes and `drive.file`), and it is used for the Picker alone. The Drive export itself runs on the server. This is a decision to review: the token is in the page's memory while the Picker is open. The alternative (a server-side Picker) does not exist.
  - *The export.* `DriveExporter.exportPptx` calls `GET https://www.googleapis.com/drive/v3/files/<id>/export?mimeType=application/vnd.openxmlformats-officedocument.presentationml.presentation` with the bearer token, with redirects refused. A 401 or 403 becomes "Google Drive refused access to this presentation. Reconnect Google Drive and try again." A 404 says the file was not found, a 429 or 5xx says Drive is busy, and anything else says it cannot be exported. The same 50 MB cap and zip check apply.
  - *Picker configuration.* `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER` both set (the number digits only) turn the button on. `googleImportConfigFn` sends them to the signed-in user. The API key is a browser key: Google's Picker needs it in the page, so it is not a secret, and it should be restricted to the Picker API and the origin (documented in `.env.example` and the README).
- **Test override for path A.** `SLEID_TEST_GOOGLE_EXPORT_ORIGIN=http://127.0.0.1:4413` replaces `https://docs.google.com` as the export origin, and only that origin is added to the redirect allowlist. It is honoured only when `SLEID_TEST_AUTH=1` (the same gate as the test login), it is refused outright when `NODE_ENV=production`, and it must be a local http origin. The link parser still accepts only `docs.google.com`, so the test exercises the real parser.
- **MCP body cap raised to 16 MB** (`MCP_MAX_BODY_BYTES` default, was 1 MB). The MCP handler buffers the whole body in memory, so the cap bounds memory per request: one request can hold the 16 MB body, its JSON text and the decoded PPTX (about 12 MB), so a few tens of MB at most per request, multiplied by the number of concurrent requests. The effective cap for `import_deck` is a pptx of about 12 MB (base64 adds a third). The tool's description and its `contentBase64` limit say so, and the README and `.env.example` give the same figure. Larger decks use the editor's import, which takes 50 MB.
- **The theme is not guaranteed to round-trip through our own exporter.** The importer reads a basic theme only (colours and fonts, best effort). `m8.mjs` imports a deck with the default theme, and the imported deck shows the PowerPoint theme name "Office Theme". A custom theme (brand colours, fonts) was not tested, so whether it comes back is unknown. Native text, shapes, tables, charts, images and notes do come across (checked in `m8.mjs`).

**Warnings.** The converter lists what it left out, one line each: a shape that is not supported (for example a wave is dropped, a rectangle is used for an unsupported preset), a picture that is missing or too large (over 10 MB), a chart type that is not supported, an unsupported object, a gradient background imported as its first colour, and a slide missing from the file. Markdown and JSON produce none. The dialog shows the count and the list, collapsed.

**Errors the user sees.** Refusals at upload or at the Slides link are shown inline on the form, with the server's message. A conversion failure (the worker) is shown on the result screen with the row's message. The generic failure text is "The file could not be imported. Check that it is a valid file of the chosen type and try again." (the converter's own messages are shown when they are written for users).

### M8 verification

Run on this machine: macOS, Node 24.14, pnpm 10.4.1, Postgres 17 (compose, 127.0.0.1:5433), Google Chrome (`CHROME_PATH`). Dev stack: `pnpm dev` with `SLEID_TEST_AUTH=1`, `SLEID_TEST_GOOGLE_EXPORT_ORIGIN=http://127.0.0.1:4413`, a scratch `LLM_SECRET_KEY`, `LLM_USER_ALLOW_PRIVATE_URLS=1`, `SLEID_TEST_PRIVATE_WIZARD_URLS=1`, `SEARXNG_URL=http://127.0.0.1:4412` with `node tests/fake-searxng.mjs 4412` running.

- `pnpm typecheck`: exit 0 in every workspace.
- `CHROME_PATH=… pnpm test` (root): **76 files, 824 tests, all passing**. The baseline the brief named was 71 files and 779 tests. The new coverage: `google-slides.test.ts` (the link parser, the redirect allowlist, the test-origin gate), `google-slides.server.test.ts` (redirects, the allowlist, the HTML-means-private case, the streaming cap, the override against a local server through the real pinned fetch), `drive.server.test.ts` (against a local fake Drive server: the success with its bearer token, the 403 reconnect message, the declared and streamed size caps, a non-zip answer, 404, 503, a refused connection), `google-drive-account.test.ts` (scopes, connected state, the token and the reconnect cases, the Picker config), `import-format.test.ts`, and the DB test of a Google import row (`google-slides` with its file id).
- `pnpm --filter @sleid/web build`: exit 0.
- Browser checks against the dev stack, all passing (exit 0 each): `smoke` 22 checks, `collab` 24, `export` 21, `ai` 32, `mcp` 22, `wizard` 34 (with the fake SearXNG), `m7` 45, and `m8` 30 (new).
- What `m8.mjs` covers. Owner A seeds a deck (three slides, a chart, a table, an uploaded image, notes), exports it as PPTX from File ▸ Download, and imports it through the Import dialog on the dashboard. The new deck has three slides, the notes, the chart and table on slide 2 and the image on slide 3. The chart draws in the editor. Present opens on slide 2 and shows the chart and the table. Then Markdown is imported from File ▸ Import slides… (the deck opens in a new tab; two slides, title from the front matter), JSON from the dashboard (the same number of slides and the new title), and a public Google Slides link through the test override (three slides, and the result lists the warning about the unsupported shape it adds to the served copy). A private link shows the share message, a link to another host is refused with the paste message, and a text file named `.pptx` is refused with "This is not a PowerPoint file: its content is not a zip package." The run ends with no page or console errors. The rate-limit message was not checked (optional, and it would need eleven imports).
- The `m8.mjs` check found three problems in its own first drafts, and they were fixed in the test, not the app: the present check expected slide 1 when the window opens on the current slide; the private-link and bad-link refusals are inline errors on the form (so the footer is "Cancel", not "Close"); and the text-file refusal arrives as a start error, not a failed row, which the test already handles.
- The existing suites were updated for the new dashboard labels ("New", and "More ways to start a deck" then "From wizard"): `smoke`, `collab`, `export`, `ai`, `m7`, `mcp` and `wizard`.
- Screenshots, in `/private/tmp/claude-501/-Users-rosdyanakusuma-Ross-projects-sleid/c1400ba8-0388-449b-ad43-785f923a7331/scratchpad/shots-m8/`: `import-dialog.png` (the File tab), `import-result.png` (the result with its warning expanded), `imported-pptx-editor.png` (the imported deck, with the chart on slide 2), `imported-pptx-present.png` (present mode on slide 2). Each was looked at; the split button's caret was enlarged after the first look.

### Unverified in M8

- **Real Google, nothing here touched it.** The OAuth consent for `drive.file` through `linkSocial({ scopes })`, the refresh token from `accessType: 'offline'`, the Picker's rendering and its callback, the Drive export and its response, and the public `docs.google.com` export with its real redirect chain (to `googleusercontent.com`) and its real login page for a private file. The tests used fake servers that imitate the shapes the code expects. Google documents a size limit on Drive's `files.export` response, which the 50 MB cap does not reflect. Check it on a real file before relying on a big deck.
- **Real files.** The PPTX tests used our own export of a seeded deck, plus one synthetic unsupported shape. Real PowerPoint files (themes, masters, SmartArt, grouped shapes, embedded fonts), Keynote exports and Google's own PPTX exports were not imported. The importer's fidelity on those is unknown.
- Firefox and Safari. Chrome only.
- A deck near the 50 MB limit: the time to convert and the memory of the worker were not measured.
- The rate limit's message (not checked in the browser).

### Known gaps (M8)

- **No insert into the current deck.** Every import makes a new deck. Importing slides into the deck that is open is not built.
- **The mark-done failure edge.** The worker creates the deck and its snapshot in one transaction, then marks the row `done` in a separate statement. If that last write fails (the database is down between the two), the row is set to `failed` and the deck stays. A retry creates a second deck. The fix is to mark the row in the same transaction as the deck; not built.
- **The theme does not round-trip** (see the decision above).
- **The Picker token** is visible to the page while the Picker is open (see the decision above).
- **Rate limit and body cap are per process.** The MCP cap is per request, and the memory bound is per process (concurrent requests add up).
- **Polling.** The dialog polls once a second and stops after five minutes, with a message that the import keeps running in the background. A deck that appears after that is found on the dashboard.
- **Images over 10 MB** in a PPTX are left out, with a warning. Larger images in the editor's own upload (10 MB) and in the export match.

## M9: Templates and brand kits (in progress)

**State: UI built, browser check not written.** Part A (the built-in templates, the brand kit model, the logo overlay, the AI brand constraint, the library tables and the MCP tools) is in `6ffc2af` and `bb8b81a`. Part B is the backend fixes listed under *Done in part B*. Part C is the UI: the dashboard start row and gallery, Save as template, the Brand kits and Templates settings pages (linked from a shared settings nav), the editor's Brand kit section, and the wizard's template and kit pickers. The `m9` browser check (`apps/web/tests/m9.mjs`) is **not** written, so status row 9 stays open.

**Done in part B.**
- **Wizard.** `templateId` (a user template uuid, or `builtin:<key>`) and `brandKitId` are optional on the brief (`packages/llm/src/wizard-schema.ts`). Creation checks that the caller can read each one (built-in, owned, or instance-visible) and answers "not found" otherwise, the same as a missing one. A brief with a kit and the AI theme is refused: the kit's palette is the rule for colours, and the AI theme invents them.
- **Template start.** The run takes the template's theme. The outline is drafted with the template's layouts (in first-use order, only the layouts the wizard writes) as the preferred layouts. The slide layouts themselves come from the outline, as before. The brief's theme choice is ignored when a template is chosen.
- **Kit start.** The worker applies the kit (`setBrandKit`: theme, brand reference, and the logo copied into the deck as its own asset, the same as `applyBrandKit`) **before the first slide**. Each slide is then written against the deck's brand, so `writeWizardSlide` snaps its colours to the palette. Applying the kit in the first slide's batch would have written slide 1 without the constraint; the test checks this.
- **A kit that is gone** (deleted or no longer readable when generation runs) fails the run with a message and writes nothing.
- **Thumbnails.** `GET /api/templates/:id/thumbnail`: a session is required for every template (401 without one). A user template follows its visibility (owner, or instance; otherwise 404). A template whose thumbnail is not rendered yet is 404. Built-in thumbnails are pre-rendered by the worker at start-up, in the background, for each built-in template that has no file yet (`renderMissingBuiltInThumbnails`). Storage keys: `template-thumbs/<id>.png`, and `template-thumbs/builtin-<key>.png` for built-ins (keys may not hold a colon). `templateThumbnailKey` in `@sleid/db` is the one place that decides the key.
- **Thumbnail job on save.** Saving a template queues `template-thumbnail` (already wired in part A; now covered by a test that the save enqueues it, and by `apps/worker/src/thumbnail.integration.test.ts`, which runs the job through pg-boss, the export service and Chrome, and checks the PNG and the row's key). `createJobQueue` takes `thumbnailQueueName` so a test can use its own queue.
- **Mermaid.** Diagrams use mermaid's `base` theme, with the deck's colours and body font (`packages/model/src/mermaid-theme.ts`). It is used by the HTML and PDF pages (`packages/render`), by the worker's diagram images for PPTX, and by the editor's diagram view. Before this, a dark deck got white boxes with black text.
- **Table header text.** The contrast helper moved from `packages/llm/src/contrast.ts` to `packages/model/src/contrast.ts` (render and pptx cannot depend on llm; llm imports it from model now). `readableTextOn(fill, preferred)` picks the theme's text colour when it reads on the fill, otherwise white or near-black. Render, the editor and the PPTX export all use it for a header with a fill. The editor's header now uses the table's own `headerFill` (before, it always used the surface colour and ignored the fill), so the three outputs agree.

**Decisions (M9).**
- The logo is copied into the deck as its own asset (the same as `applyBrandKit`), so a deck does not depend on the kit's storage key, and deleting a kit leaves its decks with their logos.
- Template images are stored as data URLs in the template row, with the 30 MB total cap (`TEMPLATE_IMAGE_TOTAL_BYTES`). A template's images are not assets of the deck it came from.
- The AI constraint is frozen at apply time: the palette and fonts are copied into `deck.brand` when the kit is applied, and the constraint reads those, not the theme (`brandConstraintFromRef`).
- `generateTheme` is refused on a branded deck (`generate-theme.ts`), and the wizard refuses the AI theme with a kit at creation.
- SVG logos are accepted (the same rule as the deck's SVG images: no scripts, served with `Content-Security-Policy: sandbox`). The logo is drawn as a slide overlay, not an element, so it does not move with a selection.
- Templates are stored without a brand reference (`saveTemplateFromDeck` drops `brand`). A template carries its theme and slides, not a kit.
- Built-in thumbnails are rendered at worker start-up, not on request: a gallery request never waits for Chrome, and a built-in with no file yet is a plain card.

**Verification so far.**
- `pnpm typecheck`: exit 0.
- `pnpm --filter @sleid/web build`: exit 0 (regenerates the route tree).
- `CHROME_PATH=... rtk proxy pnpm test`: 83 files, 900 tests, all passed (baseline 81 and 885). The two new files are `packages/llm/src/wizard-template.test.ts` and `apps/worker/src/thumbnail.integration.test.ts`.
- `apps/worker/scripts/m9-render-check.ts` re-run: the Project kickoff mermaid diagram draws on the dark theme (light labels, dark boxes); the Quarterly review table header is white on the blue fill; the Project kickoff table header is near-black on yellow.

**Unverified and open.**
- The `m9` browser check (`apps/web/tests/m9.mjs`): **not written**. The earlier browser suites other than smoke (collab, export, ai, mcp, wizard, m7, m8) were not re-run for part C.
- Part C was checked with scratch Playwright scripts (not committed): the gallery, Save as template, the kit editor with a logo, the kit applied in the editor (logo on the canvas), the templates page, the wizard pickers and submit. Viewers and commenters get the Brand kit section disabled in code only (the side panel's read-only fieldset, and the server refuses the change); not checked in a browser.
- A template saved just now shows a placeholder in the gallery until the gallery is reopened: the list is read on open, and the thumbnail may still be rendering.
- The PPTX table header colour was checked in the code and in unit tests of the colour rule, not by opening the file in PowerPoint or LibreOffice.
- The editor's Mermaid theme was not looked at in a browser.
- `apps/worker/src/thumbnail.integration.test.ts` returns early (passes without asserting) when Chrome cannot start. It prints a message when that happens.

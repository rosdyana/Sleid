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
- Compaction runs when the update log passes 200 rows. It writes a new snapshot and deletes the updates it folded in. Old snapshots are kept, since M7 version history needs them. Storage grows with every compaction; pruning is not decided.
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
- **Restricted does not remove people who joined through the link.** A redeemed link adds a membership row, and restricting the link does not remove it. The owner removes those people in the people list. A `via` column on `deck_members` would fix this and is a decision for you.
- **Mid-session role changes are enforced on the server, but the editor UI keeps its role until reload.** After a downgrade, the server refuses the user's writes, but their local edits still show, and the status stays "Saving…" until reload. After an upgrade, the UI stays read-only until reload. If the internal API is down, the change applies on the next connect.
- **Rich text is last-writer-wins per element** (opaque JSON, unchanged from M1b). Two people typing into the same text box at the same time overwrite each other. Upgrade path: a `Y.XmlFragment` per text element bound with `y-prosemirror`. Only `ydoc.ts` and `ops.ts` change, because the rest of the app goes through them. Speaker notes are also a plain string, last-writer-wins.
- **Edits made offline** live in the browser's document until the connection returns. Closing the tab while offline loses them, and the page asks for confirmation when there are unsaved changes.
- **The token is checked at connect.** A live connection stays open past the token's five-minute expiry. Role changes are re-checked by `revalidate`, but a token expiry is not enforced on live connections. The provider reconnects with a new token.
- **Presence colours and cursors are client-chosen.** Identity is stamped by the server; the rest is not checked.
- **Present reads the persisted state** (`getDeckStateFn`), so it can miss the last ~2 seconds of live edits.
- **Single collab process.** The per-document state vectors live in memory. Two collab processes on one deck would each store, which is not supported.
- **No email for invites.** Pending invites appear when the invited address signs in.
- **Dashboard titles** come from the database at page load. They lag the document by up to ~2 seconds.
- **Commenter UI** is read-only, the same as viewer. Comments are M7.
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
| Diagram (`diagram`) | PNG of the Mermaid output, rendered by Chrome at the element's size. If the PNG fails, the source is written as monospace text. | Matches the Chrome render. Not editable in PowerPoint. | XML: picture present (with a PNG passed in), source text present (without). Render: the diagram on the chart slide. |
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
- Every adapter applies a timeout, honours the caller's `AbortSignal`, retries 429 and 5xx at most twice (honouring `Retry-After`), and maps failures to `auth`, `rate-limit`, `bad-request`, `network`, `timeout`, `server`, `invalid-output` or `aborted`. Messages run through `redact`/`scrubError` with the request's secrets, and nothing in `packages/llm` logs.

**Structured output (`structured.ts`).** One call. The reply is parsed after repair: the literal text, then the text without fences, then the first balanced `{...}`, each also without trailing commas. A reply that fails validation gets one corrective request that includes the zod issues. A second failure is `LlmError('invalid-output')`. Compact mode strips `description`, `title`, `examples` and `default` from the JSON Schema, which is what small local models need. Abilities keep their schemas; "fewer optional fields" is not automated.

**Abilities, prompts and op allowlists.** Every prompt is built in its ability file from `ROLE` and `SAFETY_RULES` (`abilities/common.ts`, `context.ts`) and a task sentence. The chat system prompt and the tool descriptions are `CHAT_SYSTEM` and `CHAT_TOOLS` in `abilities/chat.ts`. The allowlist is `ABILITY_OPS` in `abilities/index.ts`, and a test pins it.

| Ability | Ops it may propose | What the model returns | Built by code |
|---|---|---|---|
| `rewriteText` (improve, shorten, expand, formal, casual, translate, fix-grammar, bulletize, custom) | `updateElement` | `{ paragraphs[] }` | Rich text from paragraphs (bullet list for bulletize). The model never writes rich-text JSON. |
| `generateSlide` | `addSlide`, `addElement` (to fill an empty slide) | layout, title, subtitle, bullets, notes | Placeholders from the model package, then `layoutGuard` (96 px margins, stacking, shortening). Image layouts are not offered. |
| `generateChart` | `addElement`, `updateElement` (to change an existing chart) | chart type, title, legend, and data only when none was given | The data always comes from the input (selection or pasted), so the model cannot change it. Numeric strings become numbers. |
| `generateDiagram` | `addElement`, `updateElement` | title, Mermaid source | `validateMermaid` (first keyword from the allowlist, size, no script). One corrective retry for the Mermaid problem only. |
| `generateTheme` | `setTheme` | colours and two fonts from a fixed list | `enforceThemeContrast`: text and muted text 4.5:1, accents 3:1 on the background. Each adjustment is listed on the card. |
| `suggestEffects` | `updateSlide` (transition, auto-animate), `updateElement` (animation) | per slide: transition, auto-animate, animations | At most 4 animations per slide, orders renumbered from 0, unknown element ids dropped. Only requested slides. |
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

### M4 verification

Run on this machine: macOS, Node 24.14, pnpm 10.4.1, Postgres 17 (compose, 127.0.0.1:5433), Google Chrome through `CHROME_PATH`. The dev stack ran with `SLEID_TEST_AUTH=1`, `COLLAB_TOKEN_SECRET`, `COLLAB_INTERNAL_SECRET` and a scratch `LLM_SECRET_KEY` passed in the environment (not written to `.env`). The fake model server is `apps/web/tests/fake-openai-server.mjs`, started by `tests/ai.mjs`.

- `pnpm typecheck`: exit 0 in every workspace. `tsc --noUnusedLocals --noUnusedParameters` is clean for `packages/llm`, `packages/db` and the M4 files in `apps/web`. Two findings predate M4 and were left alone: an unused `useMemo` import in `EditorShell.tsx` and an unused `a` in `MenuBar.tsx`.
- `CHROME_PATH=… pnpm test` (root): **36 files, 335 tests, all passing, none skipped.** M3 had 22 files and 197 tests. The M4 files are 14 files and 138 tests:
  - `packages/llm` (11 files): contrast (WCAG ratios, shade search, theme enforcement, and the built-in themes); layout guard (margins, stacking, shortening, idempotence); Mermaid (keyword allowlist, comments, fences, script rejection); JSON repair; retry (429 and 5xx at most twice, no retry for other kinds, abort during a wait); secret box (round trip, fresh IV, wrong key, tampering, key format); structured (repair, corrective retry with the issues, typed failure, provider errors pass through, compact schemas); the **Foundry adapter** against a fake Anthropic-Messages endpoint (request shape: model, forced tool, `tool_choice`, `x-api-key`, path under `/anthropic/`, no temperature; 429 with `Retry-After`; 5xx retried twice; 401 once and not in the message or the logs; abort; timeout; SSE stream; picture blocks; tool-use blocks); the **OpenAI-shaped adapters** against a fake `chat/completions` endpoint (Azure URL and `api-key`; `json_schema`; forced tool; the fallback from `json_schema` to tools and to the prompt mode, remembered per instance; 429; redaction of a key echoed by the server; SSE with text and tool deltas; bearer only when a key is set; unreachable server; invalid reply; images only when supported); the **abilities** with scripted replies (each applies cleanly to a fixture deck; the allowlist; the Mermaid retry; the theme contrast fix; suggestions capped at four; notes only for requested slides; alt text with and without pictures; explain changes nothing); **prompt injection** (the deck text reaches the model only in the delimited block, the rules are in the system prompt, a rewrite that tries to delete a slide still yields only `updateElement`, `deleteSlide` is refused by the allowlist, delimiters cannot be closed by deck text); the context budget; the chat loop (tool results return to the model, invalid tool input is reported and the chat continues, `apply_ops` is checked, the step cap, a user message is needed).
  - `apps/web` (3 files, against Postgres): configuration parsing; provider settings (encrypted save, key never in a response, visibility, admin-only workspace providers, key kept on edit, refusal without `LLM_SECRET_KEY`, endpoint checks, one default per user, the server default is read-only, resolution with the stored key sent as the bearer token, Test connection OK and scrubbed on failure, rate limit counts failed requests, editors only); the chat route (401, 400, 403 for a viewer, 400 for a non-member, 409 with no provider, NDJSON with text, a tool call becoming a proposal, one usage row, and a failure line with the key redacted).
- `pnpm --filter @sleid/web build`: exit 0. The client JavaScript contains no `createCipheriv`, `node:crypto`, `foundry`, `LLM_SECRET_KEY`, `DATABASE_URL` or `COLLAB_INTERNAL_SECRET`.
- Browser checks, all against the dev stack, with the final code:
  - `apps/web/tests/smoke.mjs`: **passed**, 22 checks, no page or console errors.
  - `apps/web/tests/collab.mjs`: **passed**, 24 checks, no page or console errors.
  - `apps/web/tests/export.mjs`: **passed**, 21 checks, no page or console errors.
  - `apps/web/tests/ai.mjs` (new): **passed**, 32 checks, no page or console errors. It covers: add the fake local model in Settings › AI; Test connection → "OK · fake-local · N ms"; the key is not in the page; the fx-bar Ask AI makes a slide proposal; Preview shows the slide with the ribbon and the filmstrip shows it; Apply adds it; Undo removes it; Redo brings it back; Ask AI ▸ Shorten replaces the text with the shorter text; a chart from a prompt in the panel; Apply adds the chart; Tools ▸ Generate theme with a brand colour gives "Brand Calm" with the contrast adjustment listed; Apply changes the theme; a second browser (editor) sees the new slide within 143 ms of A's Apply click and sees the theme; a viewer has no AI tab, no Ask AI button and no composer; the chat route answers 403 to the viewer; the fake server received the key only as the bearer token and never in a body; the slide ability used a JSON schema request; the chat used a streamed request.
- Screenshots (under `SCREENSHOT_DIR`, which was the session scratchpad): `ai-settings.png` (the provider list with Test connection OK), `ai-preview.png` (the Preview ribbon, the previewed slide in the canvas and filmstrip, and the card), and `ai-panel.png` (the panel with the applied shorten card, the chart request and its card). I looked at all three.

### Unverified in M4

- **Live Claude on Foundry.** No Foundry credentials were available. The request shape, headers, tool use, errors and retries are tested against a fake Anthropic-Messages endpoint only. The SDK versions are pinned, but the live response was not seen.
- **Live Azure OpenAI.** Same position: the URL, headers and both structured modes are tested against a fake endpoint only.
- **Live local servers** (Ollama, LM Studio, llama.cpp, vLLM). No server was run. The fake endpoint covers `json_schema`, forced tools, the JSON-only fallback, and SSE. Real refusals of `response_format`, and whether each model follows the schema, were not seen. The LM Studio steps in the README (the Developer tab) are from the app's UI, not checked on a machine.
- **Output quality.** Every reply in the tests and the browser checks is scripted. No real model wrote a slide, a chart, a theme or a note, so the usefulness of the prompts is unverified.
- **Pictures for alt text** with a real vision model. The bytes path is tested with a fake provider only.
- **Rate limit under concurrency** across processes, and the Stop button's server-side abort (the signal is wired and read, but not tested).
- **Firefox and Safari.** Chrome only.
- **Production serving** (`node .output/server/index.mjs`) of the assistant. The build passes; the server was not run.
- **Live multi-user timing** beyond one collaborator and one viewer.

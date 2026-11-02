# Sleid: web slide editor (reveal.js, Sheets-style UI, live co-edit, AI + MCP)

## Status

Living document. Update it as decisions change.

| Milestone | State |
|---|---|
| 0. Scaffold monorepo, compose, Better Auth Google login, Drizzle schema, DESIGN.md + README | **Done** (checks run, see below) |
| 1a. Model (zod schema, Yjs binding, deck-ops, undo) + reveal.js renderer + Markdown | **Done** (checks run, see M1a below) |
| 1b. Sheets-style editor UI, single user, reveal.js present, slide ordering fix | **Done** (checks run, see M1b below) |
| 2. Hocuspocus live co-edit, presence, sharing and roles, link tokens | **Done** (checks run, see M2 below; open gaps listed there) |
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

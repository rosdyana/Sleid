# Sleid

A lightweight web slide editor with a Google Sheets-style interface, Google-only sign-in, live co-editing with presence and sharing, export (PDF, PPTX, PNG, JPG, HTML, Markdown, JSON), publish to web, an AI assistant on your own model provider, and (planned) MCP. Design, decisions and known gaps: [docs/DESIGN.md](docs/DESIGN.md).

Status: **milestone 4** (AI assistant: pluggable providers, proposals you preview and apply). See the status table in DESIGN.md.

## Layout

```
apps/web        TanStack Start app: UI, server functions, /api/auth, /api/health
apps/collab     Hocuspocus WebSocket server (Yjs), auth, persistence, internal API
apps/worker     export worker: pg-boss consumer, Chrome for PDF/PNG/diagrams, PPTX, HTML zip
packages/db     @sleid/db: Drizzle schema, DB client, deck persistence, roles, sharing, collab tokens, assets, exports, publish
packages/storage @sleid/storage: storage driver (local disk; S3 stub), data directory resolution
packages/jobs   @sleid/jobs: pg-boss queue wrapper (export jobs)
packages/pptx   @sleid/pptx: deck to PPTX (pptxgenjs, native text, shapes, tables, charts)
packages/model  deck schema, Yjs binding, deck-ops
packages/render deck to reveal.js HTML
packages/llm    @sleid/llm: provider adapters (Claude on Foundry, Azure OpenAI, local OpenAI-compatible), structured output, assistant abilities
packages/*      placeholders: ui
compose.yml     local Postgres 17 on 127.0.0.1:5433 (no collab container yet, see below)
```

## Prerequisites

- Node 24, pnpm 10.4.1 (`corepack enable` or `npm i -g pnpm@10.4.1`)
- Docker (for local Postgres)
- Chromium for the browser checks: `pnpm exec playwright install chromium`, or point `CHROME_PATH` at an installed Chrome

## Setup

```bash
pnpm install
cp .env.example .env
openssl rand -base64 32     # BETTER_AUTH_SECRET
openssl rand -base64 48     # COLLAB_TOKEN_SECRET (at least 32 characters)
openssl rand -hex 24        # COLLAB_INTERNAL_SECRET (at least 16 characters)
```

Paste those values into `.env`. Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (see below), then:

```bash
docker compose up -d db     # Postgres on 127.0.0.1:5433
pnpm db:migrate             # applies apps/web/drizzle/*.sql
pnpm dev                    # web on http://localhost:3000, collab on ws://localhost:3001, export worker
```

Open http://localhost:3000, sign in with Google, and click **Blank deck**. Open the same deck in a second browser profile (or a private window) to see live co-editing.

`pnpm dev` runs all three services. If `COLLAB_TOKEN_SECRET` or `COLLAB_INTERNAL_SECRET` is missing, the collab service exits at startup with a message that names the variable.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | web, collab | Postgres connection |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | web | Session signing and the public origin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web | Google sign-in |
| `SLEID_TEST_AUTH` | web | `1` enables email+password sign-in for the browser checks. Refused when `NODE_ENV=production`. |
| `COLLAB_TOKEN_SECRET` | web (signs), collab (verifies) | HMAC key for the 5-minute collab tokens. At least 32 characters. Must match in both. |
| `MCP_RATE_LIMIT_PER_MINUTE` | web | Calls to `/mcp` per token per minute (default 120). Counted per process, in memory. |
| `MCP_MAX_BODY_BYTES` | web | Largest request body accepted by `/mcp` (default 1048576). |
| `COLLAB_INTERNAL_SECRET` | web, collab | Sent as `x-sleid-internal` on every internal API call. At least 16 characters. |
| `COLLAB_PORT` | collab | WebSocket port, default `3001` |
| `COLLAB_HOST` | collab | WebSocket bind address, default `127.0.0.1`. Use `0.0.0.0` only in a container. |
| `COLLAB_INTERNAL_PORT`, `COLLAB_INTERNAL_HOST` | collab | Internal API listener, default `127.0.0.1:3002`. It is never on the WebSocket port. |
| `COLLAB_INTERNAL_URL` | web | Where web reaches the internal API, default `http://127.0.0.1:3002` |
| `VITE_COLLAB_URL` | web (browser) | WebSocket URL the editor connects to, default `ws://localhost:3001` |
| `STORAGE_DRIVER` | web, worker | `local` (default). `s3` is a stub and refuses to start. |
| `ASSET_DIR` | web, worker | Uploaded images. Default `data/assets` under the repository root. |
| `EXPORT_DIR` | web, worker | Finished exports. Default `data/exports` under the repository root. |
| `CHROME_PATH` | worker | Chrome for PDF, PNG/JPG and PPTX diagrams. Empty uses Playwright's bundled Chromium. |
| `EXPORT_CONCURRENCY` | worker | Export jobs at once, 1 to 32. Default 2. |
| `EXPORT_TMP_DIR` | worker | Scratch folder for export work. Default: the OS temp directory. |
| `LLM_SECRET_KEY` | web | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts saved provider keys (AES-256-GCM). Without it a key cannot be saved. |
| `ADMIN_EMAILS` | web | Comma-separated administrator emails. Only they can add or change workspace providers. |
| `SLEID_LLM_KIND`, `SLEID_LLM_ENDPOINT`, `SLEID_LLM_API_KEY`, `SLEID_LLM_MODEL`, `SLEID_LLM_API_VERSION`, `SLEID_LLM_STRUCTURED`, `SLEID_LLM_SUPPORTS_IMAGES`, `SLEID_LLM_NAME` | web | Optional server-wide default provider (see AI assistant below). |
| `AI_RATE_LIMIT_MAX`, `AI_RATE_LIMIT_WINDOW_SECONDS` | web | Assistant requests per user in a sliding window. Default 30 per 600 seconds. |
| `LLM_USER_ALLOW_PRIVATE_URLS` | web | `1` lets a user's own AI provider use loopback and private addresses (a local Ollama or LM Studio). Off by default. See the note below. |

**AI provider endpoints.** Every provider endpoint is checked when it is saved and before each request. A user's own provider may not point at loopback, private, shared (CGNAT) or other non-public addresses, so the server cannot be used to reach its own services (for example the collab internal API on `127.0.0.1:3002`). Link-local and cloud-metadata addresses (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`) are refused for every provider, always. Workspace providers (added by an administrator) and the server default may use private addresses.

- **Local, single-user setup:** set `LLM_USER_ALLOW_PRIVATE_URLS=1` in `.env`, then add the local server (for example `http://127.0.0.1:11434/v1`) as your own provider.
- **Shared setup:** leave the flag off, and have an administrator (`ADMIN_EMAILS`) add the local server as a workspace provider.

Anyone who can set the flag, or who uses a user provider on a private network, can probe that network through the error messages, so keep it off on a multi-user server.

## Google OAuth client

1. Open the Google Cloud Console, choose or create a project, and go to **APIs & Services → Credentials**.
2. If prompted, configure the OAuth consent screen (External, add your account as a test user).
3. **Create credentials → OAuth client ID → Application type: Web application.**
4. Under **Authorized JavaScript origins** add `http://localhost:3000`.
5. Under **Authorized redirect URIs** add `http://localhost:3000/api/auth/callback/google`.
6. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Without these values the Google button will fail at sign-in. The server logs a warning at startup.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Web (port 3000), collab (port 3001) and the export worker together |
| `pnpm build` | Build every workspace that has a build script (apps/web) |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm test` | Vitest across apps/* and packages/*. DB tests need Postgres on 127.0.0.1:5433 and skip with a message when it is down. |
| `pnpm db:generate` | Generate a Drizzle migration from `packages/db/src/schema` into `apps/web/drizzle` |
| `pnpm db:migrate` | Apply migrations using `DATABASE_URL` |
| `pnpm --filter @sleid/web test:e2e` | Smoke test (single user, needs the dev servers) |
| `pnpm --filter @sleid/web test:e2e:collab` | Two-browser co-editing check (needs the dev servers) |
| `pnpm --filter @sleid/web test:e2e:export` | Export, publish and public page check (needs the dev servers and Chrome) |
| `pnpm --filter @sleid/web test:e2e:ai` | Assistant check against a fake local model server (needs the dev servers, `LLM_SECRET_KEY` and Chrome) |

## Browser checks

Both checks use the test-only email+password login, so start the stack with `SLEID_TEST_AUTH=1`:

```bash
docker compose up -d db
pnpm db:migrate
SLEID_TEST_AUTH=1 pnpm dev          # terminal 1
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
SCREENSHOT_DIR=./test-results/screenshots \
  pnpm --filter @sleid/web test:e2e           # terminal 2: smoke
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
SCREENSHOT_DIR=./test-results/screenshots \
  pnpm --filter @sleid/web test:e2e:collab    # terminal 2: co-editing
```

The export check (`test:e2e:export`) builds a deck with text, a chart, an uploaded image and a Mermaid diagram, exports PDF and PPTX from the menus, verifies both files, publishes the deck, opens the public page logged out, unpublishes it, and writes PNG renders of the outputs (macOS `sips`, and LibreOffice if `soffice` is installed). It needs the worker, so it runs under `pnpm dev`.

The smoke test signs up, creates a deck, and checks the editor and the present view. The co-editing check uses three accounts. Owner A shares the deck with B by email and turns on "anyone with the link: viewer". B edits live with A. C opens the link and must stay read-only, including against a forced write with a valid viewer token. Screenshots go to `SCREENSHOT_DIR`.

The test runs need `COLLAB_TOKEN_SECRET` and `COLLAB_INTERNAL_SECRET` in the environment, because the co-editing check signs a viewer token and reads the internal API.

The assistant check (`test:e2e:ai`) needs `LLM_SECRET_KEY` as well. It starts a fake OpenAI-compatible server (`apps/web/tests/fake-openai-server.mjs`), adds it in Settings › AI, and runs the flows: generate a slide with Preview, Apply and Undo; shorten a text box; a chart from a prompt; a theme with a brand colour; a collaborator who sees the change live; and a viewer who sees no AI. It writes `ai-settings.png`, `ai-preview.png` and `ai-panel.png` to `SCREENSHOT_DIR`.

## Export

File ▸ Download in the editor:

| Item | Made by | Notes |
|---|---|---|
| PDF | worker (Chrome) | One page per visible slide, 1920 × 1080. Options: speaker notes (one extra page after each slide with notes), hidden slides. |
| PowerPoint | worker (pptxgenjs) | 16:9. Text, shapes, tables and charts are native and editable. Hidden slides are kept and marked hidden. See the fidelity table in DESIGN.md. |
| PNG / JPG | worker (Chrome) | All visible slides in a zip, or the current slide alone. Scale 0.5, 1 or 2. |
| HTML (zip) | worker | Standalone `index.html` with reveal.js inlined and the images next to it. Works offline. |
| Markdown, JSON | browser | Same as before M3. |

A worker export appears in the progress tray at the bottom right. Its download link is only offered to the person who asked for it. Exports run in `apps/worker`, so `pnpm dev` must be running for them to finish. Exports read the live document from the collab service and fall back to the saved state when it is down.

Exports never load anything from the open internet. The worker blocks every request except its own bundle server on 127.0.0.1 and `data:` URLs. Embeds and images that point at external URLs therefore come out blank in PDF and PNG, and are not fetched for PPTX.

**Publish to web** (Share dialog, owner and editor): a link like `/p/<token>` shows the presentation read-only, with no sign-in and a "Made with Sleid" footer. Search engines are asked not to index it unless you tick the option. Turning publish off clears the link.

**Images** are uploaded to `/api/decks/<deckId>/assets` (10 MB, PNG, JPEG, GIF, WebP or SVG) and stored under `ASSET_DIR`. SVG files with scripts or event handlers are refused, and SVG responses carry `Content-Security-Policy: sandbox`.

## AI assistant

Open the **AI** tab in the right panel, press **✨ Ask AI** in the formula bar, or use **Tools ▸ AI** items. Editors and owners can use it. Viewers and commenters do not see it.

Every request sends the relevant part of the deck (the theme, the slide outline, the selection, and the text you asked about) to the provider you pick. Deck text is treated as data, not as instructions. The assistant never changes the deck itself. It proposes a change as a card:

- **Preview** shows the deck with the change, on a throwaway copy, with a "Preview" ribbon. Nothing is saved.
- **Apply** makes the change like any edit, through the live document. Undo (Ctrl+Z) reverts it, and collaborators see it.
- **Discard** drops it.

Each card shows the provider, the model, token counts and any warnings (for example, a colour adjusted for contrast, or alt text written without seeing the picture).

### Set up a provider

Open **Settings › AI** from the dashboard (the **AI settings** link). **Add provider** takes these fields. **Test connection** sends one short request and reports OK with the model and the latency, or the reason it failed. The key is stored encrypted and is never shown again; the page shows `••••• set`. To change it, type a new key. To keep it, leave the field empty.

Set `LLM_SECRET_KEY` in `.env` before you add a key (`openssl rand -base64 32`). Restart `pnpm dev` after changing `.env`.

**Claude on Microsoft Foundry** (the same deployment papereview uses)

- In Settings › AI choose *Claude on Microsoft Foundry*. For **Resource name or endpoint URL** enter your resource name (for example `my-resource`), or the portal URL `https://my-resource.services.ai.azure.com/anthropic/`. For **Deployment name** enter `claude-opus-5-5` (or your deployment). Paste the resource's API key. Keep *Structured output* on Automatic.
- Or set it for the whole deployment:

  ```bash
  SLEID_LLM_KIND=foundry-claude
  SLEID_LLM_ENDPOINT=my-resource          # or https://my-resource.services.ai.azure.com/anthropic/
  SLEID_LLM_API_KEY=...                   # the Foundry resource key
  SLEID_LLM_MODEL=claude-opus-5-5         # your deployment name
  SLEID_LLM_SUPPORTS_IMAGES=true          # alt text can look at pictures
  ```

**Azure OpenAI** (or any Foundry OpenAI-compatible deployment)

- Choose *Azure OpenAI*. **Endpoint**: `https://<resource>.openai.azure.com`. **Deployment name**: the name you gave the model deployment. **API version** is optional (default `2024-10-21`). Paste the key from *Keys and Endpoint*.
- Or set it for the whole deployment:

  ```bash
  SLEID_LLM_KIND=azure-openai
  SLEID_LLM_ENDPOINT=https://<resource>.openai.azure.com
  SLEID_LLM_API_KEY=...
  SLEID_LLM_MODEL=<deployment-name>
  SLEID_LLM_API_VERSION=2024-10-21
  ```

**Ollama** (local)

1. Install Ollama and run `ollama pull qwen2.5:7b` (any chat model works). Ollama serves on port 11434.
2. In Settings › AI choose *Local model*. **Base URL**: `http://127.0.0.1:11434/v1`. **Model name**: `qwen2.5:7b`. Leave the key empty.
3. Or: `SLEID_LLM_KIND=openai-compatible`, `SLEID_LLM_ENDPOINT=http://127.0.0.1:11434/v1`, `SLEID_LLM_MODEL=qwen2.5:7b`.

**LM Studio** (local)

1. In LM Studio load a model, open the Developer tab and start the server. It serves on port 1234 by default.
2. In Settings › AI choose *Local model*. **Base URL**: `http://127.0.0.1:1234/v1`. **Model name**: the identifier LM Studio shows for the loaded model. The key is optional (LM Studio's default is none).

**llama.cpp** and **vLLM** use the same *Local model* choice with `http://127.0.0.1:8080/v1` (`llama-server -m model.gguf --port 8080`) or `http://<host>:8000/v1` (vLLM).

Small local models sometimes ignore the JSON schema. If a proposal fails with "not the expected format", set *Structured output* to *JSON-only prompt*, or set `SLEID_LLM_STRUCTURED=prompt`. A model that does not accept pictures must leave *This model accepts pictures* off (or `SLEID_LLM_SUPPORTS_IMAGES=false`).

**Provider options** (Settings › AI, per provider)

- **Compact prompts** sends smaller schemas (no descriptions) and is on by default for *Local model* providers and off for Claude on Foundry and Azure OpenAI. Turn it off for a large local model that follows the full schema better. The server default (`SLEID_LLM_*`) follows the same kind default, and has no switch of its own.
- **Turn off thinking** (*Local model* only) sends `chat_template_kwargs: {"enable_thinking": false}`, for reasoning models such as Qwen3 served with thinking on. **Reasoning effort** (*Local model* only) sends `reasoning_effort` (low, medium or high). Each one is tried on the first request; if the server rejects the parameter, it is dropped for that provider and the request is sent again without it. Both are off by default.
- Reasoning models send their thinking separately from the answer, and the thinking uses the same token budget. If a reply runs out of budget with no answer, the assistant retries once with a bigger budget. If that is still empty, the message says to raise the budget or to turn thinking off for this provider.
- Structured requests to a *Local model* server stream the reply and collect it before it is checked. This keeps a proxy in front of a slow server from closing the connection. If the server refuses streaming, the assistant sends a plain request instead.

Usage counts are kept per request. A user can make `AI_RATE_LIMIT_MAX` requests per `AI_RATE_LIMIT_WINDOW_SECONDS` (default 30 per 10 minutes). The limit is checked in the database, so it holds across processes.

Status of the live runs: the adapters are tested against fake HTTP servers. A live run against Foundry or a local server has **not** been done for this milestone. See DESIGN.md (M4, unverified).

## Prompt-to-deck wizard and research (M6)

From the dashboard, **✨ New from prompt** (or File ▸ From prompt…) makes a whole deck: brief, optional references (files and web addresses), optional research, an outline you can edit, then slides written into the editor as they are made. The wizard uses your AI provider (see AI assistant above). It needs the collab service (`pnpm dev` runs it) and the worker (`pnpm dev` runs it too, when `COLLAB_INTERNAL_SECRET` is set).

**References.** Up to 10 files (PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, PNG, JPG; 20 MB each, 50 MB in all) and 10 web addresses. Text is extracted on the worker. Images are listed by name only (no OCR).

**Research (optional).** "Let AI research this topic" needs a search provider. Set one of these in `.env`; the first one set is used:

| Provider | Variable | Notes |
|---|---|---|
| SearXNG (self-hosted, recommended) | `SEARXNG_URL=http://127.0.0.1:8888` | Its host is the one private address research may reach. Start it with `docker compose --profile research up -d searxng`. The compose service uses `deploy/searxng/settings.yml`, which turns on JSON output. Set `SEARXNG_SECRET` first for anything but local use. |
| Brave Search API | `BRAVE_API_KEY` | Hosted. The key is sent only to `api.search.brave.com`. |
| Tavily | `TAVILY_API_KEY` | Hosted. The key is sent only to `api.tavily.com`. |

The AI settings page (Settings › AI) shows which provider is active, never the key. With none set, the research box is disabled and says why.

**Safety.** User-supplied web addresses always go through the SSRF-safe fetch: loopback, private, link-local and metadata addresses are refused on every redirect hop, with a 5 MB cap, a 15 s timeout, and only HTML, PDF, text and CSV read. Reference text is untrusted: it is wrapped as data for the model, and the model's answer can only become an `addSlide` operation. Robots.txt is not checked (see docs/DESIGN.md).

**MCP.** `create_deck_from_prompt` (scopes `decks:create` and `ai`) and `get_wizard_status` (scope `decks:read`).

## MCP (AI agents)

Sleid runs an MCP server at `/mcp` (Streamable HTTP). An agent can create decks, add slides, insert charts and diagrams, look at a slide as a PNG, export the deck and share it, using the same deck operations as the editor. Open editors see every change live.

**1. Create a token.** Open **Extensions ▸ MCP access tokens** (or `/settings/tokens`). Choose a name, the scopes, an expiry (30 days to 1 year, 90 by default) and whether the token reaches all your decks or only some. The token is shown once. Copy it then.

**2. Connect a client.**

- **Claude Code** (run in a terminal):

  ```sh
  claude mcp add --transport http sleid http://localhost:3000/mcp --header "Authorization: Bearer <token>"
  claude mcp list   # sleid should show ✔ Connected
  ```

  Use your public origin in place of `http://localhost:3000` on a deployed server. The settings page shows this command with your token filled in.

- **Other clients that speak HTTP MCP** with custom headers: use the JSON on the settings page. The entry is `{"type": "http", "url": "<origin>/mcp", "headers": {"Authorization": "Bearer <token>"}}`.

- **Claude Desktop and clients without header support:** they need a bridge that carries the header. For example `npx -y mcp-remote <origin>/mcp --header "Authorization: Bearer <token>"`. This has not been run against Sleid, so check it on your machine. Desktop's own "custom connector" flow expects OAuth, which Sleid does not offer yet.

**Scopes.** A token can do only what its scopes allow. Each call also checks your current role on the deck, so removing someone's access takes effect on their next call.

| Scope | Allows |
|---|---|
| `decks:read` | `list_decks`, `get_deck`, `render_slide`, the deck resource |
| `decks:write` | `apply_ops`, the slide, text, chart, diagram, image and theme tools, `share_deck`. Needs editor access on each deck. |
| `decks:create` | `create_deck` |
| `exports` | `export_deck`. Viewers can export, as in the editor. |
| `ai` | `generate_with_ai`. Needs editor access. Uses your AI provider and its limits. |

**Tools.** `list_decks`, `create_deck`, `get_deck` (outline or JSON), `apply_ops`, `add_slide`, `update_text`, `set_notes`, `delete_slide`, `move_slide`, `insert_chart`, `insert_diagram` (Mermaid is parsed first, and a parse error comes back to the agent), `insert_image`, `set_theme`, `render_slide`, `export_deck`, `share_deck`, `generate_with_ai` (returns proposed ops and changes nothing; the agent then calls `apply_ops`). Resources: `sleid://schema/deck`, `sleid://schema/ops`, `sleid://themes`, `sleid://decks/{deckId}`. Prompt: `build_deck`.

**Exports from MCP.** `export_deck` returns a one-time link, valid for 15 minutes, to a file on the server. It carries its own secret, never the token. The link works once, after the export has finished (a request before that gets 409 and the link is kept). Do not share it.

**Safety notes.** Tokens are stored as SHA-256 hashes. Every tool call is recorded in the `mcp_audit` table (user, token, tool, deck, outcome, time, and the short error text). Revoke a token in the same settings page; it stops working at once. The rate limit and the body cap are per process, so a deployment with several web processes gets the limit per process.

## Sharing

Open **Share** in the title bar. Owners and editors can invite by email as editor, commenter or viewer. Invites for an email that has no account yet wait until that email signs in. The owner changes roles, removes people, and sets general access (Restricted, or Anyone with the link at a chosen role). Links look like `/d/<deckId>?share=<token>`. A signed-out visitor is sent to `/login` and returns to the link after signing in.

Commenters and viewers get a read-only editor with a "View only" badge. The server enforces this too: their connection cannot write to the document.

## Database

- Schema: `packages/db/src/schema/` (Better Auth tables, `decks` with publish fields, `deck_members` with per-user `starred`, `share_links`, `invites`, `deck_snapshots`, `deck_updates`, `assets`, `exports`).
- Migrations: `apps/web/drizzle/`. The schema lives in `@sleid/db`, and drizzle-kit reads it from there. Regenerate with `pnpm db:generate` after schema changes and commit the SQL.
- Migration `0001` moves `starred` from `decks` to `deck_members` and copies the value to every member. Its data copy is hand-written. Check it when you change the migration.
- Migration `0002` adds `assets`, `exports`, and the publish columns on `decks`.
- Migrations run as the compose user. There is no row-level security or separate app role yet.

## Notes

- Port 5433 is used on purpose so this compose Postgres can run next to untumu's on 5432.
- The collab service is not in `compose.yml` yet. It runs with `pnpm dev`. A container image is a follow-up (see DESIGN.md).
- `apps/web/src/routeTree.gen.ts` is generated by the TanStack Start Vite plugin during `dev` and `build`. It is git-ignored.

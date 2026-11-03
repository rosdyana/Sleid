# Sleid

A self-hosted web slide editor with a spreadsheet-style interface. It offers:

- Google sign-in, and live co-editing with presence and sharing.
- Comments, version history, and a presenter view with a phone remote.
- Import from PowerPoint, Google Slides, Markdown and JSON.
- Export to PDF, PPTX, PNG, JPG, HTML, Markdown and JSON, and publishing to the web.
- Templates and brand kits.
- An AI assistant and a prompt-to-deck wizard that run on your own model provider.
- An MCP server, so AI agents can build and check decks.

Slides render with [reveal.js](https://revealjs.com). Design notes, decisions and known gaps are in [docs/DESIGN.md](docs/DESIGN.md).

## Layout

```
apps/web          TanStack Start app: UI, server functions, /api, /mcp
apps/collab       Hocuspocus WebSocket server (Yjs): auth, persistence, internal API
apps/worker       pg-boss jobs: exports (Chrome, PPTX, HTML), imports, thumbnails, the wizard
packages/model    deck schema, Yjs binding, deck operations, themes and templates
packages/render   deck to reveal.js HTML
packages/compose  layout components, text measurement, Lucide icons, lint, style extraction
packages/pptx     deck to and from PPTX
packages/db       Drizzle schema and queries: decks, roles, sharing, assets, exports, tokens
packages/llm      AI provider adapters, structured output, assistant abilities
packages/ingest   reference file and URL extraction (SSRF-safe fetch)
packages/research web search providers for the wizard
packages/jobs     pg-boss queue wrapper
packages/storage  storage driver (local disk)
deploy/           single-VM production stack (compose + Caddy)
```

## Quick start

Prerequisites:
- Node 24.
- pnpm 10 (`corepack enable`).
- Docker, for Postgres.
- Chrome or Chromium for exports. Install it with `pnpm exec playwright install chromium`, or set `CHROME_PATH` to an installed Chrome.

```bash
pnpm install
cp .env.example .env
openssl rand -base64 32     # BETTER_AUTH_SECRET
openssl rand -base64 48     # COLLAB_TOKEN_SECRET (at least 32 characters)
openssl rand -hex 24        # COLLAB_INTERNAL_SECRET (at least 16 characters)
openssl rand -base64 32     # LLM_SECRET_KEY (only needed to save AI provider keys)
```

Put those values and your Google OAuth client (see below) into `.env`, then:

```bash
docker compose up -d db     # Postgres on 127.0.0.1:5433
pnpm db:migrate
pnpm dev                    # web http://localhost:3000, collab ws://localhost:3001, worker
```

Open http://localhost:3000, sign in, and create a deck. Open it in a second browser profile to see live co-editing.

### Google OAuth client

1. In the Google Cloud Console, open **APIs & Services → Credentials**, and configure the OAuth consent screen if you are asked to.
2. **Create credentials → OAuth client ID → Web application.**
3. Add `http://localhost:3000` as an authorized JavaScript origin.
4. Add `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI.
5. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Optional, for Google Slides import from Drive:**
1. Enable the Google Picker API and the Google Drive API.
2. Create a browser API key restricted to the Picker API and your origin, and set it as `GOOGLE_PICKER_API_KEY`.
3. Set the project **number** as `GOOGLE_CLOUD_PROJECT_NUMBER`.
4. Add the `drive.file` scope to the consent screen. Sleid asks for it only when you connect Drive, and reads only the presentations you pick.

## Configuration

Every variable is listed with comments in [.env.example](.env.example). The main ones:

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | web, collab, worker | Postgres connection |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | web | Session signing and the public origin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web | Google sign-in |
| `COLLAB_TOKEN_SECRET` | web, collab | HMAC key for short-lived collab tokens. Must match in both. |
| `COLLAB_INTERNAL_SECRET` | web, collab, worker | Secret for the collab internal API (`127.0.0.1:3002` by default, never on the WebSocket port) |
| `VITE_COLLAB_URL` | web (build time) | WebSocket URL the editor connects to (default `ws://localhost:3001`) |
| `ASSET_DIR`, `EXPORT_DIR` | web, worker | Uploaded images and finished exports (default `data/assets`, `data/exports`) |
| `CHROME_PATH` | worker | Chrome for PDF, PNG and diagrams. Empty uses Playwright's Chromium. |
| `EXPORT_CONCURRENCY` | worker | Export jobs at once (default 2) |
| `LLM_SECRET_KEY` | web | Encrypts saved AI provider keys (AES-256-GCM) |
| `ADMIN_EMAILS` | web | Administrators, who can add workspace AI providers |
| `SLEID_LLM_*` | web | Optional server-wide default AI provider |
| `AI_RATE_LIMIT_MAX`, `AI_RATE_LIMIT_WINDOW_SECONDS` | web | Assistant requests per user (default 30 per 10 minutes) |
| `LLM_USER_ALLOW_PRIVATE_URLS` | web | `1` lets a user's own provider use private addresses (for a local model on a single-user setup) |
| `SEARXNG_URL`, `BRAVE_API_KEY`, `TAVILY_API_KEY` | worker | Optional search provider for wizard research |
| `MCP_RATE_LIMIT_PER_MINUTE`, `MCP_MAX_BODY_BYTES` | web | MCP limits per token (default 120 calls per minute, 16 MB bodies) |
| `SLEID_TEST_AUTH` | web | `1` enables email and password sign-in for the browser tests. Refused in production. |

## Features

### Editing and sharing
- **Share** invites people by email as editor, commenter or viewer, or opens access to anyone with the link at a chosen role. The collab server enforces roles, so commenters and viewers cannot write.
- **Comments** attach to a slide or an element, with `@` mentions.
- **Version history** keeps automatic checkpoints and named versions, and you can restore any of them.
- **Present** with F5. Press S to open the presenter view (notes, timer, next slide). A QR code opens a phone remote, which works for 30 minutes.

### Import and export
- **Import:**
  - `.pptx` files up to 50 MB, and `.md` or `.json` files up to 5 MB.
  - A public Google Slides link, or a presentation picked from Google Drive.
  - Imports run in the worker and report what was left out.
- **Export:**
  - **PDF**: optional speaker notes and hidden slides.
  - **PowerPoint**: native, editable text, shapes, tables and charts.
  - **PNG or JPG**: one slide or all of them, at 0.5×, 1× or 2×.
  - **HTML**: a zip that works offline.
  - **Markdown and JSON.**
- Exports never fetch from the internet. Images must be uploaded to the deck.
- **Publish to web** gives a read-only link at `/p/<token>`. Search engines are asked not to index it unless you allow it.

### Templates and brand kits
- Start a deck from a built-in or saved template.
- A brand kit holds a palette, fonts, a logo for light slides and one for dark slides, and footer text. Applying a kit restyles the deck, and the AI tools then stay within the kit's colours and fonts.

### AI assistant and prompt-to-deck wizard
- The assistant proposes changes as cards: Preview, Apply (undoable, live for collaborators) or Discard. It never edits on its own. Deck text is treated as data, never as instructions.
- **New from prompt** drafts an outline from a brief, optional reference files and URLs, and optional web research, then writes the slides into the editor.
- Providers, set per user in **Settings › AI** or server-wide with `SLEID_LLM_*`:
  - Claude on Microsoft Foundry.
  - Azure OpenAI.
  - Any OpenAI-compatible server, such as Ollama, LM Studio, llama.cpp or vLLM.
- Provider endpoints are checked against an SSRF policy. Link-local and cloud-metadata addresses are always refused.
- Small local models sometimes ignore JSON schemas. Set *Structured output* to *JSON-only prompt* if their proposals fail to parse.

## MCP server (AI agents)

Sleid serves MCP at `/mcp` (Streamable HTTP). Agents use the same deck operations as the editor, so open editors see every change live.

**1. Create a token** in **Extensions ▸ MCP access tokens** (`/settings/tokens`). You choose its scopes, its expiry and the decks it can reach. The token is shown once.

**2. Connect a client.**

```sh
claude mcp add --transport http sleid https://<your-host>/mcp --header "Authorization: Bearer <token>"
```

- Other clients with HTTP and custom headers use `{"type": "http", "url": "<origin>/mcp", "headers": {"Authorization": "Bearer <token>"}}`.
- Clients without header support need a bridge, for example `npx -y mcp-remote <origin>/mcp --header "Authorization: Bearer <token>"`.

### Building a deck without coordinates
1. Run `plan_deck`, or the `build_deck` prompt (`/mcp__sleid__build_deck` in Claude Code). It returns the slides, their components and the calls to make.
2. Run `create_deck` with `startEmpty: true`.
3. Optionally, run `apply_style_from_deck` to reuse a reference deck's theme, type scale, dark-slide gradient, logo and footer.
4. Run `upload_asset` for each screenshot or logo (base64, up to 5 MB).
5. Run one `add_slide` per slide with `components`. The components are `header`, `card_grid`, `browser_frame`, `timeline`, `comparison`, `numbered_cards`, `bullets_with_sublines`, `stat_row` and `footer_and_logo`.
6. Check the deck with `lint_deck` (overflow, overlap, off-slide, contrast, alt text) and `render_deck` (one contact-sheet image).

Components lay out from the theme's tokens and measure their text on the server, so a wrapping heading pushes its subtitle down. `variant: "dark"` gives a slide the theme's dark background and recolours its text. Set `secondaryLanguage` with `set_deck_options` to add a smaller second-language line under headings, card titles and bullets. `generate_with_ai` with `ability: "translate"` can fill those lines.

### Tools

| Area | Tools |
|---|---|
| Decks | `list_decks`, `create_deck`, `plan_deck`, `import_deck`, `validate_deck`, `set_deck_options`, `list_templates`, `list_brand_kits`, `apply_brand_kit` |
| Reading and checking | `get_deck` (`outline`, `json` or `compact`; `slideIds` or `range`), `get_deck_style`, `lint_deck`, `render_slide`, `render_deck`, `export_deck` |
| Slides | `add_slide`, `insert_component`, `update_component`, `update_text`, `set_notes`, `delete_slide`, `move_slide`, `insert_chart`, `insert_diagram`, `apply_ops` |
| Media | `upload_asset`, `list_assets`, `insert_image` (from a URL, fetched on the server, or by asset id), `insert_icon` (Lucide by name), `list_icons` |
| Style | `set_theme`, `derive_theme_from_deck`, `apply_style_from_deck` |
| People and AI | `share_deck`, `generate_with_ai`, `create_deck_from_prompt`, `get_wizard_status`, `list_comments`, `add_comment`, `list_versions`, `restore_version` |

Resources:
- `sleid://guide/elements`: a short element guide. Read it before `apply_ops`.
- `sleid://schema/deck` and `sleid://schema/ops`.
- `sleid://themes` and `sleid://templates`.
- `sleid://decks/{deckId}`.

The prompt is `build_deck`.

### Scopes and safety

| Scope | Allows |
|---|---|
| `decks:read` | Reading, planning, linting, rendering, `list_assets`, `list_icons`, comments and versions (viewers and up) |
| `decks:write` | Every editing tool, assets, styles, `share_deck`, `add_comment`, `restore_version`. Needs editor access (commenter for comments). |
| `decks:create` | `create_deck`, `import_deck`, `create_deck_from_prompt` (the wizard also needs `ai`) |
| `exports` | `export_deck` |
| `ai` | `generate_with_ai` (editors only; uses your AI provider and its limits) |

- Every call checks your current role on the deck.
- Tokens are stored as SHA-256 hashes, and every call is written to the `mcp_audit` table.
- `export_deck` returns a one-time download link that expires after 15 minutes.
- An asset belongs to one deck. `insert_image` with another deck's asset id, or with a library asset id, copies the file into this deck, so exports include it.
- Rate limits are counted per web process.

## Development

| Command | What it does |
|---|---|
| `pnpm dev` | Web, collab and the worker |
| `pnpm build` | Production build |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm test` | Vitest across the repository. Database tests need Postgres on 127.0.0.1:5433. Browser and export tests need `CHROME_PATH`. Each skips with a message when its dependency is missing. |
| `pnpm db:generate` | Generate a Drizzle migration from `packages/db/src/schema` into `apps/web/drizzle` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm --filter @sleid/web test:e2e[:collab\|:export\|:ai\|:mcp\|:wizard\|:m7\|:m8\|:m9]` | Browser checks in `apps/web/tests/` against a running dev stack started with `SLEID_TEST_AUTH=1`. The comment at the top of each script lists what it needs. |

`apps/web/src/routeTree.gen.ts` is generated during `dev` and `build`, and is git-ignored.

## Deployment

### Container images

`.github/workflows/docker.yml` builds three images and pushes them to GHCR. Pushes to `main` get `latest`, and `v*` tags get `X.Y.Z` and `X.Y`. Every image also gets `sha-<short>`. All images are linux/amd64.

- `ghcr.io/rosdyana/sleid-web` (port 3000). Run migrations with `docker run --rm --env-file .env ghcr.io/rosdyana/sleid-web node scripts/migrate.mjs`.
- `ghcr.io/rosdyana/sleid-collab` (WebSocket 3001, internal API 3002). Expose 3001 only. 3002 is for web (`COLLAB_INTERNAL_URL=http://collab:3002`).
- `ghcr.io/rosdyana/sleid-worker`, which includes Chromium.

Mount one shared volume at `/data` on web and worker, for assets and exports. The browser connects to `wss://<host>/collab`, so put a proxy in front that routes `/collab` to collab:3001.

### One VM with HTTPS

`deploy/compose.yml` runs Postgres, migrations, web, collab, worker and Caddy (Let's Encrypt) on one machine. Only ports 80 and 443 are public.

1. Create a VM: 2 vCPU, 8 GB RAM, a 30 GB disk, with HTTP and HTTPS allowed. Point your domain's DNS at it.
2. Install Docker: `curl -fsSL https://get.docker.com | sudo sh`.
3. Copy `deploy/compose.yml` and `deploy/.env.example` (as `.env`) to the VM, and fill in `DOMAIN`, `POSTGRES_PASSWORD`, the secrets and the Google OAuth client.
4. Add `https://<DOMAIN>/api/auth/callback/google` as a redirect URI of the OAuth client.
5. Run `docker compose pull && docker compose up -d`.

To update, run `docker compose pull && docker compose up -d`. Migrations run on every `up`. To pin a release, set `SLEID_TAG=1.2.0`. Back up the Postgres and app data volumes, and keep `LLM_SECRET_KEY` safe.

## License

MIT. See [LICENSE](LICENSE).

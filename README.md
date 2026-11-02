# Sleid

A lightweight web slide editor with a Google Sheets-style interface, Google-only sign-in, live co-editing with presence and sharing, and (planned) export, an AI assistant and MCP. Design, decisions and known gaps: [docs/DESIGN.md](docs/DESIGN.md).

Status: **milestone 2** (live co-editing through Hocuspocus, presence, roles, sharing). See the status table in DESIGN.md.

## Layout

```
apps/web        TanStack Start app: UI, server functions, /api/auth, /api/health
apps/collab     Hocuspocus WebSocket server (Yjs), auth, persistence, internal API
apps/worker     placeholder (pg-boss jobs, milestone 3)
packages/db     @sleid/db: Drizzle schema, DB client, deck persistence, roles, sharing, collab tokens
packages/model  deck schema, Yjs binding, deck-ops
packages/render deck to reveal.js HTML
packages/*      placeholders: pptx, llm, ui
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
pnpm dev                    # web on http://localhost:3000, collab on ws://localhost:3001
```

Open http://localhost:3000, sign in with Google, and click **Blank deck**. Open the same deck in a second browser profile (or a private window) to see live co-editing.

`pnpm dev` runs both services. If `COLLAB_TOKEN_SECRET` or `COLLAB_INTERNAL_SECRET` is missing, the collab service exits at startup with a message that names the variable.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | web, collab | Postgres connection |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | web | Session signing and the public origin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web | Google sign-in |
| `SLEID_TEST_AUTH` | web | `1` enables email+password sign-in for the browser checks. Refused when `NODE_ENV=production`. |
| `COLLAB_TOKEN_SECRET` | web (signs), collab (verifies) | HMAC key for the 5-minute collab tokens. At least 32 characters. Must match in both. |
| `COLLAB_INTERNAL_SECRET` | web, collab | Sent as `x-sleid-internal` on every internal API call. At least 16 characters. |
| `COLLAB_PORT` | collab | WebSocket port, default `3001` |
| `COLLAB_HOST` | collab | WebSocket bind address, default `127.0.0.1`. Use `0.0.0.0` only in a container. |
| `COLLAB_INTERNAL_PORT`, `COLLAB_INTERNAL_HOST` | collab | Internal API listener, default `127.0.0.1:3002`. It is never on the WebSocket port. |
| `COLLAB_INTERNAL_URL` | web | Where web reaches the internal API, default `http://127.0.0.1:3002` |
| `VITE_COLLAB_URL` | web (browser) | WebSocket URL the editor connects to, default `ws://localhost:3001` |

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
| `pnpm dev` | Web (port 3000) and collab (port 3001) together |
| `pnpm build` | Build every workspace that has a build script (apps/web) |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm test` | Vitest across apps/* and packages/*. DB tests need Postgres on 127.0.0.1:5433 and skip with a message when it is down. |
| `pnpm db:generate` | Generate a Drizzle migration from `packages/db/src/schema` into `apps/web/drizzle` |
| `pnpm db:migrate` | Apply migrations using `DATABASE_URL` |
| `pnpm --filter @sleid/web test:e2e` | Smoke test (single user, needs the dev servers) |
| `pnpm --filter @sleid/web test:e2e:collab` | Two-browser co-editing check (needs the dev servers) |

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

The smoke test signs up, creates a deck, and checks the editor and the present view. The co-editing check uses three accounts. Owner A shares the deck with B by email and turns on "anyone with the link: viewer". B edits live with A. C opens the link and must stay read-only, including against a forced write with a valid viewer token. Screenshots go to `SCREENSHOT_DIR`.

The test runs need `COLLAB_TOKEN_SECRET` and `COLLAB_INTERNAL_SECRET` in the environment, because the co-editing check signs a viewer token and reads the internal API.

## Sharing

Open **Share** in the title bar. Owners and editors can invite by email as editor, commenter or viewer. Invites for an email that has no account yet wait until that email signs in. The owner changes roles, removes people, and sets general access (Restricted, or Anyone with the link at a chosen role). Links look like `/d/<deckId>?share=<token>`. A signed-out visitor is sent to `/login` and returns to the link after signing in.

Commenters and viewers get a read-only editor with a "View only" badge. The server enforces this too: their connection cannot write to the document.

## Database

- Schema: `packages/db/src/schema/` (Better Auth tables, `decks`, `deck_members` with per-user `starred`, `share_links`, `invites`, `deck_snapshots`, `deck_updates`).
- Migrations: `apps/web/drizzle/`. The schema lives in `@sleid/db`, and drizzle-kit reads it from there. Regenerate with `pnpm db:generate` after schema changes and commit the SQL.
- Migration `0001` moves `starred` from `decks` to `deck_members` and copies the value to every member. Its data copy is hand-written. Check it when you change the migration.
- Migrations run as the compose user. There is no row-level security or separate app role yet.

## Notes

- Port 5433 is used on purpose so this compose Postgres can run next to untumu's on 5432.
- The collab service is not in `compose.yml` yet. It runs with `pnpm dev`. A container image is a follow-up (see DESIGN.md).
- `apps/web/src/routeTree.gen.ts` is generated by the TanStack Start Vite plugin during `dev` and `build`. It is git-ignored.

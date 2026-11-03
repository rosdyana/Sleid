# One Dockerfile, three images. Build one with --target web | collab | worker.
# collab and worker run their TypeScript source directly (Node 24 type stripping), so the runtime
# keeps the workspace layout: packages/* resolve through pnpm symlinks, outside node_modules.

ARG NODE_VERSION=24

# --- build: full install, then the web production bundle ---
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN npm install -g pnpm@10.4.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# The browser reads the collab WebSocket URL at build time (import.meta.env.VITE_COLLAB_URL).
# Empty: the browser uses wss://<page host>/collab (see deploy/compose.yml).
ARG VITE_COLLAB_URL=
ENV VITE_COLLAB_URL=${VITE_COLLAB_URL}
RUN pnpm --filter @sleid/web build

# --- runtime base: source plus production dependencies only ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN npm install -g pnpm@10.4.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
ENV NODE_ENV=production \
    STORAGE_DRIVER=local \
    ASSET_DIR=/data/assets \
    EXPORT_DIR=/data/exports
RUN mkdir -p /data/assets /data/exports && chown -R node:node /data
VOLUME /data

# --- web: TanStack Start server. Migrations: node apps/web/scripts/migrate.mjs ---
FROM runtime AS web
COPY --from=build /app/apps/web/.output /app/apps/web/.output
WORKDIR /app/apps/web
USER node
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]

# --- collab: Hocuspocus WebSocket (3001) and internal API (3002, never publish it) ---
FROM runtime AS collab
WORKDIR /app/apps/collab
USER node
ENV COLLAB_HOST=0.0.0.0 COLLAB_PORT=3001 \
    COLLAB_INTERNAL_HOST=0.0.0.0 COLLAB_INTERNAL_PORT=3002
EXPOSE 3001 3002
CMD ["node", "src/index.ts"]

# --- worker: pg-boss jobs, with Playwright's Chromium for PDF/PNG/Mermaid exports ---
FROM runtime AS worker
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app/apps/worker
RUN pnpm exec playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "src/index.ts"]

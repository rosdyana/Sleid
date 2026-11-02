import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Root config: runs unit tests across all workspaces (apps/* and packages/*).
export default defineConfig({
  resolve: { alias: { '~': fileURLToPath(new URL('./apps/web/src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.output/**'],
  },
})

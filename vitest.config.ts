import { defineConfig } from 'vitest/config';

/**
 * `node:sqlite` is newer than Vite's builtin-module list, so Vite strips the
 * `node:` prefix and then fails to resolve a package called `sqlite`. This
 * plugin short-circuits resolution and marks it external, which is what Vite
 * does for every other Node builtin.
 */
const externalizeNodeSqlite = {
  name: 'externalize-node-sqlite',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (id === 'node:sqlite' || id === 'sqlite') return '\0node:sqlite';
    return null;
  },
  load(id: string) {
    if (id !== '\0node:sqlite') return null;
    // Reach the builtin through the runtime rather than the module graph.
    return [
      "const mod = process.getBuiltinModule('node:sqlite');",
      'export const DatabaseSync = mod.DatabaseSync;',
      'export const StatementSync = mod.StatementSync;',
      'export default mod;',
    ].join('\n');
  },
};

export default defineConfig({
  plugins: [externalizeNodeSqlite],
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@anvaya/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@anvaya/sdk': new URL('./packages/sdk/src/index.ts', import.meta.url).pathname,
    },
  },
});

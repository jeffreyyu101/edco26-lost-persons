import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${root}` },
      // `import 'server-only'` is resolved by Next.js itself; under vitest it is a no-op.
      { find: /^server-only$/, replacement: `${root}tests/helpers/server-only-stub.ts` },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
          // Unit tests must never need a network or the database.
          setupFiles: ['tests/helpers/unit-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          // Loads .env.test into process.env and refuses non-local Supabase URLs.
          setupFiles: ['tests/helpers/integration-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

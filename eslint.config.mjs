// ESLint flat config. Run directly (`npm run lint` → `eslint .`); `next lint` no longer exists.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Never log PII: console use must be deliberate (route, code, error id and timing only).
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next/image', message: 'Use a plain <img>: the optimizer strips the session cookie (spec §2).' },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Node scripts and tooling may print progress.
    files: ['scripts/**', 'tests/**', 'playwright.config.ts', 'vitest.config.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Plain <img> is required (spec §2); this rule would push next/image.
    rules: { '@next/next/no-img-element': 'off' },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'next-env.d.ts',
    'design/**',
    'public/**',
    'test-results/**',
    'playwright-report/**',
    'supabase/**',
  ]),
]);

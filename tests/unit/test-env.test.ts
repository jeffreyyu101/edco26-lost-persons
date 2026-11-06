// A process started with childTestEnv() must never pick up a dotenv file through Next's loader
// (@next/env loadEnvConfig), including the dev-server reload path (forceReload) that ignores
// __NEXT_PROCESSED_ENV. Uses a fake project directory in the OS temp dir, never the real checkout. Needs no
// database, so it skips the local Supabase keys (CI runs it with no stack).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { childTestEnv, ROOT } from '../../scripts/test-env.mjs';

const dir = mkdtempSync(join(tmpdir(), 'lp-dotenv-'));
writeFileSync(join(dir, '.env.local'), 'LP_CANARY_LOCAL=leaked\n');
writeFileSync(join(dir, '.env'), 'LP_CANARY_ENV=leaked\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Loads env the way `next build` / `next start` do, then the way a dev reload does, and prints the canaries.
const probe = `
const { loadEnvConfig } = require(require.resolve('@next/env', { paths: [${JSON.stringify(join(ROOT, 'node_modules', 'next'))}] }));
const quiet = { info() {}, error() {} };
loadEnvConfig(${JSON.stringify(dir)}, false, quiet);
loadEnvConfig(${JSON.stringify(dir)}, true, quiet, true);
process.stdout.write(JSON.stringify([process.env.LP_CANARY_LOCAL ?? null, process.env.LP_CANARY_ENV ?? null]));
`;

function run(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['-e', probe], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  expect(r.stderr).toBe('');
  return JSON.parse(r.stdout) as [string | null, string | null];
}

describe('childTestEnv', () => {
  it('stops Next from loading .env.local or .env, even on a dev reload', () => {
    expect(run(childTestEnv({}, { keys: false }))).toEqual([null, null]);
  });

  it('control: without the preload the same probe does load them', () => {
    const { NODE_OPTIONS: _preload, ...withoutPreload } = childTestEnv({}, { keys: false });
    expect(run(withoutPreload)).toEqual(['leaked', 'leaked']);
  });
});

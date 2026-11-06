// The ONE place that loads the local test environment. Used by scripts/with-test-env.mjs (CLI),
// vitest (integration project) and Playwright. Types: scripts/test-env.d.mts.
//
// Rules (spec §3): tests use .env.test only — never .env.local — and refuse to run unless the Supabase
// URL host is 127.0.0.1 or localhost.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** Parses a dotenv file: KEY=value lines, # comments, optional surrounding quotes. No expansion. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** Throws unless `url` points at the local machine. */
export function assertLocalUrl(label, url) {
  const host = hostOf(url ?? '');
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`Refusing to run: ${label} host is "${host || url}", not 127.0.0.1 or localhost.`);
  }
}

/** Reads .env.test (and nothing else) and checks every URL in it is local. */
export function loadTestEnv() {
  const env = parseEnv(readFileSync(join(ROOT, '.env.test'), 'utf8'));
  assertLocalUrl('.env.test NEXT_PUBLIC_SUPABASE_URL', env.NEXT_PUBLIC_SUPABASE_URL);
  for (const [key, value] of Object.entries(env)) {
    if (/_URL$/.test(key) && value) assertLocalUrl(`.env.test ${key}`, value);
  }
  return env;
}

/** Preloaded into every test child process: makes Next.js read no .env* file at all (see that file). */
export const NO_DOTENV_PRELOAD = join(ROOT, 'scripts', 'test-env-preload.cjs');

/**
 * The environment for a child process (next build / next start / test runner) that must only ever see
 * test values: the caller's PATH/HOME-style basics, then .env.test. NODE_OPTIONS preloads
 * NO_DOTENV_PRELOAD into it and every process it starts, so Next.js never reads .env.local, .env or any
 * other dotenv file, not even on a dev-server reload. __NEXT_PROCESSED_ENV=true stays as a second guard.
 */
export function childTestEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'SHELL', 'LANG', 'TMPDIR', 'USER', 'TERM', 'CI', 'PLAYWRIGHT_BROWSERS_PATH'];
  const base = {};
  for (const key of keep) if (process.env[key] !== undefined) base[key] = process.env[key];
  const env = {
    ...base,
    ...loadTestEnv(),
    ...extra,
    NODE_OPTIONS: `--require=${JSON.stringify(NO_DOTENV_PRELOAD)}`,
    __NEXT_PROCESSED_ENV: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  assertLocalUrl('NEXT_PUBLIC_SUPABASE_URL', env.NEXT_PUBLIC_SUPABASE_URL);
  return env;
}

/** Base URL of the local test server (PORT from the environment, else .env.test, else 3100). */
export function testBaseUrl() {
  const port = process.env.PORT || loadTestEnv().PORT || '3100';
  return `http://127.0.0.1:${port}`;
}

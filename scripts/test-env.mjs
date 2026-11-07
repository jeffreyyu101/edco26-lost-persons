// The ONE place that loads the local test environment. Used by scripts/with-test-env.mjs (CLI),
// vitest (integration project) and Playwright. Types: scripts/test-env.d.mts.
//
// Rules (spec §3): tests use .env.test only — never .env.local — and refuse to run unless the Supabase
// URL host is 127.0.0.1 or localhost.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * The team join link in local tests (J1): a synthetic code that works only against a test server. Every
 * test environment turns the link on with it (INVITE_CODE_SHA256 = its SHA-256, far-off expiry) unless
 * .env.test sets its own INVITE_* values.
 */
export const TEST_INVITE_CODE = 'local-test-join-code-not-for-production-0123456789';
export const TEST_INVITE_ENV = Object.freeze({
  INVITE_CODE_SHA256: createHash('sha256').update(TEST_INVITE_CODE, 'utf8').digest('hex'),
  INVITE_EXPIRES_AT: '2099-01-01T00:00:00Z',
});

// The local Supabase keys are NOT committed (GitHub push protection rejects even the CLI's fixed local
// defaults). They come from `supabase status -o env` for this project's local stack, cached in the
// gitignored .env.test.local so it runs once.
const LOCAL_KEYS_FILE = join(ROOT, '.env.test.local');

function localSupabaseKeys(expectedUrl) {
  if (existsSync(LOCAL_KEYS_FILE)) {
    const cached = parseEnv(readFileSync(LOCAL_KEYS_FILE, 'utf8'));
    if (cached.SUPABASE_SECRET_KEY) return cached;
  }
  let out;
  try {
    out = execFileSync('supabase', ['status', '-o', 'env', '--workdir', ROOT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('Local Supabase keys unavailable: start the local stack with `supabase start` first.');
  }
  const status = parseEnv(out);
  assertLocalUrl('supabase status API_URL', status.API_URL);
  if (expectedUrl && hostOf(status.API_URL) !== hostOf(expectedUrl)) {
    throw new Error('supabase status API_URL does not match .env.test NEXT_PUBLIC_SUPABASE_URL.');
  }
  const keys = {
    SUPABASE_SECRET_KEY: status.SECRET_KEY || status.SERVICE_ROLE_KEY,
    SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY || status.ANON_KEY,
  };
  if (!keys.SUPABASE_SECRET_KEY) throw new Error('supabase status returned no secret key.');
  writeFileSync(
    LOCAL_KEYS_FILE,
    `# Generated from \`supabase status\` (local stack only). Gitignored; never commit.\n` +
      Object.entries(keys).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
    { mode: 0o600 },
  );
  return keys;
}

/**
 * Reads .env.test plus the local stack's keys (never .env.local) and checks every URL is local. The test
 * join link (TEST_INVITE_ENV) is on unless .env.test says otherwise.
 * `{ keys: false }` skips the keys, for checks that never touch the database (unit tests in CI, where no local
 * stack runs).
 */
// Web Push test keys (F4): a separate tracked file, so .env.test (rewritten per worktree for its local stack)
// never has to carry them. .env.test wins where both set a key.
const PUSH_TEST_FILE = join(ROOT, '.env.test.push');

export function loadTestEnv({ keys = true } = {}) {
  const push = existsSync(PUSH_TEST_FILE) ? parseEnv(readFileSync(PUSH_TEST_FILE, 'utf8')) : {};
  const env = { ...TEST_INVITE_ENV, ...push, ...parseEnv(readFileSync(join(ROOT, '.env.test'), 'utf8')) };
  if (keys && !env.SUPABASE_SECRET_KEY) Object.assign(env, localSupabaseKeys(env.NEXT_PUBLIC_SUPABASE_URL));
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
export function childTestEnv(extra = {}, { keys = true } = {}) {
  const keep = ['PATH', 'HOME', 'SHELL', 'LANG', 'TMPDIR', 'USER', 'TERM', 'CI', 'PLAYWRIGHT_BROWSERS_PATH'];
  const base = {};
  for (const key of keep) if (process.env[key] !== undefined) base[key] = process.env[key];
  const env = {
    ...base,
    ...loadTestEnv({ keys }),
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

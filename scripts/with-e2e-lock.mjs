#!/usr/bin/env node
// Runs a command while holding the shared local-stack lock (/tmp/lp-e2e.lock), the one Playwright's global
// setup takes. Several agents on several branches share ONE local Supabase stack and each re-applies its own
// version of the rework migration, so integration and end-to-end runs must hold the lock, and re-apply THIS
// branch's migration right after taking it (--migrate applies it twice, which also proves it is idempotent).
// Playwright started inside sees LP_E2E_LOCK_OWNER and does not wait for the lock it is already under.
//
//   node scripts/with-e2e-lock.mjs [--migrate] -- <command> [args…]
//
// LOCAL ONLY: --migrate refuses any database that is not on 127.0.0.1 / localhost.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, assertLocalUrl } from './test-env.mjs';

const LOCK_DIR = '/tmp/lp-e2e.lock';
const WAIT_MS = 30 * 60_000;
const NO_PID_GRACE_MS = 10_000;
const MIGRATION = join(ROOT, 'supabase/migrations/20261106000000_rework.sql');

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const flags = sep < 0 ? [] : args.slice(0, sep);
const command = sep < 0 ? args : args.slice(sep + 1);
if (command.length === 0) {
  console.error('usage: node scripts/with-e2e-lock.mjs [--migrate] -- <command> [args…]');
  process.exit(2);
}

const ownerPid = (dir) => {
  try {
    const pid = Number(readFileSync(`${dir}/pid`, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

function removeStale() {
  let seen;
  try {
    seen = statSync(LOCK_DIR);
  } catch {
    return false;
  }
  const pid = ownerPid(LOCK_DIR);
  if (pid === null ? Date.now() - seen.mtimeMs < NO_PID_GRACE_MS : alive(pid)) return false;
  const tomb = `${LOCK_DIR}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(LOCK_DIR, tomb);
  } catch {
    return false;
  }
  rmSync(tomb, { recursive: true, force: true });
  return true;
}

async function acquire() {
  const started = Date.now();
  let told = false;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(`${LOCK_DIR}/pid`, String(process.pid));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (removeStale()) continue;
    if (Date.now() - started > WAIT_MS) throw new Error(`timed out waiting for ${LOCK_DIR} (held by pid ${ownerPid(LOCK_DIR) ?? 'unknown'})`);
    if (!told) {
      console.error(`with-e2e-lock: waiting for ${LOCK_DIR} (held by pid ${ownerPid(LOCK_DIR) ?? 'unknown'})…`);
      told = true;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

function release() {
  if (ownerPid(LOCK_DIR) === process.pid) rmSync(LOCK_DIR, { recursive: true, force: true });
}

function dbUrl() {
  let url = process.env.SUPABASE_DB_URL;
  if (!url) {
    const out = execFileSync('supabase', ['status', '-o', 'env', '--workdir', ROOT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    url = /^DB_URL="?([^"\n]+)"?$/m.exec(out)?.[1];
  }
  if (!url) throw new Error('no local database URL (is `supabase start` running?)');
  assertLocalUrl('database URL', url);
  return url;
}

await acquire();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    release();
    process.exit(130);
  });
}
let code = 1;
try {
  if (flags.includes('--migrate')) {
    const url = dbUrl();
    for (const run of [1, 2]) {
      execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION], { stdio: ['ignore', 'ignore', 'pipe'] });
      console.error(`with-e2e-lock: rework migration applied (${run}/2)`);
    }
  }
  code = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, LP_E2E_LOCK_OWNER: String(process.pid) } });
    child.on('exit', (c, s) => resolve(c ?? (s ? 1 : 0)));
    child.on('error', () => resolve(1));
  });
} finally {
  release();
}
process.exit(code);

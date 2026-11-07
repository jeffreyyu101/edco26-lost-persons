// The cross-process e2e lock (tests/e2e/global-setup.ts, scripts/with-e2e-lock.mjs), on a private path in the OS
// temp dir (never a real /tmp/lp-e2e.lock*).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCK_DIR, acquireLock, lockDirFrom, removeStaleLock } from '../e2e/global-setup';
import { E2E_LOCK_WAIT_MS, SHARED_STACK_API_PORT, e2eLockHolder } from '../../scripts/test-env.mjs';

// Lets a test run code just before the lock's next renameSync (to interleave "another process").
const beforeRename = vi.hoisted(() => ({ once: null as null | (() => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      const hook = beforeRename.once;
      beforeRename.once = null;
      hook?.();
      fs.renameSync(from, to);
    },
  };
});

let root: string;
let lock: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-lock-'));
  lock = join(root, 'lp-e2e.lock');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const hold = (pid: number | null, ageMs = 0) => {
  mkdirSync(lock);
  if (pid !== null) writeFileSync(join(lock, 'pid'), String(pid));
  const t = new Date(Date.now() - ageMs);
  utimesSync(lock, t, t);
};
/** A pid that just exited (spawnSync reaps it). */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number;
const DAY = 24 * 60 * 60_000;

describe('e2e lock', () => {
  it('one lock per stack: /tmp/lp-e2e.lock-<port of .env.test’s Supabase URL>, the shared stack’s /tmp/lp-e2e.lock, or LP_E2E_LOCK_DIR', () => {
    expect(DEFAULT_LOCK_DIR).toBe('/tmp/lp-e2e.lock');
    // The shared stack (supabase/config.toml [api] port) keeps the lock older checkouts take.
    expect(readFileSync(join(__dirname, '../../supabase/config.toml'), 'utf8')).toMatch(new RegExp(`\\[api\\]\\nenabled = true\\nport = ${SHARED_STACK_API_PORT}\\n`));
    expect(lockDirFrom({}, `http://127.0.0.1:${SHARED_STACK_API_PORT}`)).toBe('/tmp/lp-e2e.lock');
    // An isolated stack (~/.config/lp-stacks/use.sh rewrites .env.test): its own, so runs on other stacks never wait.
    expect(lockDirFrom({}, 'http://127.0.0.1:55021')).toBe('/tmp/lp-e2e.lock-55021');
    expect(lockDirFrom({ LP_E2E_LOCK_DIR: '' }, 'http://localhost:55121')).toBe('/tmp/lp-e2e.lock-55121');
    expect(lockDirFrom({ LP_E2E_LOCK_DIR: '  ' }, 'http://127.0.0.1:55021')).toBe('/tmp/lp-e2e.lock-55021');
    // No URL, or no port in it: the shared lock.
    expect(lockDirFrom({}, '')).toBe('/tmp/lp-e2e.lock');
    expect(lockDirFrom({}, 'http://localhost')).toBe('/tmp/lp-e2e.lock');
    // LP_E2E_LOCK_DIR wins.
    expect(lockDirFrom({ LP_E2E_LOCK_DIR: '/tmp/lp-e2e.lock-s4' }, 'http://127.0.0.1:55021')).toBe('/tmp/lp-e2e.lock-s4');
    // Without a URL argument it reads .env.test (whichever stack this checkout points at).
    const envTest = readFileSync(join(__dirname, '../../.env.test'), 'utf8');
    const port = new URL((/^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m.exec(envTest)?.[1] ?? '').trim()).port;
    expect(lockDirFrom({})).toBe(port === SHARED_STACK_API_PORT ? '/tmp/lp-e2e.lock' : `/tmp/lp-e2e.lock-${port}`);
    // scripts/with-e2e-lock.mjs takes the same directory and gives up as soon.
    const script = readFileSync(join(__dirname, '../../scripts/with-e2e-lock.mjs'), 'utf8');
    expect(script).toContain('const LOCK_DIR = e2eLockDir();');
    expect(script).toContain('const WAIT_MS = E2E_LOCK_WAIT_MS;');
  });

  it('waits 2 minutes for a live holder, then names its pid and cwd', async () => {
    expect(E2E_LOCK_WAIT_MS).toBe(2 * 60_000);
    await acquireLock(lock, 1_000, 10);
    expect(readFileSync(join(lock, 'cwd'), 'utf8')).toBe(process.cwd());
    expect(e2eLockHolder(lock)).toBe(`pid ${process.pid}, cwd ${process.cwd()}`);
    await expect(acquireLock(lock, 50, 10)).rejects.toThrow(`held by pid ${process.pid}, cwd ${process.cwd()}`);
    // An owner on an older build wrote no cwd: it is looked up (lsof), else "unknown".
    rmSync(join(lock, 'cwd'));
    expect(e2eLockHolder(lock)).toMatch(new RegExp(`^pid ${process.pid}, cwd .+$`));
    rmSync(lock, { recursive: true });
    expect(e2eLockHolder(lock)).toBe('pid unknown, cwd unknown');
  });

  it('takes a free lock and records the owner pid', async () => {
    await acquireLock(lock, 1_000, 10);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid));
  });

  it('never evicts a live owner, however old the lock (incl. another user’s process)', async () => {
    for (const pid of [process.pid, 1]) {
      hold(pid, DAY);
      expect(removeStaleLock(lock)).toBe(false);
      expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(pid));
      await expect(acquireLock(lock, 50, 10)).rejects.toThrow(`held by pid ${pid}`);
      rmSync(lock, { recursive: true });
    }
  });

  it('takes over a lock whose owner died, leaving no tombstone behind', async () => {
    hold(deadPid());
    await acquireLock(lock, 1_000, 10);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid));
    expect(readdirSync(root)).toEqual(['lp-e2e.lock']);
  });

  it('gives a lock without a pid a grace period, then treats it as abandoned', () => {
    hold(null);
    expect(removeStaleLock(lock)).toBe(false);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
    hold(null, 60_000);
    expect(removeStaleLock(lock)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('puts back a fresh lock that replaced the stale one while it was being removed', () => {
    hold(deadPid());
    beforeRename.once = () => {
      // Another waiter removes the stale lock and takes a new one in between.
      rmSync(lock, { recursive: true });
      hold(process.pid);
    };
    expect(removeStaleLock(lock)).toBe(false);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid));
    expect(readdirSync(root)).toEqual(['lp-e2e.lock']);
  });

  it('only one waiter removes a given stale lock', () => {
    hold(deadPid());
    expect([removeStaleLock(lock), removeStaleLock(lock), removeStaleLock(lock)]).toEqual([true, false, false]);
  });
});

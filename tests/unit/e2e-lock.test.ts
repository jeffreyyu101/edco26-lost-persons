// The cross-process e2e lock (tests/e2e/global-setup.ts), on a private path in the OS temp dir (never
// the real /tmp/lp-e2e.lock).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, removeStaleLock } from '../e2e/global-setup';

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

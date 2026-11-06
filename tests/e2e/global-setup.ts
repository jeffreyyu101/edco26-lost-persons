// Playwright global setup (v2.1 A17):
//   * refuses to run unless .env.test points at local Supabase
//   * takes a cross-process lock (mkdir /tmp/lp-e2e.lock, holding the owner's pid), waiting up to 20
//     minutes, so agents on different ports never run end-to-end suites against the shared local stack at
//     the same time. A lock whose owner process is alive is never taken over, however long it is held.
// Released in global-teardown.ts. Nobody truncates tables globally; specs create unique synthetic rows.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadTestEnv } from '../../scripts/test-env.mjs';

export const LOCK_DIR = '/tmp/lp-e2e.lock';
const WAIT_MS = 20 * 60_000;
/** mkdir and the pid write are two steps: a lock without a pid is only abandoned after this long. */
const NO_PID_GRACE_MS = 10_000;

/** The owner pid recorded in a lock directory, or null when there is no valid pid file. */
function ownerPid(dir: string): number | null {
  try {
    const pid = Number(readFileSync(`${dir}/pid`, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by another user
  }
}

/**
 * Deletes the lock at `dir` only if its owner is gone (dead pid, or no pid for NO_PID_GRACE_MS). Atomic
 * among waiters: the lock is first renamed to a tombstone unique to this process, so only one waiter's
 * rename succeeds. The tombstone is then checked to be the very lock judged stale; a fresh lock that
 * replaced it in between is put back. Returns true when a stale lock was removed.
 */
export function removeStaleLock(dir: string = LOCK_DIR): boolean {
  let seen;
  try {
    seen = statSync(dir);
  } catch {
    return false;
  }
  const pid = ownerPid(dir);
  if (pid === null ? Date.now() - seen.mtimeMs < NO_PID_GRACE_MS : pidAlive(pid)) return false;

  const tombstone = `${dir}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(dir, tombstone);
  } catch {
    return false; // another waiter removed it first
  }
  const moved = statSync(tombstone);
  if (moved.ino !== seen.ino || moved.dev !== seen.dev || ownerPid(tombstone) !== pid) {
    try {
      renameSync(tombstone, dir);
    } catch {
      // A third process took the lock in that instant; leave the tombstone rather than delete a live lock.
    }
    return false;
  }
  rmSync(tombstone, { recursive: true, force: true });
  return true;
}

/** Takes the lock at `dir` for this process, waiting up to `waitMs` while a live owner holds it. */
export async function acquireLock(dir: string = LOCK_DIR, waitMs = WAIT_MS, pollMs = 2_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(`${dir}/pid`, String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (removeStaleLock(dir)) continue;
    if (Date.now() - started > waitMs) {
      throw new Error(
        `Timed out after ${Math.round(waitMs / 60_000)} minutes waiting for ${dir} (held by pid ${ownerPid(dir) ?? 'unknown'}). ` +
          `If that process is not an e2e run, delete ${dir}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  await acquireLock();
}

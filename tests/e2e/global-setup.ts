// Playwright global setup (v2.1 A17):
//   * refuses to run unless .env.test points at local Supabase
//   * takes a cross-process lock (mkdir, holding the owner's pid and cwd) so two suites never run against one local
//     stack at the same time: LP_E2E_LOCK_DIR, else one per stack (/tmp/lp-e2e.lock-<port of .env.test's Supabase
//     URL>; the shared stack keeps /tmp/lp-e2e.lock). It waits up to 2 minutes, then fails naming the holder's pid
//     and cwd. A lock whose owner process is alive is never taken over, however long it is held.
// Released in global-teardown.ts. Nobody truncates tables globally; specs create unique synthetic rows.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DEFAULT_E2E_LOCK_DIR, E2E_LOCK_WAIT_MS, archiveOtherEvents, e2eLockDir, e2eLockHolder, ensureTestEvent, loadTestEnv, pauseInactiveJob } from '../../scripts/test-env.mjs';

/** The shared local stack's lock (scripts/test-env.mjs DEFAULT_E2E_LOCK_DIR). */
export const DEFAULT_LOCK_DIR = DEFAULT_E2E_LOCK_DIR;

/**
 * The lock directory (scripts/test-env.mjs e2eLockDir, which scripts/with-e2e-lock.mjs uses too): LP_E2E_LOCK_DIR
 * when set, else per stack from `supabaseUrl` (default: .env.test's NEXT_PUBLIC_SUPABASE_URL).
 */
export function lockDirFrom(env: Record<string, string | undefined> = process.env, supabaseUrl?: string): string {
  return e2eLockDir(env, supabaseUrl); // undefined: .env.test's URL
}

export const LOCK_DIR = lockDirFrom();
const WAIT_MS = E2E_LOCK_WAIT_MS;
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
      // The cwd first: a waiter that gives up names the checkout holding the lock.
      writeFileSync(`${dir}/cwd`, process.cwd());
      writeFileSync(`${dir}/pid`, String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (removeStaleLock(dir)) continue;
    if (Date.now() - started > waitMs) {
      throw new Error(
        `Timed out after ${Math.round(waitMs / 1000)} s waiting for ${dir} (held by ${e2eLockHolder(dir)}). ` +
          `If that process is not an e2e run on this stack, delete ${dir}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * scripts/with-e2e-lock.mjs already holds the lock for this run (and re-applied the branch's migration under
 * it): LP_E2E_LOCK_OWNER names its pid, which the lock must record and which must be alive.
 */
export function lockHeldForUs(dir: string = LOCK_DIR, owner = process.env.LP_E2E_LOCK_OWNER): boolean {
  const pid = Number(owner);
  return Number.isInteger(pid) && pid > 0 && ownerPid(dir) === pid && pidAlive(pid);
}

export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  if (!lockHeldForUs()) await acquireLock();
  // (F6) The specs make their own auto-closes (lp_close_inactive on their rows); the 5-minute job stays paused.
  pauseInactiveJob();
  // (Events) The live local event the specs sign in to (staff password, join link, lead passcode), and no other
  // running event (the sign-in cards are every running event's teams).
  await ensureTestEvent();
  archiveOtherEvents();
}

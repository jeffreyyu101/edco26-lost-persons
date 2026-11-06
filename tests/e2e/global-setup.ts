// Playwright global setup (v2.1 A17):
//   * refuses to run unless .env.test points at local Supabase
//   * takes a cross-process lock (mkdir /tmp/lp-e2e.lock), waiting up to 20 minutes, so agents on
//     different ports never run end-to-end suites against the shared local stack at the same time.
// Released in global-teardown.ts. Nobody truncates tables globally; specs create unique synthetic rows.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadTestEnv } from '../../scripts/test-env.mjs';

export const LOCK_DIR = '/tmp/lp-e2e.lock';
const WAIT_MS = 20 * 60_000;
const STALE_MS = 60 * 60_000;

function ownerAlive(): boolean {
  try {
    const pid = Number(readFileSync(`${LOCK_DIR}/pid`, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(`${LOCK_DIR}/pid`, String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
      if (!ownerAlive() && age > 5_000) {
        // The previous holder died without teardown.
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (age > STALE_MS) {
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > WAIT_MS) {
        throw new Error(`Timed out after 20 minutes waiting for ${LOCK_DIR} (another e2e run holds it).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

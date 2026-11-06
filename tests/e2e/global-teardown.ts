import { readFileSync, rmSync } from 'node:fs';
import { LOCK_DIR } from './global-setup';

// Releases the cross-process e2e lock taken in global-setup.ts (only if this process holds it).
export default async function globalTeardown(): Promise<void> {
  try {
    if (Number(readFileSync(`${LOCK_DIR}/pid`, 'utf8')) === process.pid) {
      rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  } catch {
    // Not held.
  }
}

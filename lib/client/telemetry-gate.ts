// Whether the telemetry collector may load on this page (design/references/observability-design.md §4.1). Read by
// components/activity/use-telemetry.ts in the F4 chunk (never on the first load) before it imports the collector.
// Every read is guarded: anything unreadable means no.
import { TEL_DEFAULT_UNTIL, TEL_KEYS } from '../telemetry-keys';

export interface GateEnv {
  storage: Pick<Storage, 'getItem'> | null;
  webdriver: boolean;
}

function browserGateEnv(): GateEnv {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return { storage, webdriver: typeof navigator !== 'undefined' && navigator.webdriver === true };
}

/** Epoch ms collection stops at on this device: the server's last `until`, else the built-in auto-off. */
export function telemetryUntil(storage: Pick<Storage, 'getItem'>): number {
  const raw = Number(storage.getItem(TEL_KEYS.until));
  return Number.isFinite(raw) && raw > 0 ? raw : TEL_DEFAULT_UNTIL;
}

/**
 * False when: past the auto-off (`lp-tel-until`, else 2026-11-10 06:00 ET); the server said off and its next probe is
 * not due (`lp-tel-off`); an automated browser that did not opt in (`lp-tel-test` = '1'), so the e2e suites stay
 * quiet; or localStorage can't be read.
 */
export function telemetryAllowed(now = Date.now(), env: GateEnv = browserGateEnv()): boolean {
  try {
    const storage = env.storage;
    if (!storage) return false;
    if (now >= telemetryUntil(storage)) return false;
    const off = Number(storage.getItem(TEL_KEYS.off));
    if (Number.isFinite(off) && off > now) return false;
    if (env.webdriver && storage.getItem(TEL_KEYS.test) !== '1') return false;
    return true;
  } catch {
    return false;
  }
}

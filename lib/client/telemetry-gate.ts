// Whether the telemetry collector may load on this page (design/references/observability-design.md §4.1). Read by
// components/activity/use-telemetry.ts in the F4 chunk (never on the first load) before it imports the collector.
// Every read is guarded: anything unreadable means no.
import { TEL_KEYS } from '../telemetry-keys';

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

/**
 * False when: the server said off and its next probe is not due (`lp-tel-off`; (Events) collection follows the
 * server's `on`, there is no fixed off date); an automated browser that did not opt in (`lp-tel-test` = '1'), so the e2e suites stay
 * quiet; or localStorage can't be read.
 */
export function telemetryAllowed(now = Date.now(), env: GateEnv = browserGateEnv()): boolean {
  try {
    const storage = env.storage;
    if (!storage) return false;
    const off = Number(storage.getItem(TEL_KEYS.off));
    if (Number.isFinite(off) && off > now) return false;
    if (env.webdriver && storage.getItem(TEL_KEYS.test) !== '1') return false;
    return true;
  } catch {
    return false;
  }
}

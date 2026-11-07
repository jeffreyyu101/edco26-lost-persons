// Whether Web Push covers this device's alerts (F4, spec §18 A54 "no double alerts"). Tiny on purpose: the
// store reads it on the first-load path; lib/client/push-client.ts (loaded later) writes it.
//
// While this device has a push subscription the server confirmed for the signed-in staff member, the page
// never shows its own system notification (v2.5 A52) for an alert push carries: the push does (or the
// switch said not to). The in-app toast while the app is in front is unchanged.
import type { AlertEvent } from './store-contract';

let subscribed = false;

export function setPushSubscribed(on: boolean): void {
  subscribed = on;
}

export function pushSubscribed(): boolean {
  return subscribed;
}

/** Push carries this alert kind on this device (a combined one is split before it is asked). */
export function pushCovers(kind: AlertEvent['kind']): boolean {
  return subscribed && kind !== 'combined';
}

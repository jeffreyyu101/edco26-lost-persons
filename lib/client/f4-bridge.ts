// Between the store (on the first-load path) and the F4 clients loaded later (lib/client/push-client.ts,
// lib/client/activity-client.ts). Tiny on purpose: everything here, and every call to it from the store,
// counts against the first-load budget (A25). The logic lives in the clients.
//
//   * Push hooks (registered by the push client): whether the push carries an alert on this device (spec §18
//     A54 "no double alerts": the page then shows no system notification of its own, v2.5 A52; the toast in
//     front is unchanged), and what the store asks of it around a sign-out and at a 401. A sign-out that
//     resumes at load runs before the push client is loaded: dropBrowserPush() then drops the subscription.
//   * Sync extras (A56): the store hands over the first page of every poll; the Activity client listens. The
//     last value is kept, so a client that starts later begins from it.
//   * The store's door to the API (its `call`: timeouts, held and aborted by a sign-out so a late answer
//     never brings the session cookie back). The F4 clients send through it and never import
//     lib/client/http.ts themselves: a module they shared with the store would be split out of the store's
//     first-load code.
import type { SyncResponse } from '../api-types';
import type { HttpResult, RequestOptions } from './http';
import type { AlertEvent } from './store-contract';

export type ApiRequest = <T>(path: string, opts: RequestOptions) => Promise<HttpResult<T>>;

export interface PushHooks {
  /** This device holds a push subscription the server confirmed, and the push carries this kind of alert. */
  covers(kind: AlertEvent['kind']): boolean;
  /** Before a sign-out, while the session still says whose it is: the server forgets this device. Never rejects; settles within seconds. */
  beforeSignOut(): Promise<void>;
  /**
   * After it. Confirmed: the browser drops the subscription. Not confirmed (offline, 5xx): the session goes on,
   * so this device keeps its subscription and tells the server again. Never rejects; settles within seconds.
   */
  afterSignOut(confirmed: boolean): Promise<void>;
  /** A 401: the browser drops the subscription. Never throws. */
  onSessionEnded(): void;
}

export interface ActivityUnread {
  count: number;
  /** A fingerprint of the staff member's Activity: it moves whenever a row is added, changed or read. */
  key: string | null;
}

let hooks: PushHooks | null = null;
let unread: ActivityUnread | null = null;
let onUnread: ((u: ActivityUnread) => void) | null = null;
let api: ApiRequest | null = null;

/** The store, when it starts. */
export const provideApi = (next: ApiRequest | null): void => {
  api = next;
};
export const storeApi = (): ApiRequest | null => api;

export const registerPushHooks = (next: PushHooks | null): void => {
  hooks = next;
};
export const pushHooks = (): PushHooks | null => hooks;

/**
 * A confirmed sign-out with no push client loaded yet (one resumed at load): the browser drops this device's
 * subscription itself; the server deletes its row at the next push (410). Bounded, never rejects.
 */
export function dropBrowserPush(waitMs = 3_000): Promise<void> {
  const drop = (async () => {
    const reg = await globalThis.navigator?.serviceWorker?.getRegistration();
    await (await reg?.pushManager?.getSubscription())?.unsubscribe();
  })().catch(() => undefined);
  return Promise.race([drop, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
}

/**
 * The store, with the first page of a successful poll; null at sign-out (forget the last value). Absent
 * fields (a server before F4) change nothing.
 */
export function publishSyncExtras(body: Pick<SyncResponse, 'activityUnread' | 'activityKey'> | null): void {
  if (!body) {
    unread = null;
    return;
  }
  if (typeof body.activityUnread !== 'number') return;
  unread = { count: body.activityUnread, key: typeof body.activityKey === 'string' ? body.activityKey : null };
  onUnread?.(unread);
}

/** One listener (the page's Activity client; a later one replaces it), told the last value at once. Returns the remover. */
export function subscribeSyncExtras(listener: (u: ActivityUnread) => void): () => void {
  onUnread = listener;
  if (unread) listener(unread);
  return () => {
    if (onUnread === listener) onUnread = null;
  };
}

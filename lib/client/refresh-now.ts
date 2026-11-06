'use client';
// Refresh now on the lists (v2.2 afternoon, Brian 2026-11-06): one immediate sync through the store's syncNow(),
// and when it has finished, so the button's glyph turns exactly while it is in flight. Kept apart from
// live-status.ts so it stays out of the shell's first-load JS (only the list chunk needs it).
import { readDeviceOnline } from './live-status';
import type { AppStore } from './store-contract';

/** A sync that hasn't started this long after the tap (or after the poll in flight at the tap) isn't coming. */
export const REFRESH_START_GRACE_MS = 1_000;
/** The spinner stops by then whatever happens (a sync is at most a few 12 s requests). */
export const REFRESH_MAX_MS = 30_000;

export interface SyncingStore {
  getState(): { syncing: boolean };
  subscribe(listener: () => void): () => void;
}

/**
 * Watches the store's `syncing` flag for the sync a Refresh tap asked for (actions.syncNow(), called right
 * after this) and calls `done` once it has finished. A poll already in flight at the tap is not the one: the
 * store runs another right after it. When none starts (offline, signed out), `done` follows after a moment.
 * Returns a function that stops watching without calling `done`.
 */
export function watchRefresh(store: SyncingStore, done: () => void): () => void {
  let busy = store.getState().syncing;
  let started = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const armGrace = () => {
    if (grace !== undefined) clearTimeout(grace);
    grace = setTimeout(finish, REFRESH_START_GRACE_MS);
  };
  const off = store.subscribe(() => {
    const syncing = store.getState().syncing;
    if (syncing === busy) return;
    busy = syncing;
    if (syncing) {
      started = true;
      if (grace !== undefined) clearTimeout(grace);
      grace = undefined;
    } else if (started) {
      finish();
    } else {
      // The poll in flight at the tap ended: the one asked for starts right after it.
      armGrace();
    }
  });
  const cap = setTimeout(finish, REFRESH_MAX_MS);
  if (!busy) armGrace();
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    off();
    if (grace !== undefined) clearTimeout(grace);
    clearTimeout(cap);
  }
  function finish() {
    if (stopped) return;
    stop();
    done();
  }
  return stop;
}

/**
 * "Refresh now" on a list: one immediate sync through the store's syncNow() (it replaces the poll that was
 * due, so exactly one request goes out), resolved once that sync has finished, whatever its outcome. A failure
 * shows the way any failed sync does (the banner rules); there is no toast. With no connection there is
 * nothing to wait for.
 */
export function refreshSync(store: AppStore): Promise<void> {
  if (!readDeviceOnline()) {
    store.actions.syncNow();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    watchRefresh(store, resolve);
    store.actions.syncNow();
  });
}

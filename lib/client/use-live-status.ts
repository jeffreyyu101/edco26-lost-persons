'use client';
// React side of lib/client/live-status.ts: the live status for one view (its line, banner, avatar badge and
// live region all read the one object this returns). Refresh now is lib/client/refresh-now.ts.
import { useMemo, useSyncExternalStore } from 'react';
import { createLiveSource, type LiveLine } from './live-status';
import { useAppStore, useEventTimezone, type StoreState } from './store-contract';

export interface LiveStatusOptions {
  /**
   * When the view's own data last arrived (the dashboard's last stats fetch, epoch ms on this phone). Leave it
   * out for the store's last successful sync (the lists, the profile).
   */
  syncedAt?: number | null;
  /** The view's own fetch is failing (the dashboard's stats): Reconnecting. */
  failing?: boolean;
  /** Starts the spoken sentence: "List updated just now.", "Dashboard updated 1 minute ago." */
  subject?: string;
}

/**
 * The live status of a view. Call it ONCE per view and hand the result to its LiveIndicator, its
 * ConnectionBanner and its avatar badge, so they can never disagree. The component re-renders only when the
 * words or the state change: at most once a minute while healthy, never once a second.
 */
export function useLiveStatus({ syncedAt, failing = false, subject = 'List' }: LiveStatusOptions = {}): LiveLine {
  const store = useAppStore();
  const timeZone = useEventTimezone();
  const own = syncedAt !== undefined;
  const ownAt = syncedAt ?? null;
  const source = useMemo(() => {
    const pick = (s: StoreState) => ({ syncedAt: own ? ownAt : s.lastSyncLocalAt, connection: s.connection, failing });
    return createLiveSource({
      read: () => pick(store.getState()),
      readServer: () => pick(store.getServerState?.() ?? store.getState()),
      subscribe: store.subscribe,
      subject,
      timeZone,
    });
  }, [store, own, ownAt, failing, subject, timeZone]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getServerSnapshot);
}

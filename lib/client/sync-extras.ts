// Additive fields of GET /api/sync that live outside the store (F4: the Activity unread count). Tiny on
// purpose: the store publishes the first page of every poll here; lib/client/activity-client.ts (loaded
// later) listens. A value published before anyone listened is kept, so a late listener starts from it.
import type { SyncResponse } from '../api-types';

export interface ActivityUnread {
  count: number;
  ids: readonly string[];
}

type Listener = (unread: ActivityUnread) => void;

const listeners = new Set<Listener>();
let last: ActivityUnread | null = null;

/** The store, with the first page of a successful poll. Absent fields (an older server) change nothing. */
export function publishSyncExtras(body: Pick<SyncResponse, 'activityUnread' | 'activityUnreadIds'>): void {
  if (typeof body.activityUnread !== 'number') return;
  const ids = Array.isArray(body.activityUnreadIds) ? body.activityUnreadIds.filter((x): x is string => typeof x === 'string') : [];
  last = { count: Math.max(0, Math.floor(body.activityUnread)), ids };
  for (const l of [...listeners]) {
    try {
      l(last);
    } catch {
      // one listener never stops the others
    }
  }
}

export function lastActivityUnread(): ActivityUnread | null {
  return last;
}

export function subscribeSyncExtras(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sign-out / another staff: forget the last value. */
export function resetSyncExtras(): void {
  last = null;
}

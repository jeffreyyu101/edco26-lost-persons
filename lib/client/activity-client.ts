// The Activity inbox on this page (F4, spec §18 A56): the bell's unread count, the list, read state, Mark
// all read with Undo, and the app icon badge. Loaded with import() (the bell and the Activity host), so it
// costs nothing on the first load.
//
//   * The unread count rides on every sync (lib/client/sync-extras.ts): live at the sync cadence.
//   * The list (GET /api/activity) loads when the sheet or popover opens, and again whenever the unread set
//     changes while it is open.
//   * Read state belongs to the request: opening it from anywhere (Activity, a list, a deep link, a push
//     click) marks its row read (markRead); opening the sheet marks nothing.
//   * Mark all read answers the ids it changed; Undo (5 s) sends them back.
//   * The app icon badge (navigator.setAppBadge) is the unread count.
// Never logs anything.
import { useSyncExternalStore } from 'react';
import type { ActivityListResponse, ActivityReadResponse, ActivityRow } from '../activity';
import { apiRequest, type FetchLike } from './http';
import { lastActivityUnread, subscribeSyncExtras, type ActivityUnread } from './sync-extras';

export interface ActivityState {
  /** Unread requests (the bell). */
  unread: number;
  unreadIds: ReadonlySet<string>;
  /** The list, once loaded (null: not yet). */
  rows: readonly ActivityRow[] | null;
  loading: boolean;
  /** The list could not be loaded (offline). */
  failed: boolean;
  /** The sheet / popover is open (the bell and the sidebar item share it). */
  open: boolean;
}

export const INITIAL_ACTIVITY: Readonly<ActivityState> = Object.freeze({
  unread: 0,
  unreadIds: new Set<string>(),
  rows: null,
  loading: false,
  failed: false,
  open: false,
});

export interface ActivityHost {
  fetch: FetchLike;
  setBadge(count: number): void;
}

export interface ActivityClient {
  getState(): ActivityState;
  subscribe(listener: () => void): () => void;
  /** Starts listening to sync (idempotent). */
  start(): void;
  setOpen(open: boolean): void;
  refresh(): Promise<void>;
  /** The request was opened: its row turns read (only when it is unread). */
  markRead(requestId: string): void;
  /** Mark all read. Resolves the ids that turned read (for Undo), or null when it failed. */
  markAllRead(): Promise<string[] | null>;
  undoMarkAll(ids: readonly string[]): Promise<boolean>;
  /** Sign-out / another staff: forget everything. */
  reset(): void;
}

const TIMEOUT_MS = 10_000;

const sameIds = (a: ReadonlySet<string>, b: readonly string[]) => a.size === b.length && b.every((id) => a.has(id));

export function createActivityClient(host: ActivityHost): ActivityClient {
  let state: ActivityState = INITIAL_ACTIVITY;
  const listeners = new Set<() => void>();
  let started = false;
  let epoch = 0;
  let fetchSeq = 0;
  /** Requests marked read here whose POST is on its way: a sync that still lists them doesn't bring them back. */
  const pendingRead = new Set<string>();

  const set = (patch: Partial<ActivityState>) => {
    const before = state.unread;
    state = { ...state, ...patch };
    if (state.unread !== before) host.setBadge(state.unread);
    for (const l of [...listeners]) l();
  };

  const applyUnread = (u: ActivityUnread) => {
    const ids = u.ids.filter((id) => !pendingRead.has(id));
    const changed = !sameIds(state.unreadIds, ids);
    const unread = Math.max(0, u.count - (u.ids.length - ids.length));
    if (!changed && unread === state.unread) return;
    set({ unread, unreadIds: new Set(ids) });
    if (state.open && changed) void refresh();
  };

  const refresh = async (): Promise<void> => {
    const seq = ++fetchSeq;
    const gen = epoch;
    set({ loading: state.rows === null, failed: false });
    const res = await apiRequest<ActivityListResponse>(host.fetch, '/api/activity', { timeoutMs: TIMEOUT_MS });
    if (seq !== fetchSeq || gen !== epoch) return;
    if (!res.ok || !Array.isArray(res.data.rows)) {
      set({ loading: false, failed: state.rows === null });
      return;
    }
    const rows = res.data.rows.map((r) => (pendingRead.has(r.requestId) ? { ...r, read: true } : r));
    const unreadIds = rows.filter((r) => !r.read).map((r) => r.requestId);
    set({ rows, loading: false, failed: false, unread: unreadIds.length, unreadIds: new Set(unreadIds) });
  };

  const markRows = (ids: ReadonlySet<string> | null, read: boolean) =>
    state.rows ? state.rows.map((r) => (ids === null || ids.has(r.requestId) ? { ...r, read } : r)) : null;

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started) return;
      started = true;
      const last = lastActivityUnread();
      if (last) applyUnread(last);
      subscribeSyncExtras(applyUnread);
    },
    setOpen(open) {
      if (open === state.open) return;
      set({ open });
      if (open) void refresh();
    },
    refresh,
    markRead(requestId) {
      if (!state.unreadIds.has(requestId) && !state.rows?.some((r) => r.requestId === requestId && !r.read)) return;
      const gen = epoch;
      pendingRead.add(requestId);
      const unreadIds = new Set(state.unreadIds);
      const had = unreadIds.delete(requestId);
      set({ unreadIds, unread: Math.max(0, state.unread - (had ? 1 : 0)), rows: markRows(new Set([requestId]), true) });
      void apiRequest<ActivityReadResponse>(host.fetch, '/api/activity/read', { method: 'POST', json: { requestId }, timeoutMs: TIMEOUT_MS }).then(() => {
        if (gen === epoch) pendingRead.delete(requestId);
      });
    },
    async markAllRead() {
      const gen = epoch;
      const before = { unread: state.unread, unreadIds: state.unreadIds, rows: state.rows };
      set({ unread: 0, unreadIds: new Set(), rows: markRows(null, true) });
      const res = await apiRequest<ActivityReadResponse>(host.fetch, '/api/activity/read', { method: 'POST', json: { all: true }, timeoutMs: TIMEOUT_MS });
      if (gen !== epoch) return null;
      if (!res.ok) {
        set(before);
        return null;
      }
      return Array.isArray(res.data.ids) ? res.data.ids.filter((x): x is string => typeof x === 'string') : [];
    },
    async undoMarkAll(ids) {
      if (ids.length === 0) return true;
      const gen = epoch;
      const back = new Set(ids);
      const unreadIds = new Set([...state.unreadIds, ...ids]);
      set({ unreadIds, unread: unreadIds.size, rows: markRows(back, false) });
      const res = await apiRequest(host.fetch, '/api/activity/unread', { method: 'POST', json: { requestIds: [...ids] }, timeoutMs: TIMEOUT_MS });
      if (gen !== epoch) return false;
      if (!res.ok) void refresh();
      return res.ok;
    },
    reset() {
      epoch += 1;
      fetchSeq += 1;
      pendingRead.clear();
      set({ ...INITIAL_ACTIVITY, unreadIds: new Set(), open: false });
      host.setBadge(0);
    },
  };
}

function browserBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (count > 0) void nav.setAppBadge?.(count)?.catch(() => undefined);
    else void nav.clearAppBadge?.()?.catch(() => undefined);
  } catch {
    // best effort
  }
}

let shared: ActivityClient | null = null;

export function activityClient(): ActivityClient {
  shared ??= createActivityClient({ fetch: (input, init) => window.fetch(input, init), setBadge: browserBadge });
  return shared;
}

const serverState = () => INITIAL_ACTIVITY;

export function useActivity(): ActivityState {
  const client = activityClient();
  return useSyncExternalStore(client.subscribe, client.getState, serverState);
}

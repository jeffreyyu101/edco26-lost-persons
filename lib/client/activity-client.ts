// The Activity inbox on this page (F4, spec §18 A56): the bell's unread count, the list, read state, Mark
// all read with Undo, and the app icon badge. Loaded with import() (the bell and the Activity host), so it
// costs nothing on the first load.
//
//   * The unread count and a fingerprint of the staff member's Activity (activityKey) ride on every sync
//     (lib/client/f4-bridge.ts): live at the sync cadence, and a poll stays small. When the key moves (a row
//     added, changed or read), the unread ids are fetched (GET /api/activity/unread), or, with the sheet or
//     popover open, the list itself (GET /api/activity), so an open list follows every new event.
//   * The list loads when the sheet or popover opens.
//   * Read state belongs to the request: opening it from anywhere (Activity, a list, a deep link, a push
//     click) marks its row read (markRead); opening the sheet marks nothing.
//   * Mark all read answers the ids it changed; Undo (5 s) sends them back. A list or ids answer fetched before
//     or during either POST may predate it, so it is dropped, and the list (when open) is fetched again once
//     the POST is answered: a slow GET never turns the rows unread again under the Undo.
//   * The app icon badge (navigator.setAppBadge) is the unread count, set from the first sync after start
//     too (a badge an earlier push left on the icon is cleared when nothing is unread).
// Never logs anything.
import { useSyncExternalStore } from 'react';
import type { ActivityListResponse, ActivityReadResponse, ActivityRow, ActivityUnreadIdsResponse } from '../activity';
import { subscribeSyncExtras, type ActivityUnread, type ApiRequest } from './f4-bridge';
import type { HttpResult } from './http';
import { viaStore } from './via-store';

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
  /** The store's door to the API (lib/client/f4-bridge.ts storeApi). */
  request: ApiRequest;
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

export function createActivityClient(host: ActivityHost): ActivityClient {
  let state: ActivityState = INITIAL_ACTIVITY;
  const listeners = new Set<() => void>();
  let started = false;
  let epoch = 0;
  let fetchSeq = 0;
  let unreadSeq = 0;
  /** The activityKey the ids / list were last fetched for (null: fetch at the next sync). */
  let lastKey: string | null = null;
  /** The badge was set from a sync since start / reset. */
  let synced = false;
  /** Requests marked read here whose POST is on its way: a sync that still lists them doesn't bring them back. */
  const pendingRead = new Set<string>();
  /** Mark all read / Undo POSTs on their way. */
  let writes = 0;
  /** Bumped as each of them starts and is answered: a list or ids answer fetched across one is out of date. */
  let writeGen = 0;
  const writeSettled = (gen: number) => writes === 0 && gen === writeGen;

  const set = (patch: Partial<ActivityState>) => {
    const before = state.unread;
    state = { ...state, ...patch };
    if (state.unread !== before) host.setBadge(state.unread);
    for (const l of [...listeners]) l();
  };

  /** The unread ids (the key moved while the list is closed). */
  const loadUnread = async (): Promise<void> => {
    const seq = ++unreadSeq;
    const gen = epoch;
    const wg = writeGen;
    const res = await host.request<ActivityUnreadIdsResponse>('/api/activity/unread', { timeoutMs: TIMEOUT_MS });
    if (seq !== unreadSeq || gen !== epoch) return;
    if (!writeSettled(wg)) {
      lastKey = null; // across a Mark all read / Undo: the next sync asks again
      return;
    }
    if (!res.ok || !Array.isArray(res.data.ids)) {
      lastKey = null; // the next sync tries again
      return;
    }
    const ids = res.data.ids.filter((x): x is string => typeof x === 'string' && !pendingRead.has(x));
    set({ unread: ids.length, unreadIds: new Set(ids) });
  };

  const applyUnread = (u: ActivityUnread) => {
    const first = !synced;
    synced = true;
    const before = state.unread;
    if (u.key === null) {
      // No key: nothing is unread (the poll leaves the key out then), or a server without one (the count only).
      lastKey = null;
      if (u.count <= 0) {
        if (state.unread !== 0 || state.unreadIds.size > 0) {
          set({ unread: 0, unreadIds: new Set() });
          // Read on another device while this list is open: its rows turn read too.
          if (state.open) void refresh();
        }
      } else if (pendingRead.size === 0 && writes === 0 && u.count !== state.unread) {
        set({ unread: u.count });
      }
    } else if (u.key !== lastKey) {
      // The count at once (the bell is live), unless a read of this page is still on its way (the fetch below
      // then settles it); then the ids, or the open list.
      lastKey = u.key;
      if (pendingRead.size === 0 && writes === 0 && u.count !== state.unread) set({ unread: Math.max(0, u.count) });
      if (state.open) void refresh();
      else void loadUnread();
    }
    if (first && state.unread === before) host.setBadge(state.unread);
  };

  const refresh = async (): Promise<void> => {
    const seq = ++fetchSeq;
    const gen = epoch;
    const wg = writeGen;
    set({ loading: state.rows === null, failed: false });
    const res = await host.request<ActivityListResponse>('/api/activity', { timeoutMs: TIMEOUT_MS });
    if (seq !== fetchSeq || gen !== epoch) return;
    if (!writeSettled(wg)) return; // across a Mark all read / Undo: fetched again once it is answered
    if (!res.ok || !Array.isArray(res.data.rows)) {
      lastKey = null; // the next sync tries again
      set({ loading: false, failed: state.rows === null });
      return;
    }
    unreadSeq += 1; // an ids fetch still on its way is older than this list
    const rows = res.data.rows.map((r) => (pendingRead.has(r.requestId) ? { ...r, read: true } : r));
    const unreadIds = rows.filter((r) => !r.read).map((r) => r.requestId);
    set({ rows, loading: false, failed: false, unread: unreadIds.length, unreadIds: new Set(unreadIds) });
  };

  const markRows = (ids: ReadonlySet<string> | null, read: boolean) =>
    state.rows ? state.rows.map((r) => (ids === null || ids.has(r.requestId) ? { ...r, read } : r)) : null;

  /** A Mark all read / Undo POST: every list or ids answer fetched before it is answered is dropped. */
  const write = async <T>(path: string, json: unknown): Promise<HttpResult<T> | null> => {
    const gen = epoch;
    writes += 1;
    writeGen += 1;
    try {
      const res = await host.request<T>(path, { method: 'POST', json, timeoutMs: TIMEOUT_MS });
      return gen === epoch ? res : null;
    } finally {
      if (gen === epoch) {
        writes -= 1;
        writeGen += 1;
        // The list as the server has it now (it also finishes a load the POST overtook); closed: the next sync.
        if (writes === 0) {
          if (state.open) void refresh();
          else lastKey = null;
        }
      }
    }
  };

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
      subscribeSyncExtras(applyUnread); // told the last value at once
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
      void host.request<ActivityReadResponse>('/api/activity/read', { method: 'POST', json: { requestId }, timeoutMs: TIMEOUT_MS }).then(() => {
        if (gen === epoch) pendingRead.delete(requestId);
      });
    },
    async markAllRead() {
      const before = { unread: state.unread, unreadIds: state.unreadIds, rows: state.rows };
      set({ unread: 0, unreadIds: new Set(), rows: markRows(null, true) });
      const res = await write<ActivityReadResponse>('/api/activity/read', { all: true });
      if (!res) return null;
      if (!res.ok) {
        set(before);
        return null;
      }
      return Array.isArray(res.data.ids) ? res.data.ids.filter((x): x is string => typeof x === 'string') : [];
    },
    async undoMarkAll(ids) {
      if (ids.length === 0) return true;
      const back = new Set(ids);
      const unreadIds = new Set([...state.unreadIds, ...ids]);
      set({ unreadIds, unread: unreadIds.size, rows: markRows(back, false) });
      const res = await write('/api/activity/unread', { requestIds: [...ids] });
      return res?.ok === true;
    },
    reset() {
      epoch += 1;
      fetchSeq += 1;
      unreadSeq += 1;
      writes = 0;
      writeGen += 1;
      lastKey = null;
      synced = false;
      pendingRead.clear();
      set({ ...INITIAL_ACTIVITY, unreadIds: new Set(), open: false });
      host.setBadge(0);
    },
  };
}

/** What the read rule needs of the document (a test passes a fake). */
export interface VisibilityDoc {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * The request on screen (ActivityHost): its Activity row turns read when it is, or becomes, unread, but only
 * while the page is visible, as the thread's own read (messages-core markRead). A hidden tab keeps polling,
 * so a new event on the request open there stays unread (the bell, the app icon badge) until it is seen.
 * Returns the remover.
 */
export function markReadWhileOpen(client: Pick<ActivityClient, 'getState' | 'subscribe' | 'markRead'>, requestId: string, doc: VisibilityDoc): () => void {
  const check = () => {
    if (doc.visibilityState !== 'visible') return;
    if (client.getState().unreadIds.has(requestId)) client.markRead(requestId);
  };
  check();
  // A deep link opens before the first sync says what is unread; an event can also arrive while it is open.
  const off = client.subscribe(check);
  doc.addEventListener('visibilitychange', check);
  return () => {
    off();
    doc.removeEventListener('visibilitychange', check);
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
  shared ??= createActivityClient({ request: viaStore, setBadge: browserBadge });
  return shared;
}

const serverState = () => INITIAL_ACTIVITY;

export function useActivity(): ActivityState {
  const client = activityClient();
  return useSyncExternalStore(client.subscribe, client.getState, serverState);
}

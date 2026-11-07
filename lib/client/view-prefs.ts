'use client';
// Pending v9.1 (Brian 2026-11-06 19:35–20:40): what the list views remember, per device or per session. Only the
// views import this (not the first load). Every storage read and write is wrapped in try/catch: with storage
// blocked (private mode, a full quota) the choice simply lasts until the page closes.
//
//   sort order       All requests and My requests: "⇅ Newest" / "⇅ Updated" or "⇅ Status", per view, per device
//                    (localStorage). The phone's toggle and the desk table's header read and write the same one.
//   Waiting fold     Pending's Waiting for check section: this page session only (never stored), and it opens
//                    again by itself when the Waiting count rises.
//   Friend coming    Pending's Friend coming section: per device (localStorage).
//   Closed fold      My requests in status order: its folded "Closed N" group, this browser session
//                    (sessionStorage), like All requests' Archived fold (prefs.closedExpanded).
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type SortView = 'all' | 'mine';
/** `default`: All newest first, My requests latest update first. `status`: the status order (status-order.ts). */
export type SortOrder = 'default' | 'status';

export const SORT_STORAGE_KEYS: Readonly<Record<SortView, string>> = { all: 'lp-sort-all', mine: 'lp-sort-mine' };
export const COMING_FOLD_KEY = 'lp-fold-coming';
export const MINE_CLOSED_KEY = 'lp-mine-closed-expanded';

function local(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readKey(store: Storage | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeKey(store: Storage | null, key: string, value: string | null): void {
  try {
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Blocked or full: not remembered.
  }
}

/** A small external store: one value, read once from storage, shared by every component that uses it. */
interface Cell<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
  /** Forget the cached value (tests; another tab changed the storage). */
  reset(): void;
}

function cell<T>(read: () => T, write: (value: T) => void, serverValue: T): Cell<T> & { server: T } {
  let loaded = false;
  let value = serverValue;
  const listeners = new Set<() => void>();
  return {
    server: serverValue,
    get() {
      if (!loaded) {
        value = read();
        loaded = true;
      }
      return value;
    },
    set(next) {
      value = next;
      loaded = true;
      write(next);
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      loaded = false;
      for (const l of listeners) l();
    },
  };
}

function useCell<T>(c: Cell<T> & { server: T }): [T, (value: T) => void] {
  const value = useSyncExternalStore(c.subscribe, c.get, () => c.server);
  const set = useCallback((next: T) => c.set(next), [c]);
  return [value, set];
}

// ---- sort order ---------------------------------------------------------------------------------------------

export function readSortOrder(view: SortView): SortOrder {
  return readKey(local(), SORT_STORAGE_KEYS[view]) === 'status' ? 'status' : 'default';
}

export function writeSortOrder(view: SortView, order: SortOrder): void {
  writeKey(local(), SORT_STORAGE_KEYS[view], order === 'status' ? 'status' : null);
}

const sortCells: Readonly<Record<SortView, Cell<SortOrder> & { server: SortOrder }>> = {
  all: cell<SortOrder>(() => readSortOrder('all'), (o) => writeSortOrder('all', o), 'default'),
  mine: cell<SortOrder>(() => readSortOrder('mine'), (o) => writeSortOrder('mine', o), 'default'),
};

/** The view's sort order on this device, and a setter that remembers it. */
export function useSortOrder(view: SortView): [SortOrder, (order: SortOrder) => void] {
  return useCell(sortCells[view]);
}

// ---- Pending's folds ----------------------------------------------------------------------------------------

/** The Waiting fold: folded, and the Waiting count it was folded at (or has fallen to since). Never stored. */
interface WaitingFold {
  folded: boolean;
  base: number;
}

const waitingCell = cell<WaitingFold>(
  () => ({ folded: false, base: 0 }),
  () => undefined,
  { folded: false, base: 0 },
);

/** True when the Waiting section should show folded: folded, and no request arrived since (Pending v9.1). */
export function waitingShowsFolded(fold: WaitingFold, count: number): boolean {
  return fold.folded && count <= fold.base;
}

/**
 * Pending's Waiting for check fold for this page session. It opens again by itself as soon as the Waiting count
 * rises above the lowest count seen while folded (a new request to check). An empty section never folds.
 */
export function useWaitingFold(count: number): [boolean, (folded: boolean) => void] {
  const [fold, setFold] = useCell(waitingCell);
  const folded = count > 0 && waitingShowsFolded(fold, count);
  useEffect(() => {
    if (!fold.folded) return;
    if (count > fold.base) setFold({ folded: false, base: 0 });
    else if (count < fold.base) setFold({ folded: true, base: count });
  }, [count, fold, setFold]);
  const set = useCallback((next: boolean) => setFold(next ? { folded: true, base: count } : { folded: false, base: 0 }), [count, setFold]);
  return [folded, set];
}

const comingCell = cell<boolean>(
  () => readKey(local(), COMING_FOLD_KEY) === '1',
  (folded) => writeKey(local(), COMING_FOLD_KEY, folded ? '1' : null),
  false,
);

/** Pending's Friend coming fold, remembered on this device. */
export function useComingFold(): [boolean, (folded: boolean) => void] {
  return useCell(comingCell);
}

const mineClosedCell = cell<boolean>(
  () => readKey(session(), MINE_CLOSED_KEY) === '1',
  (open) => writeKey(session(), MINE_CLOSED_KEY, open ? '1' : null),
  false,
);

/** My requests in status order: the Closed group is open, for this browser session. */
export function useMineClosedOpen(): [boolean, (open: boolean) => void] {
  return useCell(mineClosedCell);
}

/** Tests only: forget every cached value so the next read comes from storage again. */
export function resetViewPrefsForTests(): void {
  sortCells.all.reset();
  sortCells.mine.reset();
  waitingCell.set({ folded: false, base: 0 });
  comingCell.reset();
  mineClosedCell.reset();
}

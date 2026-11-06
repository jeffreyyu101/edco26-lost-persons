'use client';
// The client store's PUBLIC contract (spec §7, v2.1 A5/A6/A10–A15/A22): state shape, actions and selector
// hooks. Screens import hooks from here and NEVER call fetch themselves. The in-memory STUB (synthetic data,
// lib/client/store-stub.ts) is deliberately NOT re-exported: this module is on the first-load path of `/`,
// and the stub and its rows must never be bundled into production (v2.2 A25).
//
// FROZEN after Phase 1a: Phase 1b (C) implements `AppStore` for real in lib/client/store.tsx without
// changing these types; later phases may ADD members, never change existing ones.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type {
  CreateRequestBody,
  IsoDateTime,
  OutboxItem,
  RequestDetail,
  RequestPatch,
  RequestSummary,
  Stats,
} from '../api-types';
import type { PhotoTiming, SettableStatus, StatusKind } from '../domain';
import type { Prefs } from './prefs';
import type { RequestFormValues } from './form-values';
import {
  type AllFilter,
  type PendingGroups,
  type SearchHit,
  type ViewCounts,
  filterAll,
  mergedRows,
  mineRows,
  pendingGroups,
  searchRequests,
  sortNewestFirst,
  viewCounts,
  visibleOutbox,
} from './selectors';

export {
  DRAFT_DEBOUNCE_MS,
  LEGACY_QUEUE_KEY,
  MUTATION_TIMEOUT_MS,
  OUTBOX_BACKOFF_MS,
  STATS_POLL_MS,
  SYNC,
  UNDO_MS,
} from './constants';
import { STATS_POLL_MS } from './constants';

// ---------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------

/** offline: navigator.onLine false or 2 network/timeout failures · error: 3 HTTP 5xx · live: any success. */
export type Connection = 'live' | 'offline' | 'error';

// Prefs and ThemePref are defined in lib/client/prefs.ts, the localStorage module that backs them.
export type { LastPost, Prefs, ThemePref } from './prefs';

export interface SessionState {
  /** unknown: not checked yet (or offline) · active · expired: a 401 was seen · signed_out */
  status: 'unknown' | 'active' | 'expired' | 'signed_out';
  staffName: string | null;
  /** Canonical team value or custom team text. */
  team: string | null;
  /** Attribution string "staffName · team". */
  staff: string | null;
  expiresAt: IsoDateTime | null;
}

/** An optimistic overlay for an in-flight mutation (never left once the server has answered). */
export interface Overlay {
  mutationId: string;
  kind: 'status' | 'fields' | 'cancel';
  fields: Partial<RequestSummary>;
  startedAt: number;
}

export type ToastTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';
export type ToastIcon = 'bell' | 'check' | 'x' | 'alert' | 'refresh' | 'cloud-off' | 'info' | 'walk';

export interface ToastItem {
  id: string;
  tone: ToastTone;
  icon: ToastIcon;
  title: string;
  subtitle?: string;
  action?: { label: string; run: () => void };
  /** null = stays until dismissed. */
  durationMs: number | null;
}

/** The 6 s Undo bar after an answer tap (shown only when the server said changed: true, A11). */
export interface SnackbarItem {
  id: string;
  /** e.g. "LP-1012 · In medical" */
  message: string;
  expiresAt: number;
}

/** "Send 2 requests saved by Dana Kim?" when the signed-in staff differs from the saver (A13). */
export interface OutboxPrompt {
  count: number;
  savedBy: string;
  sendAs: string;
}

export interface StoreState {
  /** The IndexedDB cache has been read (or found empty). */
  hydrated: boolean;
  /** Data has loaded at least once (cache or server). Skeletons only while false. */
  hasData: boolean;
  /** Last server truth, by request id. */
  confirmed: ReadonlyMap<string, RequestSummary>;
  /** Optimistic overlays, by request id. */
  pending: ReadonlyMap<string, Overlay>;
  /** Every outbox job on this phone (use useOutbox() for the deduplicated visible list). */
  outbox: readonly OutboxItem[];
  outboxPrompt: OutboxPrompt | null;
  connection: Connection;
  /** A sync request is in flight (the live dot turns grey). */
  syncing: boolean;
  /** Server clock of the last successful sync. */
  lastSyncAt: IsoDateTime | null;
  session: SessionState;
  /** Request ids created on this phone. */
  myIds: ReadonlySet<string>;
  /** Starts as readPrefs() (lib/client/prefs.ts); changed only through actions.setPref. */
  prefs: Prefs;
  toasts: readonly ToastItem[];
  snackbar: SnackbarItem | null;
  /** A new service worker is waiting ("Update ready · Reload"). */
  updateReady: boolean;
  /** Every view chunk and static asset is cached for offline use (A15). */
  offlineReady: boolean;
  /** Bumped on logout; responses from an older generation are ignored (A14). */
  generation: number;
  /** IANA zone for every displayed time. */
  eventTimezone: string;
  /** IndexedDB works on this device. When false, offline save is disabled (never memory-only). */
  durableStorage: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------

export type MutationFailure =
  /** 409: someone else changed it. `latest` is the fresh row when it could be fetched. */
  | 'conflict'
  /** No connection: status changes and edits need one (not queued in v1). */
  | 'offline'
  /** Timeout, network error or 5xx. */
  | 'failed'
  /** 403 creator-only. */
  | 'forbidden'
  /** 422 illegal transition or invalid field. */
  | 'invalid'
  | 'not_found'
  /** 401: the store pauses and sends the user to sign-in. */
  | 'unauthorized';

export type MutationResult =
  | { ok: true; changed: boolean; request: RequestSummary }
  | { ok: false; reason: MutationFailure; message: string; latest?: RequestSummary };

/** A compressed photo chosen in the form (spec §7 Photos). Preview with URL.createObjectURL(thumbBlob). */
export interface DraftPhoto {
  photoId: string;
  blob: Blob;
  thumbBlob: Blob;
  width: number;
  height: number;
}

export interface CreateInput {
  values: RequestFormValues;
  /** The draft's id; reused for every retry and resend. */
  clientMutationId: string;
  photos: DraftPhoto[];
  photoTiming: PhotoTiming;
}

export type CreateResult =
  /** Confirmed by the server ("LP-1014 saved"). Photos keep uploading through the outbox job. */
  | { outcome: 'sent'; request: RequestSummary }
  /** Persisted on this phone and will send when back online ("Saved on this phone · sends when back online"). */
  | { outcome: 'queued'; mutationId: string }
  /** Definitive 4xx: kept as a "Needs attention" outbox item. */
  | { outcome: 'needs_attention'; mutationId: string; message: string }
  /** IndexedDB is unavailable and the send failed: nothing was saved, the user must retry. */
  | { outcome: 'not_saved'; message: string };

/** The new-request draft, saved to IndexedDB (debounced 300 ms; immediately on photo add and pagehide). */
export interface RequestDraft {
  clientMutationId: string;
  values: RequestFormValues;
  photos: DraftPhoto[];
  photoTiming: PhotoTiming;
  updatedAt: number;
}

/** What an alert host plays a chime / vibration for (the toast itself is added by the store). */
export interface AlertEvent {
  kind: 'in_medical' | 'not_in_medical' | 'reunited' | 'new_request' | 'combined';
  /** Absent for 'combined'. */
  requestId?: string;
  title: string;
  subtitle?: string;
  count: number;
}

export interface StoreActions {
  /** Tap-the-live-dot / Try again. Coalesced with any poll in flight. */
  syncNow(): void;

  /**
   * Answer / change / reunite / discharge / undo / reopen. Applies an overlay, serialises per request,
   * sends with the confirmed rowVersion, and owns the Undo snackbar and the toasts (A11, A12).
   */
  setStatus(id: string, status: SettableStatus, kind: StatusKind): Promise<MutationResult>;
  /** Undo the snackbar's mutation (reverse transition, kind 'undo'; never retried automatically). */
  undo(snackbarId: string): Promise<MutationResult | null>;
  dismissSnackbar(): void;

  /** Every create is an outbox job, persisted before sending (A13). Resolves within ~10 s. */
  create(input: CreateInput): Promise<CreateResult>;
  /** Edit: only changed keys, with the version captured when editing started (A10). */
  updateFields(id: string, patch: RequestPatch, baseVersion: number): Promise<MutationResult>;
  /** Creator only, while Waiting. */
  cancel(id: string): Promise<MutationResult>;
  /** Photos for an existing request (needs a connection in v1). */
  addPhotos(id: string, photos: DraftPhoto[], timing: PhotoTiming): Promise<{ added: number; failed: number }>;
  /** Decode via <img>, draw straight into target-size canvases, re-encode (EXIF stripped). */
  preparePhoto(file: File): Promise<DraftPhoto>;

  /** GET /api/requests/:id (use the useDetail hook in components). */
  fetchDetail(id: string): Promise<RequestDetail>;
  /** GET /api/stats (use the useStats hook in components). */
  fetchStats(): Promise<Stats>;

  outbox: {
    /** Retry now (resets backoff). */
    retry(mutationId: string): void;
    /** Remove the job and its photos from this phone. */
    discard(mutationId: string): Promise<void>;
    /**
     * Replace a needs-attention job's payload (same mutationId; build it with toCreateBody(values,
     * mutationId)). The job's photos are kept unchanged: the outbox editor shows them read-only (to change
     * photos, discard the job and log the request again). Prefill the editor with
     * formValuesFromCreateBody(item.payload).
     */
    update(mutationId: string, payload: CreateRequestBody): Promise<void>;
    /** Send a needs-attention job again after update(). */
    resend(mutationId: string): void;
    /** Answer the operator prompt: send as the current staff, or discard those jobs. */
    answerPrompt(send: boolean): Promise<void>;
  };

  draft: {
    load(): Promise<RequestDraft | null>;
    /** Debounced save. */
    save(draft: RequestDraft): void;
    /** Write any pending save now (photo added, pagehide). */
    flush(): Promise<void>;
    clear(): Promise<void>;
  };

  /**
   * Refused while unsent outbox jobs exist unless discardOutbox is true. Otherwise clears the cache,
   * phone-created ids, drafts and the cookie (remembered name/team stay unless changed at sign-in).
   */
  signOut(opts?: { discardOutbox?: boolean }): Promise<{ ok: true } | { ok: false; reason: 'outbox'; count: number }>;

  /**
   * Writes through lib/client/prefs.ts (writePref), then updates state.prefs. setPref('theme', t) also
   * applies the theme (applyTheme), so screens never call applyTheme themselves.
   */
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void;

  showToast(toast: Omit<ToastItem, 'id'>): string;
  dismissToast(id: string): void;
  /** Alert hosts (chime, vibration) subscribe here. Returns the unsubscribe function. */
  subscribeAlerts(listener: (alert: AlertEvent) => void): () => void;

  /** Activate the waiting service worker and reload (refused while a draft or outbox job exists). */
  applyUpdate(): Promise<boolean>;
}

export interface AppStore {
  getState(): StoreState;
  subscribe(listener: () => void): () => void;
  actions: StoreActions;
}

// ---------------------------------------------------------------------------------------------------
// Context and hooks
// ---------------------------------------------------------------------------------------------------

export const StoreContext = createContext<AppStore | null>(null);

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useAppStore must be used inside <StoreProvider>');
  return store;
}

/**
 * Subscribe to a slice of the state. The component re-renders only when the selected value changes
 * (by `isEqual`, default Object.is) — polls never re-render a form that selects nothing that changed.
 * Pass a stable selector (module-level function or useCallback) so the memo survives re-renders.
 */
export function useStoreSelector<T>(selector: (state: StoreState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useAppStore();
  const getSnapshot = useMemo(() => memoizedSnapshot(store, selector, isEqual), [store, selector, isEqual]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * A snapshot function with its own memo: reused while the state is unchanged, and the previous value is
 * kept when a recomputed one is equal, so useSyncExternalStore always sees a stable snapshot.
 */
function memoizedSnapshot<T>(store: AppStore, selector: (state: StoreState) => T, isEqual: (a: T, b: T) => boolean): () => T {
  let memo: { state: StoreState; value: T } | null = null;
  return () => {
    const state = store.getState();
    if (memo && memo.state === state) return memo.value;
    const value = selector(state);
    memo = { state, value: memo && isEqual(memo.value, value) ? memo.value : value };
    return memo.value;
  };
}

export function useActions(): StoreActions {
  return useAppStore().actions;
}

/** Shallow equality for arrays and plain objects (one level). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// Derived lists are memoised on the identity of the maps they come from.
const mergedCache = new WeakMap<ReadonlyMap<string, RequestSummary>, WeakMap<ReadonlyMap<string, Overlay>, RequestSummary[]>>();
function selectMerged(state: StoreState): RequestSummary[] {
  let byPending = mergedCache.get(state.confirmed);
  if (!byPending) {
    byPending = new WeakMap();
    mergedCache.set(state.confirmed, byPending);
  }
  let rows = byPending.get(state.pending);
  if (!rows) {
    rows = sortNewestFirst(mergedRows(state.confirmed, state.pending));
    byPending.set(state.pending, rows);
  }
  return rows;
}

const pendingEqual = (a: PendingGroups, b: PendingGroups) =>
  shallowEqual(a.friendComing, b.friendComing) && shallowEqual(a.waiting, b.waiting);
const selectPending = (s: StoreState) => pendingGroups(selectMerged(s));
const selectMine = (s: StoreState) => mineRows(selectMerged(s), s.myIds, s.session.staff);
const selectOutbox = (s: StoreState) => visibleOutbox(s.outbox, s.confirmed);
const selectCounts = (s: StoreState) =>
  viewCounts(selectMerged(s), visibleOutbox(s.outbox, s.confirmed), s.myIds, s.session.staff);
const selectConnection = (s: StoreState) => ({ connection: s.connection, syncing: s.syncing, lastSyncAt: s.lastSyncAt });
const selectSession = (s: StoreState) => s.session;
const selectPrefs = (s: StoreState) => s.prefs;
const selectToasts = (s: StoreState) => s.toasts;
const selectSnackbar = (s: StoreState) => s.snackbar;
const selectTimezone = (s: StoreState) => s.eventTimezone;
const selectLoading = (s: StoreState) => !s.hasData;

/** Every request (overlays applied), newest first by createdAt. */
export function useRequests(): RequestSummary[] {
  return useStoreSelector(selectMerged);
}

/** One request (overlay applied), or null when unknown. */
export function useRequest(id: string | null): RequestSummary | null {
  const selector = useCallback(
    (s: StoreState) => {
      if (!id) return null;
      const row = s.confirmed.get(id);
      if (!row) return null;
      const overlay = s.pending.get(id);
      return overlay ? { ...row, ...overlay.fields } : row;
    },
    [id],
  );
  return useStoreSelector(selector, shallowEqual);
}

/** All, optionally filtered by status / post (A22). */
export function useAllRows(filter: AllFilter): RequestSummary[] {
  const { status, post } = filter;
  const selector = useCallback((s: StoreState) => filterAll(selectMerged(s), { status, post }), [status, post]);
  return useStoreSelector(selector, shallowEqual);
}

/** Pending: Friend coming + Waiting for check. */
export function usePending(): PendingGroups {
  return useStoreSelector(selectPending, pendingEqual);
}

/** My requests (ids from this phone ∪ canonical created_by match), newest update first. */
export function useMine(): RequestSummary[] {
  return useStoreSelector(selectMine, shallowEqual);
}

/** Outbox items to show (A6: hides items already confirmed), newest first. */
export function useOutbox(): OutboxItem[] {
  return useStoreSelector(selectOutbox, shallowEqual);
}

export function useCounts(): ViewCounts {
  return useStoreSelector(selectCounts, shallowEqual);
}

export function useSearch(query: string): SearchHit[] {
  const selector = useCallback((s: StoreState) => searchRequests(selectMerged(s), query), [query]);
  return useStoreSelector(selector, searchEqual);
}
const searchEqual = (a: SearchHit[], b: SearchHit[]) =>
  a.length === b.length && a.every((h, i) => h.row === b[i]?.row && h.field === b[i]?.field && h.text === b[i]?.text);

export function useConnection(): { connection: Connection; syncing: boolean; lastSyncAt: IsoDateTime | null } {
  return useStoreSelector(selectConnection, shallowEqual);
}

export function useSession(): SessionState {
  return useStoreSelector(selectSession);
}

export function usePrefs(): Prefs {
  return useStoreSelector(selectPrefs);
}

export function useToasts(): readonly ToastItem[] {
  return useStoreSelector(selectToasts);
}

export function useSnackbar(): SnackbarItem | null {
  return useStoreSelector(selectSnackbar);
}

export function useEventTimezone(): string {
  return useStoreSelector(selectTimezone);
}

/** true until the first data arrives (cache or server): show skeletons only then. */
export function useIsLoading(): boolean {
  return useStoreSelector(selectLoading);
}

// A shared clock for relative times and wait badges: one interval for the whole app.
const clock = {
  now: Date.now(),
  listeners: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
};
const CLOCK_TICK_MS = 15_000;
function subscribeClock(listener: () => void): () => void {
  clock.listeners.add(listener);
  if (!clock.timer) {
    clock.now = Date.now();
    clock.timer = setInterval(() => {
      clock.now = Date.now();
      for (const l of clock.listeners) l();
    }, CLOCK_TICK_MS);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0 && clock.timer) {
      clearInterval(clock.timer);
      clock.timer = undefined;
    }
  };
}
const readClock = () => clock.now;

/**
 * The current time in epoch ms, re-rendering every 15 s. Use it for "h:mm" vs "Fri 9:58", wait badges and
 * durations (calling Date.now() during render is impure).
 */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, readClock, readClock);
}

export interface DetailState {
  detail: RequestDetail | null;
  loading: boolean;
  error: MutationFailure | null;
  refresh: () => void;
}

/**
 * The profile's detail (photos + audit). Fetches on mount and refetches whenever the synced rowVersion
 * for this id changes, so another liaison's answer shows within one poll (A5). While refetching, the
 * previous detail for the same id stays visible.
 */
export function useDetail(id: string | null): DetailState {
  const { actions } = useAppStore();
  const versionSelector = useCallback((s: StoreState) => (id ? (s.confirmed.get(id)?.rowVersion ?? null) : null), [id]);
  const version = useStoreSelector(versionSelector);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const key = id ? `${id}|${version ?? ''}|${nonce}` : null;
  const [result, setResult] = useState<{ key: string | null; detail: RequestDetail | null; error: MutationFailure | null }>({
    key: null,
    detail: null,
    error: null,
  });

  useEffect(() => {
    if (!id || !key) return;
    let live = true;
    actions.fetchDetail(id).then(
      (detail) => {
        if (live) setResult({ key, detail, error: null });
      },
      (error: unknown) => {
        if (!live) return;
        const reason = (error as { reason?: MutationFailure } | null)?.reason ?? 'failed';
        setResult((r) => ({ key, detail: r.detail?.id === id ? r.detail : null, error: reason }));
      },
    );
    return () => {
      live = false;
    };
  }, [actions, id, key]);

  const detail = result.detail && result.detail.id === id ? result.detail : null;
  return { detail, loading: !!key && result.key !== key, error: result.key === key ? result.error : null, refresh };
}

/** Dashboard stats, polled every 15 s while `active` (A5). */
export function useStats(active: boolean): { stats: Stats | null; error: boolean } {
  const { actions } = useAppStore();
  const [state, setState] = useState<{ stats: Stats | null; error: boolean }>({ stats: null, error: false });
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const stats = await actions.fetchStats();
        if (live) setState({ stats, error: false });
      } catch {
        if (live) setState((s) => ({ ...s, error: true }));
      }
      if (live) timer = setTimeout(tick, STATS_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [actions, active]);
  return state;
}


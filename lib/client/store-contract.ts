'use client';
// The client store's PUBLIC contract (spec §7, v2.1 A5/A6/A10–A15/A22): state shape, actions and selector
// hooks. Screens import hooks from here and NEVER call fetch themselves. The in-memory STUB (synthetic data,
// lib/client/store-stub.ts) is deliberately NOT re-exported: this module is on the first-load path of `/`,
// and the stub and its rows must never be bundled into production (v2.2 A25).
//
// FROZEN after Phase 1a: Phase 1b (C) implements `AppStore` for real in lib/client/store.tsx without
// changing these types; later phases may ADD members, never change existing ones. The real store must keep
// the SERVER-RENDER INVARIANTS stated above `AppStore` (pure construction, side effects only in start(),
// hydration from createServerState()).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CreateRequestBody,
  EventConfig,
  IsoDateTime,
  OutboxItem,
  RequestDetail,
  RequestPatch,
  RequestSummary,
  SessionRole,
  Stats,
  StatsRange,
} from '../api-types';
import type { SwapAction } from './swap';
import type { PhotoTiming, SettableStatus, StatusKind } from '../domain';
import type { MessagingApi } from './messages-core';
import { DEFAULT_PREFS, type Prefs } from './prefs';
import type { CropRect } from './crop';
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
  CONNECTION_FAILURES,
  DRAFT_DEBOUNCE_MS,
  LEGACY_QUEUE_KEY,
  MUTATION_TIMEOUT_MS,
  OUTBOX_BACKOFF_MS,
  STATS_POLL_MS,
  SYNC,
  UNDO_MS,
} from './constants';
import { STATS_POLL_MS } from './constants';
import type { StatsState } from './stats-poller';

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
export type ToastIcon = 'bell' | 'check' | 'x' | 'alert' | 'refresh' | 'cloud-off' | 'info' | 'walk' | 'message';

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
  /** (Pending v9.1) What a screen reader hears instead of `message`, when the words differ ("B.W. closed, not found in medical."). */
  said?: string;
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
  /**
   * (Added in v2.2, the live indicator.) This phone's clock (epoch ms) when that sync landed. "Updated 6s ago"
   * counts from it, so a phone whose clock differs from the server's still reads right.
   */
  lastSyncLocalAt: number | null;
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
  /**
   * (Events) The signed-in event's config (GET /api/session, refreshed when sync says its version moved), or null: not
   * known yet, or a lead with no event open. Read it with useEventConfig() (lib/client/event-config.ts).
   */
  event: EventConfig | null;
  /** (Events) 'staff' or 'lead' once known (an offline reload starts from the last one), else null. */
  role: SessionRole | null;
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

/**
 * (Added at integration.) `quiet`: the screen shows this mutation's failure itself (an inline error in a
 * dialog or form), so the store adds no failure toast. A 401 still sends the user to sign-in.
 */
export interface MutationOptions {
  quiet?: boolean;
}

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

/** How a picked photo is prepared (lib/client/image.ts). */
export interface PreparePhotoOptions {
  /** The quick crop, normalised to the photo as shown; omitted or null = the whole photo. */
  crop?: CropRect | null;
  /** On-device cleanup (levels, light sharpening, each only when measured as needed). Default on. */
  enhance?: boolean;
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
  /**
   * 'status_changed' (added in Phase 1b): any other status change of one of my requests by someone else
   * (back to Waiting after an Undo, Discharged, Cancelled), since spec §7 alerts on ANY status change.
   */
  kind: 'in_medical' | 'not_in_medical' | 'reunited' | 'new_request' | 'combined' | 'status_changed' | 'message' | CompanionAlertKind;
  /** Absent for 'combined'. */
  requestId?: string;
  title: string;
  subtitle?: string;
  count: number;
}

/** (Companion) The friend swap / companion alerts (same names as the Activity kinds). */
export type CompanionAlertKind = 'accompanied' | 'swap_requested' | 'swap_approved' | 'swap_declined' | 'swap_cancelled' | 'friend_informed';

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
  /**
   * (Added in desk wave 2.) Something covers the Undo bar (the location sheet or popover that follows an In
   * medical tap): while held, the Undo on screen, or one that appears meanwhile, does not run out. The
   * returned release (idempotent; holds nest) gives it a full UNDO_MS from then.
   */
  holdUndo(): () => void;

  /** Every create is an outbox job, persisted before sending (A13). Resolves within ~10 s. */
  create(input: CreateInput): Promise<CreateResult>;
  /** Edit: only changed keys, with the version captured when editing started (A10). */
  updateFields(id: string, patch: RequestPatch, baseVersion: number, opts?: MutationOptions): Promise<MutationResult>;
  /**
   * (Added 2026-11-06 afternoon, Pending v8.) Where medical has the patient ("Chair 14"), or null to clear.
   * Queued behind the request's other mutations (the In medical tap that opened the location sheet), sent
   * with the version current when it runs, and resent once on a 409 (one field the person just typed: the
   * latest value wins). An Undo still on screen for the request stays usable: a location is not a status.
   */
  setMedicalLocation(id: string, location: string | null, opts?: MutationOptions): Promise<MutationResult>;
  /**
   * (Companion) POST /api/requests/:id/swap: request a friend swap (Accompanied), approve it at the request's own
   * post ('fa') or Main Med ('mm') (→ In medical, swapPlace set), or decline it (back to Accompanied). Optimistic,
   * serialised per request, resent once on a 409 when neither the status nor the swap moved. Every step gets the
   * Undo bar: a request's Undo withdraws it; (post-event) Cancel swap, Decline and Swap at … are undone by
   * 'restore', which puts back exactly what they replaced. A failed Undo says why in a toast.
   */
  swap(id: string, action: SwapAction, opts?: MutationOptions): Promise<MutationResult>;
  /** Creator only, while Waiting. */
  cancel(id: string, opts?: MutationOptions): Promise<MutationResult>;
  /** Photos for an existing request (needs a connection in v1). */
  addPhotos(id: string, photos: DraftPhoto[], timing: PhotoTiming, opts?: MutationOptions): Promise<{ added: number; failed: number }>;
  /**
   * Decode via <img>, crop, area-average down to ≤ 1600 px, clean up on the phone when it helps, re-encode
   * (EXIF stripped, never bigger than without the cleanup).
   */
  preparePhoto(file: File, options?: PreparePhotoOptions): Promise<DraftPhoto>;

  /** GET /api/requests/:id (use the useDetail hook in components). */
  fetchDetail(id: string): Promise<RequestDetail>;
  /** GET /api/stats (use the useStats hook in components); Dashboard v4 passes its range (?range=…). */
  fetchStats(range?: StatsRange): Promise<Stats>;

  /**
   * (Events) Re-read GET /api/session now (the event's config and stage). A lead screen calls it after changing the
   * open event's settings; a different event (POST /api/session/event) needs a reload instead (location.replace('/')),
   * which loads that event's own cache.
   */
  refreshSession?(): Promise<void>;

  outbox: {
    /** Retry now (resets backoff). */
    retry(mutationId: string): void;
    /** Remove the job and its photos from this phone. */
    discard(mutationId: string): Promise<void>;
    /**
     * Replace a needs-attention job's payload (same mutationId; build it with toCreateBody(values,
     * mutationId)). The job's photos are kept unchanged: the outbox editor shows them read-only (to change
     * photos, discard the job and log the request again). Prefill the editor with
     * formValuesFromCreateBody(item.payload). When the create was rejected, the store has copied
     * ApiError.error.field into item.lastError.field; the editor passes
     * formErrorsFromField(item.lastError.field, item.lastError.message) as RequestForm `errors`.
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
   * Refused while unsent outbox jobs exist unless discardOutbox is true. Otherwise asks the server to clear
   * the cookie (retried) and, only once it confirmed, clears the cache, phone-created ids, drafts and the
   * cookie (remembered name/team stay unless changed at sign-in), then navigates to /signin itself
   * (location.replace), so callers only close their own UI. `failed`: the server never confirmed (offline,
   * timeouts, 5xx); nothing was cleared, the session goes on, and the caller shows `message`.
   */
  signOut(opts?: { discardOutbox?: boolean }): Promise<
    | { ok: true }
    /** `count`: unsent requests; `messages` (F3): unsent messages and en route taps, also discarded with them. */
    | { ok: false; reason: 'outbox'; count: number; messages?: number }
    | { ok: false; reason: 'failed'; message: string }
  >;

  /**
   * Writes through lib/client/prefs.ts (writePref), then updates state.prefs. setPref('theme', t) also
   * applies the theme (applyTheme), so screens never call applyTheme themselves.
   */
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void;

  showToast(toast: Omit<ToastItem, 'id'>): string;
  dismissToast(id: string): void;
  /**
   * Alert hosts (chime, vibration) subscribe here. Returns the unsubscribe function. They hear the alerts
   * shown in the app (a toast); one shown as a system notification while the app is in the background is
   * not passed on, because the system plays its own sound (v2.5 A52: never both).
   */
  subscribeAlerts(listener: (alert: AlertEvent) => void): () => void;

  /** Activate the waiting service worker and reload (refused while a draft or outbox job exists). */
  applyUpdate(): Promise<boolean>;

  /**
   * (Added in Phase 1b, A15.) Post every `/_next/static/*` URL this page has loaded to the service worker
   * and wait until it cached them; sets state.offlineReady. The shell calls it after the idle prefetch of
   * every view chunk. Resolves false without a service worker (development, unsupported browsers).
   */
  prepareOffline?(): Promise<boolean>;

  /**
   * (Added 2026-11-06 evening, F3.) Messages and en route: threads, the message / en route outbox, read
   * cursors. Absent in stores without it (the test stub): screens then show no Messages. Use the hooks in
   * lib/client/messages-hooks.ts.
   */
  messages?: MessagingApi;
}

/**
 * SERVER-RENDER INVARIANTS. StoreProvider is rendered on the server too: AppShell is a client component
 * returned by a server page, and the store is built in a useState initializer that runs during server
 * rendering. ShellBanners and ShellHosts put store state into the server HTML. That HTML is the shell the
 * service worker caches, and the cached copy is hydrated on later reloads, offline included. So:
 *
 *   1. Construction is PURE. Building the store (createXStore(...)) starts nothing: no timers, no fetch,
 *      no IndexedDB, no navigator / window / document listeners, no BroadcastChannel, no navigator.locks,
 *      no service-worker calls, no legacy-queue import. On the server, every request builds a store and
 *      throws it away; anything started there leaks (a poll timer per request).
 *   2. Side effects begin in `start()`, which StoreProvider calls from useEffect (client only, after
 *      hydration). start() returns the function that stops them all. React StrictMode in development
 *      runs start → stop → start, so stop must undo everything and start must work again afterwards.
 *   3. Hydration matches the server. React hydrates with the SERVER snapshot: `getServerState()` when the
 *      store has it, otherwise `getState()`. That state must equal what the server rendered, whatever the
 *      phone knows: connection 'live', empty outbox, no outboxPrompt, no toasts, no snackbar, and so on.
 *      createServerState(eventTimezone) builds exactly that. React re-renders with getState() right
 *      after hydration, so an offline reload shows the offline banner one frame later instead of throwing
 *      away the whole Suspense boundary on a hydration mismatch.
 *      The real store SHOULD implement getServerState(), because its getState() may legitimately differ
 *      on the client before start(). state.prefs, for example, starts as readPrefs() (A29), which reads
 *      localStorage on the client and returns DEFAULT_PREFS on the server.
 */
export interface AppStore {
  getState(): StoreState;
  subscribe(listener: () => void): () => void;
  actions: StoreActions;
  /**
   * Begin every side effect: sync polling, IndexedDB hydration of the cache / outbox / phone ids,
   * navigator.onLine and online/offline/focus/visibility/pageshow listeners, the outbox worker,
   * BroadcastChannel('lp'), the legacy-queue import and service-worker wiring. Called once per mount by
   * StoreProvider (client only). Returns the stop function. Optional: a store without side effects (the
   * stub) omits it.
   */
  start?(): () => void;
  /**
   * The state the server renders, for hydration: createServerState(eventTimezone). It must return the
   * SAME object on every call (useSyncExternalStore requires a cached snapshot) and must not depend on
   * anything only the browser knows (localStorage, IndexedDB, navigator, the clock).
   */
  getServerState?(): StoreState;
}

/**
 * The store state as rendered on the server and during hydration (see the invariants above): nothing
 * loaded, nothing queued, connection 'live', session 'unknown', default prefs. Build it once per store and
 * return that same object from getServerState().
 */
export function createServerState(eventTimezone: string, event: EventConfig | null = null, role: SessionRole | null = null): StoreState {
  return {
    hydrated: false,
    hasData: false,
    confirmed: new Map(),
    pending: new Map(),
    outbox: [],
    outboxPrompt: null,
    connection: 'live',
    syncing: false,
    lastSyncAt: null,
    lastSyncLocalAt: null,
    session: { status: 'unknown', staffName: null, team: null, staff: null, expiresAt: null },
    myIds: new Set(),
    prefs: { ...DEFAULT_PREFS },
    toasts: [],
    snackbar: null,
    updateReady: false,
    offlineReady: false,
    generation: 0,
    eventTimezone,
    durableStorage: true,
    event,
    role,
  };
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
  const getSnapshot = useMemo(() => memoizedSnapshot(() => store.getState(), selector, isEqual), [store, selector, isEqual]);
  // Server render and hydration read getServerState() when the store has it (server-render invariants
  // above AppStore); React then re-renders with getSnapshot.
  const getServerSnapshot = useMemo(() => {
    const readServer = store.getServerState?.bind(store);
    return readServer ? memoizedSnapshot(readServer, selector, isEqual) : getSnapshot;
  }, [store, selector, isEqual, getSnapshot]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot);
}

/**
 * A snapshot function with its own memo: reused while the state is unchanged, and the previous value is
 * kept when a recomputed one is equal, so useSyncExternalStore always sees a stable snapshot.
 */
function memoizedSnapshot<T>(read: () => StoreState, selector: (state: StoreState) => T, isEqual: (a: T, b: T) => boolean): () => T {
  let memo: { state: StoreState; value: T } | null = null;
  return () => {
    const state = read();
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
  shallowEqual(a.friendComing, b.friendComing) && shallowEqual(a.waiting, b.waiting) && shallowEqual(a.swapRequested, b.swapRequested);
const selectPending = (s: StoreState) => pendingGroups(selectMerged(s));
const selectMine = (s: StoreState) => mineRows(selectMerged(s), s.myIds, s.session.staff);
const selectOutbox = (s: StoreState) => visibleOutbox(s.outbox, s.confirmed);
const selectCounts = (s: StoreState) =>
  viewCounts(selectMerged(s), visibleOutbox(s.outbox, s.confirmed), s.myIds, s.session.staff);
const selectConnection = (s: StoreState) => ({ connection: s.connection, syncing: s.syncing, lastSyncAt: s.lastSyncAt });
const selectLiveSync = (s: StoreState) => ({ connection: s.connection, syncedAt: s.lastSyncLocalAt });
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
  const open = !!filter.open;
  const selector = useCallback((s: StoreState) => filterAll(selectMerged(s), { status, post, open }), [status, post, open]);
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
  // Pending v9.1: Pending counts every request Waiting for check (held ones included: "Not found yet" is an
  // indicator, not a lane) and every one In medical.
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

/**
 * (Added in v2.2.) The live indicator's inputs: the connection, and this phone's clock at the last successful
 * sync (null before the first one).
 */
export function useLiveSync(): { connection: Connection; syncedAt: number | null } {
  return useStoreSelector(selectLiveSync, shallowEqual);
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

/**
 * Dashboard stats, polled every 15 s while `active` (A5). `updatedAt` (added in v2.2, the live indicator) is
 * this phone's clock when the last fetch succeeded. `refresh` (added in v2.2 afternoon, Refresh now) fetches at
 * once, joining a fetch already on its way, and resolves when it has settled; the next poll is 15 s after it.
 * `error`: the last fetch failed. `failing` (added in the v2.2 afternoon review): fetches failed past the
 * lists' thresholds (2 network failures or timeouts, or 3 server errors, in a row), the dashboard's
 * Reconnecting. When the connection comes back after a failed fetch, it fetches at once. The poller
 * (stats-poller.ts) loads with the dashboard, off the first-load path of `/` (v2.2 A25 budget).
 */
export function useStats(active: boolean): StatsState & { refresh: () => Promise<void> } {
  const store = useAppStore();
  const [state, setState] = useState<StatsState>(NO_STATS);
  const runRef = useRef<() => Promise<void>>(idle);
  const refresh = useCallback(() => runRef.current(), []);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let stop: (() => void) | undefined;
    import('./stats-poller').then(
      ({ startStatsPoller, subscribeReconnect }) => {
        if (!live) return;
        const poller = startStatsPoller({
          fetchStats: () => store.actions.fetchStats(),
          onChange: setState,
          subscribeReconnect: (onReconnect) => subscribeReconnect(store, onReconnect),
          pollMs: STATS_POLL_MS,
        });
        runRef.current = poller.refresh;
        stop = poller.stop;
      },
      // The chunk didn't load: "Can't reach the log · Try again" (which remounts this).
      () => {
        if (live) setState((s) => ({ ...s, error: true }));
      },
    );
    return () => {
      live = false;
      stop?.();
      runRef.current = idle;
    };
  }, [store, active]);
  return { ...state, refresh };
}
const NO_STATS: StatsState = { stats: null, updatedAt: null, error: false, failing: false };
const idle = () => Promise.resolve();


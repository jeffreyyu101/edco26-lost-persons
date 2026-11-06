// The real client store (spec §7, v2.1 A5–A7, A10–A15, A20, A22, v2.3 A38). Implements AppStore from
// store-contract.ts exactly. Screens subscribe through the selector hooks there and never call fetch.
//
// Server-render invariants (store-contract.ts, above AppStore):
//   * createAppStore() is PURE: it reads localStorage prefs (readPrefs) and nothing else. No timers, fetch,
//     IndexedDB, listeners, BroadcastChannel, locks or service worker.
//   * start() begins every side effect and returns the stop function. stop → start works (StrictMode).
//   * getServerState() returns createServerState(eventTimezone), the same object every time.
//
// Data model: `confirmed` is the last server truth (monotonic: a row replaces the stored one only when its
// rowVersion is ≥), `pending` holds optimistic overlays of in-flight mutations (never left once the server
// answered), and the outbox holds every create (persisted before it is sent). Every async result is
// checked against `generation` (bumped on logout) and dropped when it belongs to an older session.
//
// Privacy: nothing here logs (no console use at all); errors carry codes, never request data.
import type {
  ChangeResponse,
  CreateRequestBody,
  CreateResponse,
  OutboxItem,
  PhotoResponse,
  RequestDetail,
  RequestPatch,
  RequestSummary,
  SessionInfo,
  Stats,
  SyncResponse,
} from '../api-types';
import { SETTABLE_STATUSES, STATUS, canonStaff, isUuid, statusMeta, staffString, undoTarget, type SettableStatus, type StatusKind } from '../domain';
import { formatCaseNumber } from '../format';
import { syncPath } from './api-paths';
import { alertKey, alertToast, coalesceAlerts, diffAlerts, type AlertContext } from './alerts';
import { DRAFT_DEBOUNCE_MS, LEGACY_QUEUE_KEY, MUTATION_TIMEOUT_MS, SYNC, UNDO_MS } from './constants';
import { createBodyFromLegacyQueueItem, hasAnyDetail, toCreateBody } from './form-values';
import { apiRequest, isDefinitive, type FetchLike, type HttpFailure, type HttpResult } from './http';
import { navigate } from './nav';
import {
  CREATE_DEFINITIVE,
  PHOTO_DEFINITIVE,
  confirmedRowForJob,
  failureCode,
  nextPollDelay,
  outboxBackoffMs,
  promptFor,
} from './outbox-logic';
import {
  K,
  draftToStored,
  jobToStored,
  openKv,
  readDraft,
  readJobs,
  readRows,
  writePhotoBlobs,
  type Kv,
  type StoredCursor,
  type StoredDraft,
  type StoredStaff,
} from './persist';
import { readPrefs, subscribePrefs, writePref } from './prefs';
import { startServiceWorker, type SwController } from './sw-client';
import {
  createServerState,
  type AlertEvent,
  type AppStore,
  type Connection,
  type CreateInput,
  type CreateResult,
  type DraftPhoto,
  type MutationFailure,
  type MutationResult,
  type Overlay,
  type RequestDraft,
  type StoreActions,
  type StoreState,
  type ToastItem,
} from './store-contract';
import { chunk, isRow, mergeRows, overlayForPatch, replaceAll, staleIds, summaryOf } from './sync-merge';
import { uuid } from './uuid';

// ---------------------------------------------------------------------------------------------------
// Environment (injectable for tests; the browser default is built lazily in start())
// ---------------------------------------------------------------------------------------------------

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface LocksLike {
  request<T>(name: string, options: { ifAvailable?: boolean; steal?: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

export interface StoreEnv {
  fetch: FetchLike;
  online(): boolean;
  visible(): boolean;
  /** Add a listener to window or document; returns the remover. */
  on(target: 'window' | 'document', type: string, handler: (event: Event) => void): () => void;
  locks: LocksLike | null;
  channel(name: string): ChannelLike | null;
  openKv(): Kv | null;
  /** localStorage (legacy queue import, outbox lease fallback). */
  localStorage(): Storage | null;
  /** sessionStorage (401 redirect loop guard). */
  sessionStorage(): Storage | null;
  /** Full navigation (sign-in after a 401 or a sign-out). */
  redirect(url: string): void;
  /** pathname + search of the current page. */
  location(): string;
  serviceWorker(hooks: { onUpdateReady(): void; onOfflineReady(): void }): SwController | null;
}

function safeStorage(get: () => Storage): Storage | null {
  try {
    return get();
  } catch {
    return null;
  }
}

export function browserEnv(): StoreEnv {
  return {
    fetch: (input, init) => window.fetch(input, init),
    online: () => navigator.onLine !== false,
    visible: () => document.visibilityState !== 'hidden',
    on(target, type, handler) {
      const t: EventTarget = target === 'window' ? window : document;
      t.addEventListener(type, handler);
      return () => t.removeEventListener(type, handler);
    },
    locks: (navigator as Navigator & { locks?: LocksLike }).locks ?? null,
    channel: (name) => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name)),
    openKv: () => openKv(),
    localStorage: () => safeStorage(() => window.localStorage),
    sessionStorage: () => safeStorage(() => window.sessionStorage),
    redirect: (url) => window.location.assign(url),
    location: () => `${window.location.pathname}${window.location.search}`,
    serviceWorker: (hooks) => startServiceWorker(hooks),
  };
}

export interface CreateAppStoreOptions {
  eventTimezone: string;
  /** Tests inject a fake environment; the browser one is used otherwise. */
  env?: () => StoreEnv;
}

// ---------------------------------------------------------------------------------------------------
// Copy (spec §7 Mutations / §8; never contains request data)
// ---------------------------------------------------------------------------------------------------

export const COPY = {
  conflict: 'Updated by someone else',
  failed: "Couldn't save — check signal and try again",
  needsConnection: 'Needs a connection',
  forbidden: 'Only the person who logged it can do that',
  invalid: "That change isn't allowed now",
  notFound: 'Request not found',
  savedHere: 'Saved on this phone',
  sendsLater: 'Sends when back online',
  notSaved: "Couldn't save — check signal and try again",
  needsAttention: 'Not sent · needs attention',
  updateReady: 'Update ready',
  finishDraft: 'Finish or cancel the new request first',
  waitOutbox: 'Saved requests are still sending',
  sessionEnded: 'Session ended',
} as const;

const UNDOABLE_KINDS: ReadonlySet<StatusKind> = new Set(['answer', 'change', 'reunite']);
const MAX_TOASTS = 3;
const MAX_SYNC_PAGES = 40;
const ROWS_WRITE_MS = 1_500;
const OUTBOX_CREATE_TIMEOUT_MS = 15_000;
const PHOTO_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 15_000;
const LOCK_STEAL_AFTER = 8;
const LEASE_KEY = 'lp-outbox-lease';
const LEASE_MS = 30_000;
const REDIRECT_GUARD_KEY = 'lp-401-at';
const REDIRECT_GUARD_MS = 20_000;
const SIGN_OUT_TIMEOUT_MS = 5_000;

type PollOutcome = 'ok' | 'network' | 'http5xx' | 'http4xx' | 'unauthorized' | 'offline' | 'stale';

interface UndoRecord {
  id: string;
  to: SettableStatus;
  version: number;
}

class FetchError extends Error {
  constructor(readonly reason: MutationFailure) {
    super(reason);
    this.name = 'FetchError';
  }
}

const isSettable = (s: string): s is SettableStatus => (SETTABLE_STATUSES as readonly string[]).includes(s);

// ---------------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------------

export function createAppStore(options: CreateAppStoreOptions): AppStore {
  const serverState = createServerState(options.eventTimezone);
  // Pure: readPrefs() only reads localStorage (DEFAULT_PREFS on the server).
  let state: StoreState = { ...createServerState(options.eventTimezone), prefs: readPrefs() };
  const listeners = new Set<() => void>();
  const alertListeners = new Set<(alert: AlertEvent) => void>();

  const emit = () => {
    for (const l of [...listeners]) l();
  };
  const set = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    emit();
  };

  // ---- runtime (everything below is only touched after start()) ----
  let env: StoreEnv | null = null;
  let running = false;
  let runId = 0;
  const offs: Array<() => void> = [];
  let channel: ChannelLike | null = null;
  let sw: SwController | null = null;
  let kv: Kv | null = null;
  let kvQueue: Promise<unknown> = Promise.resolve();
  const tabId = uuid();

  // sync
  let cursor: string | null = null;
  let cursorAt = 0;
  /** Canonical staff whose cache is loaded / written. */
  let cacheStaff: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollInFlight = false;
  let pollRerun = false;
  let pollAbort: AbortController | null = null;
  let pollCount = 0;
  let reconcileDue = false;
  let netFailures = 0;
  let httpFailures = 0;
  let failures = 0;
  /** The first successful sync after load is the alert baseline. */
  let armed = false;
  const seen = new Set<string>();
  const ownKeys = new Set<string>();
  /** Rows a mutation answered while a full fetch was loading (kept by replaceAll). */
  const touchedDuringPoll = new Set<string>();
  let rowsTimer: ReturnType<typeof setTimeout> | undefined;
  let rowsDirty = false;

  // mutations
  const chains = new Map<string, Promise<unknown>>();
  const undoRecords = new Map<string, UndoRecord>();
  let snackTimer: ReturnType<typeof setTimeout> | undefined;
  const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // outbox
  let workerRunning = false;
  let workerAgain = false;
  let outboxTimer: ReturnType<typeof setTimeout> | undefined;
  let lockMisses = 0;
  const directSends = new Set<string>();
  const approved = new Set<string>();
  let promptIds: string[] = [];
  const photoWarned = new Set<string>();

  // drafts
  let draftPending: RequestDraft | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let draftHas = false;
  const draftSavedPhotos = new Set<string>();

  let updateToastId: string | null = null;
  let signingOut = false;

  const now = () => Date.now();
  const isLive = (id: number) => running && runId === id;
  const ownerGen = () => state.generation;

  // ---- persistence queue (writes are serialised so a logout clear always lands last) ----
  const enqueue = <T>(op: (store: Kv) => Promise<T>): Promise<T | undefined> => {
    const store = kv;
    if (!store) return Promise.resolve(undefined);
    const next = kvQueue.then(
      () => op(store),
      () => op(store),
    );
    kvQueue = next.catch(() => undefined);
    return next.catch(() => undefined);
  };

  // ---- toasts / snackbar ----
  const dismissToast = (id: string) => {
    const t = toastTimers.get(id);
    if (t) clearTimeout(t);
    toastTimers.delete(id);
    if (id === updateToastId) updateToastId = null;
    if (state.toasts.some((x) => x.id === id)) set({ toasts: state.toasts.filter((x) => x.id !== id) });
  };

  const showToast = (toast: Omit<ToastItem, 'id'>): string => {
    const id = uuid();
    // The same message twice replaces the older one; at most MAX_TOASTS stay.
    const kept = state.toasts.filter((x) => !(x.title === toast.title && x.subtitle === toast.subtitle));
    for (const x of state.toasts) if (!kept.includes(x)) dismissTimers(x.id);
    let toasts = [...kept, { ...toast, id }];
    while (toasts.length > MAX_TOASTS) {
      const dropped = toasts.find((x) => x.id !== updateToastId) ?? toasts[0];
      if (!dropped) break;
      dismissTimers(dropped.id);
      toasts = toasts.filter((x) => x !== dropped);
    }
    set({ toasts });
    if (toast.durationMs) toastTimers.set(id, setTimeout(() => dismissToast(id), toast.durationMs));
    return id;
  };
  const dismissTimers = (id: string) => {
    const t = toastTimers.get(id);
    if (t) clearTimeout(t);
    toastTimers.delete(id);
  };

  const toastFailure = (title: string, tone: ToastItem['tone'] = 'red') =>
    showToast({ tone, icon: tone === 'amber' ? 'alert' : 'cloud-off', title, durationMs: 6_000 });

  const clearSnackbar = () => {
    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = undefined;
    undoRecords.clear();
    if (state.snackbar) set({ snackbar: null });
  };

  // ---- connection ----
  const setConnection = (connection: Connection) => {
    if (state.connection !== connection) set({ connection });
  };
  const markLive = () => {
    netFailures = 0;
    httpFailures = 0;
    setConnection('live');
  };
  const offlineNow = () => !(env?.online() ?? true) || state.connection === 'offline';

  // ---- rows ----
  const alertCtx = (): AlertContext => ({
    sessionStaff: state.session.staff,
    myIds: state.myIds,
    ownMutationIds: new Set(state.outbox.map((j) => j.mutationId)),
    ownKeys,
    bell: state.prefs.bell,
    seen,
  });

  const emitAlerts = (alerts: AlertEvent[]) => {
    for (const alert of coalesceAlerts(alerts)) {
      showToast(alertToast(alert, (id) => navigate({ r: id })));
      for (const l of [...alertListeners]) {
        try {
          l(alert);
        } catch {
          // A host's failure never stops the others.
        }
      }
    }
  };

  /** Rows from the server that may be someone else's changes: alert (once armed), then merge. */
  const ingest = (rows: readonly RequestSummary[], collect?: AlertEvent[]) => {
    const valid = rows.filter(isRow);
    if (valid.length === 0) return;
    if (armed) {
      const alerts = diffAlerts(state.confirmed, valid, alertCtx());
      if (collect) collect.push(...alerts);
      else if (alerts.length) emitAlerts(alerts);
    }
    const merged = mergeRows(state.confirmed, valid);
    if (merged) {
      set({ confirmed: merged, hasData: true });
      markRowsDirty();
    }
  };

  const rememberOwn = (row: RequestSummary) => {
    ownKeys.add(alertKey(row));
    if (ownKeys.size > 2_000) {
      const first = ownKeys.values().next().value;
      if (first) ownKeys.delete(first);
    }
    touchedDuringPoll.add(row.id);
  };

  /** This phone's own mutation result: never alerts. Drops the overlay in the same update (no flicker). */
  const commitOwn = (row: RequestSummary | null, dropOverlayFor?: string) => {
    const patch: Partial<StoreState> = {};
    if (row && isRow(row)) {
      rememberOwn(row);
      const merged = mergeRows(state.confirmed, [row]);
      if (merged) {
        patch.confirmed = merged;
        patch.hasData = true;
        markRowsDirty();
      }
    }
    if (dropOverlayFor && state.pending.has(dropOverlayFor)) {
      const pending = new Map(state.pending);
      pending.delete(dropOverlayFor);
      patch.pending = pending;
    }
    if (Object.keys(patch).length) set(patch);
  };

  const setOverlay = (id: string, overlay: Overlay) => {
    const pending = new Map(state.pending);
    pending.set(id, overlay);
    set({ pending });
  };
  const dropOverlay = (id: string) => commitOwn(null, id);

  const markRowsDirty = () => {
    rowsDirty = true;
    if (!running || rowsTimer) return;
    rowsTimer = setTimeout(() => {
      rowsTimer = undefined;
      void flushRows();
    }, ROWS_WRITE_MS);
  };

  const flushRows = async () => {
    if (rowsTimer) clearTimeout(rowsTimer);
    rowsTimer = undefined;
    if (!rowsDirty || !cacheStaff) return;
    rowsDirty = false;
    const staffKey = cacheStaff;
    const rows = [...state.confirmed.values()];
    const gen = ownerGen();
    await enqueue(async (store) => {
      if (gen !== state.generation) return;
      await store.set(K.rows(staffKey), rows);
    });
  };

  const writeCursor = (value: string) => {
    if (!cacheStaff) return;
    const staffKey = cacheStaff;
    const record: StoredCursor = { cursor: value, at: cursorAt };
    const gen = ownerGen();
    void enqueue(async (store) => {
      if (gen !== state.generation) return;
      await store.set(K.cursor(staffKey), record);
    });
  };

  /** Load the cache of one staff (after hydrate or a session for someone else). */
  const loadCache = async (staffCanon: string) => {
    if (!kv) return;
    try {
      const [rows, cur] = await Promise.all([readRows(kv, staffCanon), kv.get<StoredCursor>(K.cursor(staffCanon))]);
      cacheStaff = staffCanon;
      if (rows) {
        const merged = mergeRows(state.confirmed, rows.filter(isRow));
        set({ confirmed: merged ?? state.confirmed, hasData: true });
      }
      if (cur && typeof cur.cursor === 'string') {
        cursor = cur.cursor;
        cursorAt = typeof cur.at === 'number' ? cur.at : 0;
      }
    } catch {
      // A broken cache is just an empty one: the first sync is a full fetch.
    }
  };

  // ---- session ----
  const operatorNow = (): OutboxItem['operator'] => {
    const s = state.session;
    if (s.status === 'active' && s.staffName && s.team && s.staff) return { staffName: s.staffName, team: s.team, staff: s.staff };
    const p = state.prefs;
    if (p.rememberedName && p.rememberedTeam) {
      return { staffName: p.rememberedName, team: p.rememberedTeam, staff: staffString(p.rememberedName, p.rememberedTeam) };
    }
    return { staffName: '', team: '', staff: '' };
  };

  const applySession = async (info: SessionInfo) => {
    const canon = canonStaff(info.staff) ?? '';
    if (cacheStaff !== canon) {
      // Someone else's (or no) cache was loaded: start clean for this staff.
      if (cacheStaff !== null) {
        set({ confirmed: new Map(), pending: new Map(), hasData: false });
        cursor = null;
        cursorAt = 0;
        armed = false;
      }
      await loadCache(canon);
      cacheStaff = canon;
    }
    set({ session: { status: 'active', staffName: info.staffName, team: info.team, staff: info.staff, expiresAt: info.expiresAt } });
    const last: StoredStaff = { staffName: info.staffName, team: info.team, staff: info.staff };
    void enqueue((store) => store.set(K.lastStaff, last));
    refreshPrompt();
    kickOutbox();
  };

  const checkSession = async (): Promise<PollOutcome> => {
    if (!env) return 'stale';
    const gen = ownerGen();
    const res = await apiRequest<SessionInfo>(env.fetch, '/api/session', { timeoutMs: SYNC.requestTimeoutMs, signal: pollAbort?.signal });
    if (gen !== state.generation) return 'stale';
    if (res.ok) {
      const info = res.data;
      if (typeof info.staff !== 'string' || typeof info.staffName !== 'string' || typeof info.team !== 'string') return 'http5xx';
      await applySession(info);
      return 'ok';
    }
    return failureOutcome(res);
  };

  const failureOutcome = (res: HttpFailure): PollOutcome => {
    if (res.kind !== 'http') return 'network';
    if (res.status === 401) {
      sessionExpired();
      return 'unauthorized';
    }
    return res.status >= 500 ? 'http5xx' : 'http4xx';
  };

  /** A 401: keep the cache and outbox, pause, and go to sign-in step 2 (remembered name and team). */
  const sessionExpired = () => {
    if (state.session.status === 'expired' || signingOut) return;
    set({ session: { ...state.session, status: 'expired' } });
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    pollAbort?.abort();
    clearSnackbar();
    const e = env;
    if (!e) return;
    const guard = e.sessionStorage();
    let recent = false;
    try {
      const at = Number(guard?.getItem(REDIRECT_GUARD_KEY) ?? 0);
      recent = Number.isFinite(at) && now() - at < REDIRECT_GUARD_MS;
      guard?.setItem(REDIRECT_GUARD_KEY, String(now()));
    } catch {
      recent = false;
    }
    const target = `/signin?next=${encodeURIComponent(e.location())}`;
    if (recent) {
      // We were just sent back here with a cookie the API refuses: don't loop, offer the way out.
      showToast({ tone: 'amber', icon: 'alert', title: COPY.sessionEnded, action: { label: 'Sign in', run: () => e.redirect(target) }, durationMs: null });
      return;
    }
    void Promise.race([Promise.all([draftApi.flush(), flushRows()]), new Promise((r) => setTimeout(r, 600))]).then(() => {
      if (state.session.status === 'expired') e.redirect(target);
    });
  };

  // ---- sync loop ----
  const schedulePoll = (delayMs: number) => {
    if (!running) return;
    if (pollTimer) clearTimeout(pollTimer);
    const id = runId;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void poll(id);
    }, Math.max(0, delayMs));
  };

  /** Focus / online / pageshow / visible / tap-the-dot: bursts coalesce into one poll. */
  const triggerSync = () => {
    if (!running || signingOut || state.session.status === 'expired') return;
    if (pollInFlight) {
      pollRerun = true;
      return;
    }
    schedulePoll(30);
  };

  const poll = async (id: number) => {
    if (!isLive(id) || pollInFlight || !env) return;
    if (state.session.status === 'expired' || state.session.status === 'signed_out') return;
    pollInFlight = true;
    pollRerun = false;
    pollCount += 1;
    if (pollCount % SYNC.reconcileEvery === 0) reconcileDue = true;
    const gen = ownerGen();
    let outcome: PollOutcome;
    if (!env.online()) {
      outcome = 'offline';
    } else {
      pollAbort = new AbortController();
      set({ syncing: true });
      try {
        outcome = await runSync(gen);
      } catch {
        outcome = 'http5xx';
      } finally {
        pollAbort = null;
        if (state.syncing) set({ syncing: false });
      }
    }
    pollInFlight = false;
    if (!isLive(id) || gen !== state.generation || outcome === 'stale') return;
    switch (outcome) {
      case 'ok':
        failures = 0;
        markLive();
        break;
      case 'offline':
        failures += 1;
        setConnection('offline');
        break;
      case 'network':
        failures += 1;
        netFailures += 1;
        if (netFailures >= 2) setConnection('offline');
        break;
      case 'http5xx':
        failures += 1;
        httpFailures += 1;
        netFailures = 0;
        if (httpFailures >= 3) setConnection('error');
        break;
      case 'http4xx':
        failures += 1;
        break;
      case 'unauthorized':
        return;
    }
    const delay = pollRerun ? 0 : nextPollDelay(failures, env.visible(), Math.random());
    schedulePoll(delay);
  };

  const runSync = async (gen: number): Promise<PollOutcome> => {
    const e = env;
    if (!e) return 'stale';
    if (state.session.status !== 'active') {
      const s = await checkSession();
      if (s !== 'ok') return s;
    }
    const full = cursor === null || now() - cursorAt > SYNC.fullFetchAfterMs;
    const reconcile = !full && reconcileDue;
    const since = full ? null : cursor;
    touchedDuringPoll.clear();
    const alerts: AlertEvent[] = [];
    const fullRows: RequestSummary[] = [];
    let versions: Array<[string, number]> | undefined;
    let firstServerTime: string | null = null;
    let after: SyncResponse['next'] = null;
    for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
      const path = syncPathFor(since, page === 0 && reconcile, after);
      const res = await apiRequest<SyncResponse>(e.fetch, path, { timeoutMs: SYNC.requestTimeoutMs, signal: pollAbort?.signal });
      if (gen !== state.generation || !running) return 'stale';
      if (!res.ok) return failureOutcome(res);
      const body = res.data;
      if (typeof body.serverTime !== 'string' || !Array.isArray(body.rows)) return 'http5xx';
      if (page === 0) firstServerTime = body.serverTime;
      if (Array.isArray(body.versions)) versions = [...(versions ?? []), ...body.versions];
      if (full) fullRows.push(...body.rows.filter(isRow));
      else ingest(body.rows, alerts);
      if (!body.hasMore || !body.next || typeof body.next.at !== 'string' || typeof body.next.id !== 'string') break;
      after = body.next;
    }
    if (full) {
      const valid = fullRows;
      if (armed) alerts.push(...diffAlerts(state.confirmed, valid, alertCtx()));
      set({ confirmed: replaceAll(state.confirmed, valid, touchedDuringPoll), hasData: true });
      markRowsDirty();
    }
    if (reconcile && versions) {
      const stale = staleIds(state.confirmed, versions);
      for (const ids of chunk(stale, 200)) {
        const res = await apiRequest<SyncResponse>(e.fetch, syncPathIds(ids), { timeoutMs: SYNC.requestTimeoutMs, signal: pollAbort?.signal });
        if (gen !== state.generation || !running) return 'stale';
        if (!res.ok) return failureOutcome(res);
        if (Array.isArray(res.data.rows)) ingest(res.data.rows, alerts);
      }
      reconcileDue = false;
    }
    if (firstServerTime) {
      // The cursor advances only after every page is applied, verbatim (A7, A37).
      cursor = firstServerTime;
      cursorAt = now();
      writeCursor(firstServerTime);
      set({ lastSyncAt: firstServerTime, hasData: true });
    }
    if (armed) {
      if (alerts.length) emitAlerts(alerts);
    } else {
      armed = true; // the first sync after load is the baseline: it alerts nothing
    }
    if (state.outbox.length) kickOutbox();
    return 'ok';
  };

  /** One row, fresh (409 follow-up, A12). */
  const fetchRow = async (id: string): Promise<RequestSummary | null> => {
    if (!env) return null;
    const gen = ownerGen();
    const res = await apiRequest<SyncResponse>(env.fetch, syncPathIds([id]), { timeoutMs: MUTATION_TIMEOUT_MS });
    if (gen !== state.generation) return null;
    if (!res.ok) {
      if (res.kind === 'http' && res.status === 401) sessionExpired();
      return null;
    }
    const row = Array.isArray(res.data.rows) ? res.data.rows.find((r) => isRow(r) && r.id === id) : undefined;
    if (!row) return null;
    ingest([row]);
    return state.confirmed.get(id) ?? row;
  };

  // ---- per-id serialisation ----
  const serialize = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(id, next);
    void next.then(
      () => {
        if (chains.get(id) === next) chains.delete(id);
      },
      () => {
        if (chains.get(id) === next) chains.delete(id);
      },
    );
    return next;
  };

  const fail = (reason: MutationFailure, message: string, latest?: RequestSummary): MutationResult =>
    latest ? { ok: false, reason, message, latest } : { ok: false, reason, message };

  /** Drop the overlay, then map a failure to a result (and a toast). Never leaves unconfirmed state. */
  const mutationFailed = async (id: string, res: HttpFailure, opts: { conflictToast: boolean }): Promise<MutationResult> => {
    dropOverlay(id);
    if (res.kind === 'http') {
      switch (res.status) {
        case 401:
          sessionExpired();
          return fail('unauthorized', COPY.sessionEnded);
        case 409: {
          const latest = await fetchRow(id);
          if (opts.conflictToast) showToast({ tone: 'amber', icon: 'alert', title: COPY.conflict, durationMs: 6_000 });
          return fail('conflict', COPY.conflict, latest ?? undefined);
        }
        case 403:
          toastFailure(COPY.forbidden, 'amber');
          return fail('forbidden', COPY.forbidden);
        case 404:
          toastFailure(COPY.notFound, 'amber');
          return fail('not_found', COPY.notFound);
        case 422: {
          const latest = await fetchRow(id);
          toastFailure(COPY.invalid, 'amber');
          return fail('invalid', res.error?.message || COPY.invalid, latest ?? undefined);
        }
        default:
          break;
      }
    }
    toastFailure(COPY.failed);
    return fail('failed', COPY.failed);
  };

  const refuseOffline = (): MutationResult => {
    showToast({ tone: 'amber', icon: 'cloud-off', title: COPY.needsConnection, durationMs: 4_000 });
    return fail('offline', COPY.needsConnection);
  };

  const postStatus = (id: string, status: SettableStatus, expectedVersion: number, kind: StatusKind) =>
    apiRequest<ChangeResponse>(requireEnv().fetch, `/api/requests/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      json: { status, expectedVersion, kind },
      timeoutMs: MUTATION_TIMEOUT_MS,
    });

  const showUndo = (row: RequestSummary, from: string, to: SettableStatus) => {
    const back = undoTarget(from);
    if (!back || !isSettable(back) || back === to) return;
    clearSnackbar();
    const snackId = uuid();
    undoRecords.set(snackId, { id: row.id, to: back, version: row.rowVersion });
    set({ snackbar: { id: snackId, message: `${formatCaseNumber(row.caseNumber)} · ${statusMeta(to).shortLabel}`, expiresAt: now() + UNDO_MS } });
    snackTimer = setTimeout(() => {
      snackTimer = undefined;
      undoRecords.delete(snackId);
      if (state.snackbar?.id === snackId) set({ snackbar: null });
    }, UNDO_MS);
  };

  const runStatus = async (id: string, to: SettableStatus, kind: StatusKind, undoVersion: number | null): Promise<MutationResult> => {
    const gen = ownerGen();
    const row = state.confirmed.get(id);
    if (!row) return fail('not_found', COPY.notFound);
    const from = row.status;
    // A queued second tap that the first one already satisfied.
    if (undoVersion === null && from === to) return { ok: true, changed: false, request: row };
    setOverlay(id, { mutationId: uuid(), kind: 'status', fields: { status: to }, startedAt: now() });
    let res: HttpResult<ChangeResponse> = await postStatus(id, to, undoVersion ?? row.rowVersion, kind);
    if (gen !== state.generation) return fail('failed', COPY.failed);
    if (!res.ok && res.kind === 'http' && res.status === 409 && kind !== 'undo') {
      // A12: only fields or photos changed (same status as the tap started from) → resend once.
      const latest = await fetchRow(id);
      if (gen !== state.generation) return fail('failed', COPY.failed);
      if (latest && latest.status === from) {
        res = await postStatus(id, to, latest.rowVersion, kind);
        if (gen !== state.generation) return fail('failed', COPY.failed);
      } else {
        dropOverlay(id);
        showToast({ tone: 'amber', icon: 'alert', title: COPY.conflict, durationMs: 6_000 });
        return fail('conflict', COPY.conflict, latest ?? undefined);
      }
    }
    if (res.ok && isRow(res.data.request)) {
      const request = res.data.request;
      commitOwn(request, id);
      markLive();
      if (res.data.changed && UNDOABLE_KINDS.has(kind)) showUndo(request, from, to);
      return { ok: true, changed: !!res.data.changed, request: state.confirmed.get(id) ?? request };
    }
    if (res.ok) return mutationFailed(id, { ok: false, kind: 'network' }, { conflictToast: true });
    return mutationFailed(id, res, { conflictToast: true });
  };

  const requireEnv = (): StoreEnv => {
    if (!env) env = (options.env ?? browserEnv)();
    return env;
  };

  // ---- outbox ----
  const setJobs = (outbox: OutboxItem[]) => {
    set({ outbox });
  };
  const getJob = (mutationId: string) => state.outbox.find((j) => j.mutationId === mutationId) ?? null;
  const patchJob = (mutationId: string, patch: Partial<OutboxItem>): OutboxItem | null => {
    let updated: OutboxItem | null = null;
    const outbox = state.outbox.map((j) => {
      if (j.mutationId !== mutationId) return j;
      updated = { ...j, ...patch };
      return updated;
    });
    if (updated) setJobs(outbox);
    return updated;
  };

  const persistJob = async (job: OutboxItem, withBlobs: boolean): Promise<boolean> => {
    if (!kv || !state.durableStorage) return false;
    const gen = ownerGen();
    const ok = await enqueue(async (store) => {
      if (gen !== state.generation) return false;
      if (withBlobs) for (const p of job.photos) if (!p.acked) await writePhotoBlobs(store, p.photoId, p.blob, p.thumbBlob);
      await store.set(K.job(job.mutationId), jobToStored(job));
      return true;
    });
    return ok === true;
  };

  const checkpoint = (mutationId: string) => {
    const job = getJob(mutationId);
    if (job) void persistJob(job, false);
  };

  const removeJob = async (mutationId: string) => {
    setJobs(state.outbox.filter((j) => j.mutationId !== mutationId));
    approved.delete(mutationId);
    await enqueue((store) => store.del(K.job(mutationId)));
    await gcBlobs();
    broadcast({ type: 'outbox' });
    refreshPrompt();
  };

  /** Deletes photo bytes nobody references (finished jobs, cleared drafts). */
  const gcBlobs = async () => {
    await enqueue(async (store) => {
      const all = await store.keys();
      const blobKeys = all.filter((k) => k.startsWith('blob:'));
      if (blobKeys.length === 0) return;
      const keep = new Set<string>();
      const draft = await store.get<StoredDraft>(K.draft);
      for (const p of draft?.photos ?? []) keep.add(K.blob(p.photoId));
      for (const p of draftPending?.photos ?? []) keep.add(K.blob(p.photoId));
      for (const j of state.outbox) for (const p of j.photos) if (!p.acked) keep.add(K.blob(p.photoId));
      // Jobs other tabs wrote that this tab hasn't loaded yet.
      const jobKeys = all.filter((k) => k.startsWith('outbox:'));
      const jobs = await store.getMany<{ photos?: Array<{ photoId: string; acked: boolean }> }>(jobKeys);
      for (const j of jobs) for (const p of j?.photos ?? []) if (!p.acked) keep.add(K.blob(p.photoId));
      for (const k of blobKeys) if (!keep.has(k)) await store.del(k);
    });
  };

  const refreshPrompt = () => {
    const s = state.session;
    const found = s.status === 'active' ? promptFor(state.outbox, s.staff, s.staffName, approved) : null;
    promptIds = found?.ids ?? [];
    const next = found?.prompt ?? null;
    const cur = state.outboxPrompt;
    if (cur === next) return;
    if (cur && next && cur.count === next.count && cur.savedBy === next.savedBy && cur.sendAs === next.sendAs) return;
    set({ outboxPrompt: next });
  };

  const kickOutbox = () => {
    if (!running) return;
    if (workerRunning) {
      workerAgain = true;
      return;
    }
    void runWorker();
  };

  const scheduleOutbox = () => {
    if (outboxTimer) clearTimeout(outboxTimer);
    outboxTimer = undefined;
    if (!running) return;
    const due = state.outbox
      .filter((j) => j.state === 'pending' && j.nextAttemptAt !== null)
      .map((j) => j.nextAttemptAt as number);
    if (due.length === 0) return;
    const wait = Math.max(500, Math.min(...due) - now());
    outboxTimer = setTimeout(() => {
      outboxTimer = undefined;
      kickOutbox();
    }, wait);
  };

  const withOutboxLock = async (fn: () => Promise<void>): Promise<void> => {
    const e = requireEnv();
    if (e.locks) {
      const steal = lockMisses >= LOCK_STEAL_AFTER;
      await e.locks.request('lp-outbox', steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
        if (!lock) {
          lockMisses += 1;
          if (outboxTimer) clearTimeout(outboxTimer);
          outboxTimer = setTimeout(() => {
            outboxTimer = undefined;
            kickOutbox();
          }, LOCK_RETRY_MS);
          return;
        }
        lockMisses = 0;
        await fn();
      });
      return;
    }
    // Fallback without Web Locks: a lease in localStorage, released with a BroadcastChannel nudge.
    const ls = e.localStorage();
    let lease: { tab?: string; until?: number } | null = null;
    try {
      lease = JSON.parse(ls?.getItem(LEASE_KEY) ?? 'null') as { tab?: string; until?: number } | null;
    } catch {
      lease = null;
    }
    if (lease && lease.tab !== tabId && typeof lease.until === 'number' && lease.until > now()) {
      if (outboxTimer) clearTimeout(outboxTimer);
      outboxTimer = setTimeout(() => {
        outboxTimer = undefined;
        kickOutbox();
      }, LOCK_RETRY_MS);
      return;
    }
    const take = () => {
      try {
        ls?.setItem(LEASE_KEY, JSON.stringify({ tab: tabId, until: now() + LEASE_MS }));
      } catch {
        // best effort
      }
    };
    take();
    const renew = setInterval(take, LEASE_MS / 2);
    try {
      await fn();
    } finally {
      clearInterval(renew);
      try {
        const cur = JSON.parse(ls?.getItem(LEASE_KEY) ?? 'null') as { tab?: string } | null;
        if (cur?.tab === tabId) ls?.removeItem(LEASE_KEY);
      } catch {
        // best effort
      }
      broadcast({ type: 'outbox-idle' });
    }
  };

  const runWorker = async () => {
    workerRunning = true;
    try {
      do {
        workerAgain = false;
        if (!canFlush()) break;
        await withOutboxLock(flushPass);
      } while (workerAgain && running);
    } catch {
      // A broken pass is retried by the next trigger.
    } finally {
      workerRunning = false;
      scheduleOutbox();
    }
  };

  const canFlush = () => running && state.session.status === 'active' && !!env && env.online() && !signingOut;

  const flushPass = async () => {
    const gen = ownerGen();
    const blocked = new Set(promptIds);
    const order = [...state.outbox].sort((a, b) => a.createdAt - b.createdAt).map((j) => j.mutationId);
    for (const mutationId of order) {
      if (!canFlush() || gen !== state.generation) return;
      const job = getJob(mutationId);
      if (!job || job.state === 'needs_attention' || blocked.has(mutationId) || directSends.has(mutationId)) continue;
      if (job.nextAttemptAt !== null && job.nextAttemptAt > now()) continue;
      const result = await processJob(mutationId, gen);
      if (result === 'stop') return;
    }
  };

  const jobFailed = (mutationId: string, res: HttpFailure) => {
    const job = getJob(mutationId);
    if (!job) return;
    const attempts = job.attempts + 1;
    patchJob(mutationId, {
      state: 'pending',
      attempts,
      nextAttemptAt: now() + outboxBackoffMs(attempts),
      lastError: { code: failureCode(res), message: COPY.sendsLater, status: res.kind === 'http' ? res.status : null },
    });
    checkpoint(mutationId);
  };

  const jobNeedsAttention = (mutationId: string, res: HttpFailure) => {
    const err = res.kind === 'http' ? res.error : null;
    const job = patchJob(mutationId, {
      state: 'needs_attention',
      nextAttemptAt: null,
      lastError: {
        code: failureCode(res),
        message: err?.message || COPY.needsAttention,
        status: res.kind === 'http' ? res.status : null,
        ...(err?.field ? { field: err.field } : {}),
      },
    });
    if (job) checkpoint(mutationId);
  };

  const createdOk = (mutationId: string, request: RequestSummary) => {
    commitOwn(request);
    const myIds = new Set(state.myIds);
    if (!myIds.has(request.id)) {
      myIds.add(request.id);
      set({ myIds });
      const ids = [...myIds];
      void enqueue((store) => store.set(K.myIds, ids));
      broadcast({ type: 'myids' });
    }
    patchJob(mutationId, { serverId: request.id, caseNumber: request.caseNumber, lastError: null });
  };

  /** Create (idempotent), then every photo (idempotent on photoId). Returns 'stop' to end the pass. */
  const processJob = async (mutationId: string, gen: number): Promise<'next' | 'stop'> => {
    const e = requireEnv();
    let job = getJob(mutationId);
    if (!job) return 'next';
    patchJob(mutationId, { state: 'sending' });
    if (!job.serverId) {
      const existing = confirmedRowForJob(job, state.confirmed);
      if (existing) {
        // A6: it was created already (another tab, or a lost response): continue with its photos.
        createdOk(mutationId, existing);
      } else {
        const res = await apiRequest<CreateResponse>(e.fetch, '/api/requests', { method: 'POST', json: job.payload, timeoutMs: OUTBOX_CREATE_TIMEOUT_MS });
        if (gen !== state.generation) return 'stop';
        if (!getJob(mutationId)) return 'next'; // discarded meanwhile
        if (res.ok && isRow(res.data.request)) {
          createdOk(mutationId, res.data.request);
          markLive();
          // Sent later by the worker (the direct path in create() toasts for itself).
          showToast({ tone: 'green', icon: 'check', title: `${formatCaseNumber(res.data.request.caseNumber)} saved`, durationMs: 4_000 });
        } else if (!res.ok && res.kind === 'http' && res.status === 401) {
          patchJob(mutationId, { state: 'pending' });
          sessionExpired();
          return 'stop';
        } else if (!res.ok && isDefinitive(res, CREATE_DEFINITIVE)) {
          jobNeedsAttention(mutationId, res);
          showToast({ tone: 'red', icon: 'alert', title: COPY.needsAttention, action: { label: 'Open', run: () => navigate({ outbox: mutationId }) }, durationMs: 8_000 });
          return 'next';
        } else {
          jobFailed(mutationId, res.ok ? { ok: false, kind: 'network' } : res);
          return 'stop';
        }
      }
      checkpoint(mutationId);
    }
    job = getJob(mutationId);
    if (!job?.serverId) return 'next';
    const serverId = job.serverId;
    for (const photo of job.photos) {
      if (photo.acked) continue;
      const form = new FormData();
      form.set('photoId', photo.photoId);
      form.set('timing', photo.timing);
      form.set('photo', photo.blob, `${photo.photoId}.jpg`);
      form.set('thumb', photo.thumbBlob, `${photo.photoId}_thumb.jpg`);
      const res = await apiRequest<PhotoResponse>(e.fetch, `/api/requests/${encodeURIComponent(serverId)}/photos`, { method: 'POST', form, timeoutMs: PHOTO_TIMEOUT_MS });
      if (gen !== state.generation) return 'stop';
      const current = getJob(mutationId);
      if (!current) return 'next';
      if (res.ok) {
        if (isRow(res.data.request)) commitOwn(res.data.request);
        patchJob(mutationId, { photos: current.photos.map((p) => (p.photoId === photo.photoId ? { ...p, acked: true } : p)) });
        checkpoint(mutationId);
        continue;
      }
      if (res.kind === 'http' && res.status === 401) {
        patchJob(mutationId, { state: 'pending' });
        sessionExpired();
        return 'stop';
      }
      if (isDefinitive(res, PHOTO_DEFINITIVE)) {
        patchJob(mutationId, { photos: current.photos.map((p) => (p.photoId === photo.photoId ? { ...p, acked: true, rejected: true } : p)) });
        checkpoint(mutationId);
        continue;
      }
      jobFailed(mutationId, res);
      if (!photoWarned.has(mutationId)) {
        photoWarned.add(mutationId);
        const lp = current.caseNumber ? formatCaseNumber(current.caseNumber) : null;
        showToast({
          tone: 'amber',
          icon: 'cloud-off',
          title: lp ? `${lp} · photo not sent yet` : 'Photo not sent yet',
          action: { label: 'Retry', run: () => outboxApi.retry(mutationId) },
          durationMs: 8_000,
        });
      }
      return 'stop';
    }
    const done = getJob(mutationId);
    if (!done) return 'next';
    const rejected = done.photos.filter((p) => p.rejected).length;
    if (rejected > 0) {
      const lp = done.caseNumber ? formatCaseNumber(done.caseNumber) : 'Request';
      showToast({ tone: 'amber', icon: 'alert', title: `${lp} · ${rejected === 1 ? 'photo' : `${rejected} photos`} not added`, durationMs: 8_000 });
    }
    photoWarned.delete(mutationId);
    await removeJob(mutationId);
    return 'next';
  };

  const broadcast = (message: { type: 'logout'; generation: number } | { type: 'outbox' } | { type: 'myids' } | { type: 'outbox-idle' }) => {
    try {
      channel?.postMessage(message);
    } catch {
      // closed
    }
  };

  /** Another tab changed the shared outbox: reload it, keeping this tab's in-memory 'sending' marks. */
  const reloadOutbox = async () => {
    if (!kv) return;
    try {
      const jobs = await readJobs(kv);
      const sending = new Set(state.outbox.filter((j) => j.state === 'sending').map((j) => j.mutationId));
      setJobs(jobs.map((j) => (sending.has(j.mutationId) ? { ...j, state: 'sending' } : j)));
      refreshPrompt();
      kickOutbox();
    } catch {
      // keep what we have
    }
  };

  const reloadMyIds = async () => {
    if (!kv) return;
    try {
      const ids = await kv.get<string[]>(K.myIds);
      if (Array.isArray(ids)) set({ myIds: new Set([...state.myIds, ...ids.filter((x) => typeof x === 'string')]) });
    } catch {
      // ignore
    }
  };

  // ---- draft ----
  const writeDraft = async (d: RequestDraft) => {
    const gen = ownerGen();
    await enqueue(async (store) => {
      if (gen !== state.generation) return;
      for (const p of d.photos) {
        if (draftSavedPhotos.has(p.photoId)) continue;
        await writePhotoBlobs(store, p.photoId, p.blob, p.thumbBlob);
        draftSavedPhotos.add(p.photoId);
      }
      await store.set(K.draft, draftToStored(d));
    });
  };

  const draftApi: StoreActions['draft'] = {
    async load() {
      const store = kv;
      if (!store) return null;
      try {
        await kvQueue;
        const d = await readDraft(store);
        if (d) {
          for (const p of d.photos) draftSavedPhotos.add(p.photoId);
          draftHas = hasAnyDetail(d.values, d.photos.length);
        }
        return d;
      } catch {
        return null;
      }
    },
    save(d) {
      draftPending = d;
      draftHas = hasAnyDetail(d.values, d.photos.length);
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = undefined;
      // A20: a new photo is written at once (iOS may reload the page after the camera).
      if (d.photos.some((p) => !draftSavedPhotos.has(p.photoId))) {
        void draftApi.flush();
        return;
      }
      draftTimer = setTimeout(() => {
        draftTimer = undefined;
        void draftApi.flush();
      }, DRAFT_DEBOUNCE_MS);
    },
    async flush() {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = undefined;
      const d = draftPending;
      draftPending = null;
      if (!d || !kv) return;
      await writeDraft(d);
    },
    async clear() {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = undefined;
      draftPending = null;
      draftHas = false;
      await enqueue((store) => store.del(K.draft));
      draftSavedPhotos.clear();
      await gcBlobs();
    },
  };

  // ---- outbox actions ----
  const outboxApi: StoreActions['outbox'] = {
    retry(mutationId) {
      const job = getJob(mutationId);
      if (!job || job.state === 'needs_attention') return;
      patchJob(mutationId, { nextAttemptAt: null });
      checkpoint(mutationId);
      kickOutbox();
    },
    async discard(mutationId) {
      directSends.delete(mutationId);
      await removeJob(mutationId);
    },
    async update(mutationId, payload) {
      const job = getJob(mutationId);
      if (!job) return;
      const next = patchJob(mutationId, { payload: { ...payload, clientMutationId: mutationId } });
      if (next) await persistJob(next, false);
      broadcast({ type: 'outbox' });
    },
    resend(mutationId) {
      const job = getJob(mutationId);
      if (!job) return;
      patchJob(mutationId, { state: 'pending', attempts: 0, nextAttemptAt: null, lastError: null });
      checkpoint(mutationId);
      broadcast({ type: 'outbox' });
      kickOutbox();
    },
    async answerPrompt(send) {
      const ids = [...promptIds];
      const operator = operatorNow();
      for (const id of ids) {
        if (send) {
          approved.add(id);
          const job = patchJob(id, { operator });
          if (job) await persistJob(job, false);
        } else {
          await removeJob(id);
        }
      }
      refreshPrompt();
      broadcast({ type: 'outbox' });
      kickOutbox();
    },
  };

  // ---- create (A13: every create is an outbox job, persisted before it is sent) ----
  const create = async (input: CreateInput): Promise<CreateResult> => {
    const e = requireEnv();
    const gen = ownerGen();
    const mutationId = input.clientMutationId;
    const payload: CreateRequestBody = toCreateBody(input.values, mutationId);
    const already = confirmedRowForJob({ mutationId }, state.confirmed);
    if (already) return { outcome: 'sent', request: already };

    const existing = getJob(mutationId);
    const job: OutboxItem = existing
      ? { ...existing, payload, state: 'pending', attempts: 0, nextAttemptAt: null, lastError: null }
      : {
          mutationId,
          payload,
          photos: input.photos.map((p) => ({ photoId: p.photoId, blob: p.blob, thumbBlob: p.thumbBlob, timing: input.photoTiming, acked: false })),
          serverId: null,
          caseNumber: null,
          state: 'pending',
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
          operator: operatorNow(),
          createdAt: now(),
          source: 'app',
        };

    const durable = await persistJob(job, true);
    if (gen !== state.generation) return { outcome: 'not_saved', message: COPY.notSaved };
    if (!durable) return createWithoutOutbox(job);

    setJobs(existing ? state.outbox.map((j) => (j.mutationId === mutationId ? job : j)) : [...state.outbox, job]);
    broadcast({ type: 'outbox' });
    void draftCleared(mutationId);

    const queued = (): CreateResult => {
      showToast({ tone: 'neutral', icon: 'cloud-off', title: COPY.savedHere, subtitle: COPY.sendsLater, durationMs: 5_000 });
      scheduleOutbox();
      return { outcome: 'queued', mutationId };
    };
    if (!e.online() || state.session.status === 'expired') return queued();

    directSends.add(mutationId);
    let res: HttpResult<CreateResponse>;
    try {
      res = await apiRequest<CreateResponse>(e.fetch, '/api/requests', { method: 'POST', json: payload, timeoutMs: MUTATION_TIMEOUT_MS });
    } finally {
      directSends.delete(mutationId);
    }
    if (gen !== state.generation) return { outcome: 'not_saved', message: COPY.notSaved };
    if (res.ok && isRow(res.data.request)) {
      const request = res.data.request;
      createdOk(mutationId, request);
      markLive();
      checkpoint(mutationId);
      showToast({ tone: 'green', icon: 'check', title: `${formatCaseNumber(request.caseNumber)} saved`, durationMs: 4_000 });
      const left = getJob(mutationId);
      if (left && left.photos.every((p) => p.acked)) await removeJob(mutationId);
      else kickOutbox();
      return { outcome: 'sent', request: state.confirmed.get(request.id) ?? request };
    }
    if (!res.ok && res.kind === 'http' && res.status === 401) {
      sessionExpired();
      return queued();
    }
    if (!res.ok && isDefinitive(res, CREATE_DEFINITIVE)) {
      jobNeedsAttention(mutationId, res);
      return { outcome: 'needs_attention', mutationId, message: res.kind === 'http' ? res.error?.message || COPY.needsAttention : COPY.needsAttention };
    }
    jobFailed(mutationId, res.ok ? { ok: false, kind: 'network' } : res);
    return queued();
  };

  /** IndexedDB is unavailable: send directly, never keep it in memory only. */
  const createWithoutOutbox = async (job: OutboxItem): Promise<CreateResult> => {
    const e = requireEnv();
    if (!e.online()) return { outcome: 'not_saved', message: COPY.notSaved };
    const res = await apiRequest<CreateResponse>(e.fetch, '/api/requests', { method: 'POST', json: job.payload, timeoutMs: MUTATION_TIMEOUT_MS });
    if (!res.ok || !isRow(res.data.request)) {
      if (!res.ok && res.kind === 'http' && res.status === 401) sessionExpired();
      return { outcome: 'not_saved', message: COPY.notSaved };
    }
    const request = res.data.request;
    createdOk(job.mutationId, request);
    showToast({ tone: 'green', icon: 'check', title: `${formatCaseNumber(request.caseNumber)} saved`, durationMs: 4_000 });
    if (job.photos.length) void uploadPhotosDirect(request.id, job);
    return { outcome: 'sent', request };
  };

  const uploadPhotosDirect = async (id: string, job: OutboxItem) => {
    const photos: DraftPhoto[] = job.photos.map((p) => ({ photoId: p.photoId, blob: p.blob, thumbBlob: p.thumbBlob, width: 0, height: 0 }));
    const timing = job.photos[0]?.timing ?? 'today';
    await addPhotos(id, photos, timing);
  };

  /** The draft of a create that is now sent or safely queued is cleared (spec §7 Draft). */
  const draftCleared = async (mutationId: string) => {
    const store = kv;
    if (!store) return;
    const pendingId = draftPending?.clientMutationId;
    const saved = await store.get<StoredDraft>(K.draft).catch(() => undefined);
    if (pendingId === mutationId || saved?.clientMutationId === mutationId) await draftApi.clear();
  };

  const addPhotos = async (id: string, photos: DraftPhoto[], timing: 'today' | 'older'): Promise<{ added: number; failed: number }> => {
    const e = requireEnv();
    if (offlineNow()) {
      refuseOffline();
      return { added: 0, failed: photos.length };
    }
    const gen = ownerGen();
    let added = 0;
    let failed = 0;
    for (const p of photos) {
      const form = new FormData();
      form.set('photoId', p.photoId);
      form.set('timing', timing);
      form.set('photo', p.blob, `${p.photoId}.jpg`);
      form.set('thumb', p.thumbBlob, `${p.photoId}_thumb.jpg`);
      const res = await apiRequest<PhotoResponse>(e.fetch, `/api/requests/${encodeURIComponent(id)}/photos`, { method: 'POST', form, timeoutMs: PHOTO_TIMEOUT_MS });
      if (gen !== state.generation) return { added, failed: photos.length - added };
      if (res.ok) {
        added += 1;
        if (isRow(res.data.request)) commitOwn(res.data.request);
        continue;
      }
      failed += 1;
      if (res.kind === 'http' && res.status === 401) {
        sessionExpired();
        return { added, failed: photos.length - added };
      }
    }
    if (failed > 0) toastFailure(failed === 1 ? "Couldn't add the photo" : `Couldn't add ${failed} photos`);
    return { added, failed };
  };

  // ---- sign out (A14) ----
  const clearLocalData = async (discardOutbox: boolean) => {
    const store = kv;
    set({
      confirmed: new Map(),
      pending: new Map(),
      myIds: new Set(),
      hasData: false,
      lastSyncAt: null,
      toasts: [],
      snackbar: null,
      outboxPrompt: null,
      ...(discardOutbox ? { outbox: [] } : {}),
    });
    for (const t of toastTimers.values()) clearTimeout(t);
    toastTimers.clear();
    clearSnackbar();
    cursor = null;
    cursorAt = 0;
    cacheStaff = null;
    armed = false;
    rowsDirty = false;
    if (rowsTimer) clearTimeout(rowsTimer);
    rowsTimer = undefined;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = undefined;
    draftPending = null;
    draftHas = false;
    if (!store) return;
    // Queued behind every pending write, so nothing older can land after the clear.
    const done = enqueue(async (s) => {
      const all = await s.keys();
      for (const k of all) {
        const isCache = k.startsWith('cache:') || k === K.lastStaff || k === K.myIds || k === K.draft;
        const isOutbox = k.startsWith('outbox:') || k.startsWith('blob:');
        if (isCache || (discardOutbox && isOutbox)) await s.del(k);
      }
    });
    await done;
    draftSavedPhotos.clear();
    if (!discardOutbox) await gcBlobs();
  };

  const haltRuntime = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    pollAbort?.abort();
    if (outboxTimer) clearTimeout(outboxTimer);
    outboxTimer = undefined;
  };

  const onChannelMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; generation?: number } | null;
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'logout':
        if (signingOut) return;
        signingOut = true;
        set({ generation: state.generation + 1, session: { status: 'signed_out', staffName: null, team: null, staff: null, expiresAt: null } });
        haltRuntime();
        void clearLocalData(false).then(() => env?.redirect('/signin'));
        return;
      case 'outbox':
        void reloadOutbox();
        return;
      case 'myids':
        void reloadMyIds();
        return;
      case 'outbox-idle':
        kickOutbox();
        return;
    }
  };

  // ---- actions ----
  const actions: StoreActions = {
    syncNow() {
      triggerSync();
      kickOutbox();
    },

    async setStatus(id, status, kind) {
      if (offlineNow()) return refuseOffline();
      return serialize(id, () => runStatus(id, status, kind, null));
    },

    async undo(snackbarId) {
      const record = undoRecords.get(snackbarId);
      if (!record) return null;
      clearSnackbar();
      if (offlineNow()) return refuseOffline();
      // Never retried automatically (A12); expectedVersion = the version the original mutation returned.
      return serialize(record.id, () => runStatus(record.id, record.to, 'undo', record.version));
    },

    dismissSnackbar: clearSnackbar,

    create,

    async updateFields(id, patch: RequestPatch, baseVersion) {
      if (offlineNow()) return refuseOffline();
      return serialize(id, async () => {
        const gen = ownerGen();
        const row = state.confirmed.get(id);
        if (!row) return fail('not_found', COPY.notFound);
        setOverlay(id, { mutationId: uuid(), kind: 'fields', fields: overlayForPatch(row, patch), startedAt: now() });
        const res = await apiRequest<ChangeResponse>(requireEnv().fetch, `/api/requests/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          json: { patch, expectedVersion: baseVersion },
          timeoutMs: MUTATION_TIMEOUT_MS,
        });
        if (gen !== state.generation) return fail('failed', COPY.failed);
        if (res.ok && isRow(res.data.request)) {
          commitOwn(res.data.request, id);
          markLive();
          return { ok: true, changed: !!res.data.changed, request: state.confirmed.get(id) ?? res.data.request };
        }
        // A10: the form shows the conflict review itself (latest data, the user's edits kept).
        return mutationFailed(id, res.ok ? { ok: false, kind: 'network' } : res, { conflictToast: false });
      });
    },

    async cancel(id) {
      if (offlineNow()) return refuseOffline();
      return serialize(id, async () => {
        const gen = ownerGen();
        const row = state.confirmed.get(id);
        if (!row) return fail('not_found', COPY.notFound);
        if (row.status === STATUS.cancelled) return { ok: true, changed: false, request: row };
        setOverlay(id, { mutationId: uuid(), kind: 'cancel', fields: { status: STATUS.cancelled }, startedAt: now() });
        const res = await apiRequest<ChangeResponse>(requireEnv().fetch, `/api/requests/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          json: { expectedVersion: row.rowVersion },
          timeoutMs: MUTATION_TIMEOUT_MS,
        });
        if (gen !== state.generation) return fail('failed', COPY.failed);
        if (res.ok && isRow(res.data.request)) {
          commitOwn(res.data.request, id);
          markLive();
          return { ok: true, changed: !!res.data.changed, request: state.confirmed.get(id) ?? res.data.request };
        }
        return mutationFailed(id, res.ok ? { ok: false, kind: 'network' } : res, { conflictToast: true });
      });
    },

    addPhotos,

    async preparePhoto(file) {
      const { compressPhoto } = await import('./image');
      return compressPhoto(file);
    },

    async fetchDetail(id): Promise<RequestDetail> {
      const e = requireEnv();
      if (!isUuid(id)) throw new FetchError('not_found');
      const gen = ownerGen();
      const res = await apiRequest<RequestDetail>(e.fetch, `/api/requests/${encodeURIComponent(id)}`, { timeoutMs: SYNC.requestTimeoutMs });
      if (gen !== state.generation) throw new FetchError('failed');
      if (res.ok) {
        const detail = res.data;
        if (!isRow(detail) || !Array.isArray(detail.photos) || !Array.isArray(detail.audit)) throw new FetchError('failed');
        ingest([summaryOf(detail)]);
        markLive();
        return detail;
      }
      if (res.kind === 'http') {
        if (res.status === 401) {
          sessionExpired();
          throw new FetchError('unauthorized');
        }
        if (res.status === 404) throw new FetchError('not_found');
        if (res.status === 403) throw new FetchError('forbidden');
      }
      throw new FetchError(res.kind === 'http' ? 'failed' : e.online() ? 'failed' : 'offline');
    },

    async fetchStats(): Promise<Stats> {
      const e = requireEnv();
      const gen = ownerGen();
      const res = await apiRequest<Stats>(e.fetch, '/api/stats', { timeoutMs: SYNC.requestTimeoutMs });
      if (gen !== state.generation) throw new FetchError('failed');
      if (res.ok) {
        markLive();
        return res.data;
      }
      if (res.kind === 'http' && res.status === 401) {
        sessionExpired();
        throw new FetchError('unauthorized');
      }
      throw new FetchError(res.kind === 'http' ? 'failed' : 'offline');
    },

    outbox: outboxApi,
    draft: draftApi,

    async signOut(opts) {
      const unsent = state.outbox.length;
      if (unsent > 0 && !opts?.discardOutbox) return { ok: false, reason: 'outbox', count: unsent };
      const e = requireEnv();
      signingOut = true;
      set({ generation: state.generation + 1 });
      haltRuntime();
      broadcast({ type: 'logout', generation: state.generation });
      await apiRequest(e.fetch, '/api/session', { method: 'DELETE', timeoutMs: SIGN_OUT_TIMEOUT_MS });
      await clearLocalData(true);
      set({ session: { status: 'signed_out', staffName: null, team: null, staff: null, expiresAt: null } });
      e.redirect('/signin');
      return { ok: true };
    },

    setPref(key, value) {
      writePref(key, value);
      set({ prefs: { ...state.prefs, [key]: value } });
    },

    showToast,
    dismissToast,

    subscribeAlerts(listener) {
      alertListeners.add(listener);
      return () => {
        alertListeners.delete(listener);
      };
    },

    async applyUpdate() {
      if (state.outbox.length > 0 || draftHas) {
        showToast({ tone: 'amber', icon: 'info', title: state.outbox.length > 0 ? COPY.waitOutbox : COPY.finishDraft, durationMs: 5_000 });
        showUpdateToast();
        return false;
      }
      return sw?.activateWaiting() ?? false;
    },

    async prepareOffline() {
      return (await sw?.precache()) ?? false;
    },
  };

  const showUpdateToast = () => {
    if (updateToastId && state.toasts.some((t) => t.id === updateToastId)) return;
    updateToastId = showToast({ tone: 'blue', icon: 'refresh', title: COPY.updateReady, action: { label: 'Reload', run: () => void actions.applyUpdate() }, durationMs: null });
  };

  // ---- start / stop ----
  const boot = async (id: number) => {
    const e = requireEnv();
    kv ??= e.openKv();
    let durable = false;
    if (kv) {
      try {
        await kv.get(K.lastStaff);
        durable = true;
      } catch {
        kv = null;
      }
    }
    if (!isLive(id)) return;
    if (durable && kv) {
      try {
        const [last, ids, jobs] = await Promise.all([kv.get<StoredStaff>(K.lastStaff), kv.get<string[]>(K.myIds), readJobs(kv)]);
        if (!isLive(id)) return;
        if (last && typeof last.staff === 'string' && cacheStaff === null) await loadCache(canonStaff(last.staff) ?? '');
        const myIds = new Set([...state.myIds, ...(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [])]);
        const known = new Set(state.outbox.map((j) => j.mutationId));
        setJobs([...state.outbox, ...jobs.filter((j) => !known.has(j.mutationId))]);
        set({ myIds });
        const saved = await kv.get<StoredDraft>(K.draft);
        if (saved?.values && !draftPending) draftHas = hasAnyDetail(saved.values, saved.photos?.length ?? 0);
      } catch {
        // An unreadable store behaves as empty.
      }
    }
    if (!isLive(id)) return;
    set({ hydrated: true, durableStorage: durable });
    if (durable) await importLegacyQueue();
    if (!isLive(id)) return;
    schedulePoll(0);
    kickOutbox();
  };

  const importLegacyQueue = async () => {
    const ls = env?.localStorage();
    if (!ls || !kv) return;
    let raw: string | null;
    try {
      raw = ls.getItem(LEGACY_QUEUE_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    let items: unknown;
    try {
      items = JSON.parse(raw);
    } catch {
      return; // Unreadable: leave it untouched rather than lose anything.
    }
    if (!Array.isArray(items)) return;
    const base = now();
    let index = 0;
    for (const item of items) {
      let body = createBodyFromLegacyQueueItem(item);
      if (!body && item && typeof item === 'object' && !Array.isArray(item)) {
        body = createBodyFromLegacyQueueItem({ ...(item as Record<string, unknown>), client_mutation_id: uuid() });
      }
      if (!body) continue;
      if (getJob(body.clientMutationId)) continue;
      const job: OutboxItem = {
        mutationId: body.clientMutationId,
        payload: body,
        photos: [],
        serverId: null,
        caseNumber: null,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        // Jeffrey's queue never recorded who saved an item: no operator prompt for these.
        operator: { staffName: '', team: '', staff: '' },
        createdAt: base + index,
        source: 'legacy',
      };
      index += 1;
      if (!(await persistJob(job, false))) return; // keep the key: nothing is lost
      setJobs([...state.outbox, job]);
    }
    try {
      ls.removeItem(LEGACY_QUEUE_KEY);
    } catch {
      // best effort
    }
    broadcast({ type: 'outbox' });
  };

  const start = (): (() => void) => {
    if (running) return stop;
    const e = requireEnv();
    running = true;
    runId += 1;
    const id = runId;
    if (signingOut) return stop;
    if (!e.online()) setConnection('offline');
    offs.push(
      e.on('window', 'online', () => {
        netFailures = 0;
        triggerSync();
        kickOutbox();
      }),
      e.on('window', 'offline', () => setConnection('offline')),
      e.on('window', 'focus', triggerSync),
      e.on('window', 'pageshow', triggerSync),
      e.on('document', 'visibilitychange', () => {
        if (e.visible()) triggerSync();
      }),
      e.on('window', 'pagehide', () => {
        void draftApi.flush();
        void flushRows();
      }),
      subscribePrefs((prefs) => set({ prefs })),
    );
    channel = e.channel('lp');
    channel?.addEventListener('message', onChannelMessage);
    sw = e.serviceWorker({
      onUpdateReady: () => {
        if (!state.updateReady) set({ updateReady: true });
        showUpdateToast();
      },
      onOfflineReady: () => {
        if (!state.offlineReady) set({ offlineReady: true });
      },
    });
    void boot(id);
    return stop;
  };

  const stop = () => {
    if (!running) return;
    running = false;
    haltRuntime();
    for (const off of offs.splice(0)) off();
    channel?.removeEventListener('message', onChannelMessage);
    channel?.close();
    channel = null;
    sw?.stop();
    sw = null;
    pollInFlight = false;
    if (state.syncing) set({ syncing: false });
    void draftApi.flush();
    void flushRows();
  };

  return {
    getState: () => state,
    getServerState: () => serverState,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
    start,
  };
}

const syncPathFor = (since: string | null, reconcile: boolean, after: SyncResponse['next']) => syncPath({ since, reconcile, after });
const syncPathIds = (ids: readonly string[]) => syncPath({ ids });

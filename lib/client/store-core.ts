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
  EventStats,
  OutboxItem,
  PhotoResponse,
  RequestDetail,
  RequestPatch,
  RequestSummary,
  SessionInfo,
  Stats,
  StatsRange,
  SyncResponse,
} from '../api-types';
import { legacyStats, serverRange } from './stats-shim';
import {
  NOT_FOUND_YET_LABEL,
  RECHECK_MINUTES,
  SETTABLE_STATUSES,
  STATUS,
  STATUS_META,
  alertName,
  canonStaff,
  isHeld,
  isUuid,
  notFoundHolds,
  sameStaff,
  statusMeta,
  staffString,
  undoTarget,
  type SettableStatus,
  type StatusKind,
} from '../domain';
import { formatCaseNumber } from '../format';
import { syncPath } from './api-paths';
import { isSwapRequested, sameSwap, swapOverlayFields, swapToastTitle } from './swap';
import {
  alertKey,
  alertStillCurrent,
  alertToast,
  coalesceAlerts,
  diffRaisedAlerts,
  latestPerRequest,
  type AlertContext,
  type RaisedAlert,
} from './alerts';
import { CONNECTION_FAILURES, DRAFT_DEBOUNCE_MS, LEGACY_QUEUE_KEY, MUTATION_TIMEOUT_MS, SYNC, UNDO_MS } from './constants';
import { createBodyFromLegacyQueueItem, hasAnyDetail, toCreateBody } from './form-values';
import { apiRequest, isDefinitive, isUncertain, type FetchLike, type HttpFailure, type HttpResult, type RequestOptions } from './http';
import { diffMessageAlerts } from './messages-activity';
import { createLazyMessaging, type CreateMessaging } from './messages-lazy';
import { navigate, signInNext } from './nav';
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
  photoBlobsEntry,
  readDraft,
  readJobs,
  readRows,
  type Kv,
  type StoredCursor,
  type StoredDraft,
  type StoredStaff,
} from './persist';
import { forgetBell, readPrefs, subscribePrefs, writePref } from './prefs';
import { dropBrowserPush, provideApi, publishSyncExtras, pushHooks } from './f4-bridge';
import { SESSION_CHANNEL, clearLogoutPending, readLogoutPending, writeLogoutPending, type LogoutPending } from './session-signals';
import { startServiceWorker, type SwController } from './sw-client';
import type { AlertNotifier, AlertPlan } from './system-notify';
import {
  createServerState,
  type AlertEvent,
  type AppStore,
  type Connection,
  type CreateInput,
  type CreateResult,
  type DraftPhoto,
  type MutationFailure,
  type MutationOptions,
  type MutationResult,
  type Overlay,
  type RequestDraft,
  type StoreActions,
  type StoreState,
  type ToastItem,
} from './store-contract';
import { chunk, isRow, mergeRows, overlayForPatch, replaceAll, sameRow, staleIds, summaryOf } from './sync-merge';
import type { HoldFields, HoldRules } from './hold-rules';
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
  /** Full navigation that replaces the history entry (sign-in after a 401 or a sign-out). */
  redirect(url: string): void;
  /** pathname + search of the current page. */
  location(): string;
  serviceWorker(hooks: { onUpdateReady(): void; onOfflineReady(): void }): SwController | null;
  /**
   * System notifications for alerts while the app is in the background (v2.5 A52). Absent or null: every
   * alert is a toast (tests, unsupported browsers).
   */
  notifier?(): AlertNotifier | null;
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
    // replace: Back from sign-in must not return to an app page that only bounces to sign-in again.
    redirect: (url) => window.location.replace(url),
    location: () => `${window.location.pathname}${window.location.search}`,
    serviceWorker: (hooks) => startServiceWorker(hooks),
    notifier: () => lazyNotifier(),
  };
}

/** After a failed import of system-notify (a dropped chunk on a festival network), it is tried again in these ms. */
const NOTIFY_RETRY_MS: readonly number[] = [5_000, 20_000, 60_000];

/**
 * System notifications (v2.5 A52), loaded with import() so they cost nothing on the first load (A25).
 * Until the module is in, every alert is a toast, as on a device without them. A failed load is tried
 * again a few times (`retryMs`): the same module answers notification taps the page missed.
 */
export function lazyNotifier(
  load: () => Promise<{ startNotify(): AlertNotifier }> = () => import('./system-notify'),
  retryMs: readonly number[] = NOTIFY_RETRY_MS,
): AlertNotifier {
  let real: AlertNotifier | null = null;
  let active = false;
  const attempt = (tries: number) => {
    load().then(
      (m) => {
        real = m.startNotify();
        if (active) real.setActive(true);
      },
      () => {
        const wait = retryMs[tries];
        if (wait !== undefined) setTimeout(() => attempt(tries + 1), wait);
      },
    );
  };
  attempt(0);
  return {
    plan: (keys) => real?.plan(keys) ?? TOAST_PLAN,
    show: (alert, rowOf, sources) => real?.show(alert, rowOf, sources) ?? Promise.resolve(false),
    close: (requestId, key) => real?.close(requestId, key),
    closeAll: () => real?.closeAll(),
    setActive: (on) => {
      active = on;
      real?.setActive(on);
    },
  };
}

/** Every alert a toast (no notifier, or system-notify not loaded yet). Kept here: a type import costs nothing on the first load. */
const TOAST_PLAN: AlertPlan = { route: 'toast', skip: new Set<string>() };

/**
 * (F5) The "Not found yet" hold on the client (lib/client/hold-rules.ts: what a status tap shows before the server
 * answers, the Undo bar's words, the 409 resend check) is stage-only code, loaded with import() so the first load
 * (A25) does not carry it, and bound here to the same domain values as lib/client/hold.ts (which the store must not
 * import: it would bring the rules back into the first load). The store starts loading it when it starts; a status
 * tap waits for it (it is in long before). A failed load is forgotten, so the next tap tries again.
 */
let holdModule: Promise<HoldRules> | null = null;
function loadHold(): Promise<HoldRules> {
  holdModule ??= import('./hold-rules').then(
    (m) => m.holdRules({ STATUS, STATUS_META, NOT_FOUND_YET_LABEL, RECHECK_MINUTES, alertName, isHeld, notFoundHolds, formatCaseNumber }),
    (error: unknown) => {
      holdModule = null;
      throw error;
    },
  );
  return holdModule;
}

export interface CreateAppStoreOptions {
  eventTimezone: string;
  /** Tests inject a fake environment; the browser one is used otherwise. */
  env?: () => StoreEnv;
  /** (F3) Loads the messages engine; a dynamic import by default (tests pass it in directly). */
  loadMessaging?: () => Promise<CreateMessaging>;
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
  /** Undo after this phone already changed the request again (never "someone else"). */
  undoStale: "Can't undo — it changed since",
  /** The server did not confirm the sign-out: the session is still on (never claimed as signed out). */
  signOutFailed: "Couldn't sign out — check signal and try again",
  /** A write found the tab's staff was out of date (another tab signed in as someone else): not sent. */
  sessionChanged: 'Session changed — try again',
} as const;

const UNDOABLE_KINDS: ReadonlySet<StatusKind> = new Set(['answer', 'change', 'reunite', 'inform']);
const MAX_TOASTS = 3;
const MAX_SYNC_PAGES = 40;
const ROWS_WRITE_MS = 3_000;
const OUTBOX_CREATE_TIMEOUT_MS = 15_000;
const PHOTO_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 15_000;
const LOCK_STEAL_AFTER = 8;
const LEASE_KEY = 'lp-outbox-lease';
const LEASE_MS = 30_000;
const REDIRECT_GUARD_KEY = 'lp-401-at';
const REDIRECT_GUARD_MS = 20_000;
const SIGN_OUT_TIMEOUT_MS = 5_000;
/** Waits before the 2nd and 3rd DELETE /api/session attempt. */
const SIGN_OUT_RETRY_MS = [1_000, 2_000] as const;
/**
 * Queued jobs go out under whoever the cookie belongs to now. A tab frozen for hours may run its overdue
 * outbox timer before it hears visibilitychange, so a pass first re-confirms a session older than this.
 */
const SESSION_FRESH_MS = 60_000;
/**
 * How long this tab sends nothing after another tab said it is signing out (its 'signout-pending'), unless
 * it hears how that ended first. Longer than a whole sign-out (3 rounds of DELETE + GET, 5 s each, and the
 * waits between them), so only a tab that died mid sign-out lets it run out.
 */
const PEER_SIGN_OUT_HOLD_MS = 45_000;
/**
 * (F6 follow-up) A second Not found within this long of the first one's hold showing is the other half of a
 * double tap (the platforms' double-tap window is 300–500 ms); later, the medic tapped the "× Not located" on screen.
 */
const DOUBLE_TAP_MS = 500;

type PollOutcome = 'ok' | 'network' | 'http5xx' | 'http4xx' | 'unauthorized' | 'offline' | 'stale';
type SignOutResult = Awaited<ReturnType<StoreActions['signOut']>>;

interface UndoRecord {
  id: string;
  to: SettableStatus;
  version: number;
  /** (Pending v9.1) The hold fields before the undone change: lp_set_status's Undo puts them back. */
  restore: HoldFields;
}

/** What an alert toast on screen is about (one per request; see alerts.ts alertStillCurrent). */
interface AlertToastMeta {
  requestId: string;
  kind: AlertEvent['kind'];
  /** The row's status when the alert was raised. */
  status: string | null;
  /** (F5) Whether the row was on a "Not found yet" hold then (undefined: not tracked, e.g. combined). */
  held?: boolean;
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
  /** (Companion) The "Friend swap requested" Undo on screen: it closes once the row is no longer swap-requested. */
  let swapRequestUndo: { snackId: string; id: string } | null = null;
  const set = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    if (swapRequestUndo) {
      if (state.snackbar?.id !== swapRequestUndo.snackId) swapRequestUndo = null;
      else if (patch.confirmed) {
        const r = state.confirmed.get(swapRequestUndo.id);
        if (!r || !isSwapRequested(r)) {
          customUndos.delete(swapRequestUndo.snackId);
          if (snackTimer) clearTimeout(snackTimer);
          snackTimer = undefined;
          swapRequestUndo = null;
          state = { ...state, snackbar: null };
        }
      }
    }
    emit();
  };

  // ---- runtime (everything below is only touched after start()) ----
  let env: StoreEnv | null = null;
  let running = false;
  let runId = 0;
  const offs: Array<() => void> = [];
  let channel: ChannelLike | null = null;
  let sw: SwController | null = null;
  let notifier: AlertNotifier | null = null;
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
  /** Armed (past the baseline sync) and alerting: the notifier may then claim the front for this tab. */
  const setArmed = (on: boolean) => {
    if (armed === on) return;
    armed = on;
    notifier?.setActive(on);
  };
  /**
   * Alerts of synced rows that are applied but not shown yet. A sync shows them when it ends, whether it
   * succeeded or a later request of it failed, and they survive a stop: an applied row never re-alerts
   * (its version is no longer newer), so dropping them would lose the alert for good.
   */
  let alertBacklog: RaisedAlert[] = [];
  const seen = new Set<string>();
  const ownKeys = new Set<string>();
  /** Rows a mutation answered while a full fetch was loading (kept by replaceAll). */
  const touchedDuringPoll = new Set<string>();
  let rowsTimer: ReturnType<typeof setTimeout> | undefined;
  let rowsDirty = false;
  /** The first rows of a session are written at once (an offline reload right after load needs them). */
  let rowsWrittenOnce = false;

  // mutations
  const chains = new Map<string, Promise<unknown>>();
  const undoRecords = new Map<string, UndoRecord>();
  let snackTimer: ReturnType<typeof setTimeout> | undefined;
  /** holdUndo() calls not released yet: while any is held, the Undo on screen doesn't run out. */
  let undoHolds = 0;
  const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Alert toasts on screen, by toast id. */
  const alertToasts = new Map<string, AlertToastMeta>();
  /**
   * Status alerts shown as system notifications (v2.5 A52), by request id: closed like their toasts once
   * the row is in another status. `key` is the (id, rowVersion) the notification carries, so closing an
   * old one never closes a newer notification of the same request.
   */
  const systemAlerts = new Map<string, AlertToastMeta & { key: string | null }>();
  /**
   * The page's last hidden spell, in server time (estimated from the last sync); `until` is null while it is
   * still hidden. Web Push showed a change made then on the lock screen: an iPhone suspends a hidden web app,
   * so the sync back in front is the first to see it, and must not toast it again (never both).
   */
  let hiddenSpell: { from: number; until: number | null } | null = null;

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
  /**
   * A sign-out is pending: the server has not confirmed the cookie is cleared yet. Nothing syncs, sends
   * or restores the session meanwhile (the localStorage marker carries this across a reload).
   */
  let signingOut = false;
  let signOutRun: Promise<SignOutResult> | null = null;
  let sessionEndedToastId: string | null = null;

  // session re-check (resume, pageshow, a sign-in in another tab)
  /** GET /api/session must confirm who is signed in before this tab syncs on, writes or sends jobs. */
  let sessionCheckDue = false;
  /** Bumped by every reason to re-check; a check only clears sessionCheckDue for the reasons it saw. */
  let sessionCheckSeq = 0;
  let sessionCheck: Promise<PollOutcome> | null = null;
  /** Local time the check in flight was sent. */
  let sessionCheckSentAt = 0;
  /** Local time of the last GET /api/session that confirmed the session. */
  let sessionCheckedAt = 0;
  /** When the scheduled poll is due: a timer that fires far later means the tab was frozen meanwhile. */
  let pollDueAt = 0;
  /** Bumped whenever the data starts belonging to another staff; a sync begun before that is dropped. */
  let staffEpoch = 0;

  // sign-out, as far as the network is concerned
  /** This tab's API requests on their way (see call()). */
  const inflight = new Set<AbortController>();
  /**
   * Another tab is signing out: until it says how that ended (or PEER_SIGN_OUT_HOLD_MS ran out) this tab
   * sends nothing either. Any answer could carry a re-issued cookie after the server cleared it.
   */
  let peerSignOutUntil = 0;
  let peerHoldTimer: ReturnType<typeof setTimeout> | undefined;
  /** A sign-out that was pending when this page loaded (the localStorage marker): boot finishes it. */
  let resumeSignOut: LogoutPending | null = null;

  const now = () => Date.now();
  /** The server's clock now, from the last sync's serverTime (this device's clock before the first sync). */
  const serverNow = () => {
    const at = state.lastSyncAt ? Date.parse(state.lastSyncAt) : Number.NaN;
    return Number.isFinite(at) && typeof state.lastSyncLocalAt === 'number' ? at + (now() - state.lastSyncLocalAt) : now();
  };
  const markHidden = (hidden: boolean) => {
    if (hidden) hiddenSpell = { from: serverNow(), until: null };
    else if (hiddenSpell && hiddenSpell.until === null) hiddenSpell.until = serverNow();
  };
  /** A change at `at` (server time) happened while the page was hidden, and this device's push carried it. */
  const pushedWhileHidden = (kind: AlertEvent['kind'], at: string | null | undefined) => {
    const t = at ? Date.parse(at) : Number.NaN;
    if (!hiddenSpell || !Number.isFinite(t) || t < hiddenSpell.from) return false;
    if (hiddenSpell.until !== null && t > hiddenSpell.until) return false;
    return pushHooks()?.covers(kind) === true;
  };
  const isLive = (id: number) => running && runId === id;
  const ownerGen = () => state.generation;
  const peerSigningOut = () => peerSignOutUntil > now();
  /** A sign-out is pending, in this tab or another: nothing goes to the API meanwhile. */
  const networkHeld = () => signingOut || peerSigningOut();

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
    alertToasts.delete(id);
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
    alertToasts.delete(id);
  };

  const toastFailure = (title: string, tone: ToastItem['tone'] = 'red') =>
    showToast({ tone, icon: tone === 'amber' ? 'alert' : 'cloud-off', title, durationMs: 6_000 });

  const clearSnackbar = () => {
    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = undefined;
    undoRecords.clear();
    customUndos.clear();
    if (state.snackbar) set({ snackbar: null });
  };

  /** (F3) The Undo bar for something that is not a status (en route cancelled · Undo). */
  const customUndos = new Map<string, () => void>();
  const showCustomUndo = (message: string, ms: number, onUndo: () => void) => {
    clearSnackbar();
    const snackId = uuid();
    customUndos.set(snackId, onUndo);
    set({ snackbar: { id: snackId, message, expiresAt: now() + ms } });
    snackTimer = setTimeout(() => {
      snackTimer = undefined;
      customUndos.delete(snackId);
      if (state.snackbar?.id === snackId) set({ snackbar: null });
    }, ms);
  };

  /**
   * This phone set request `id`'s medical location (version `from` → `to`): the status Undo on screen for
   * it is still right (a location is not a status), so it moves to the new version instead of going.
   */
  const carryUndoFor = (id: string, from: number, to: number) => {
    for (const record of undoRecords.values()) if (record.id === id && record.version === from) record.version = to;
  };

  /**
   * This phone changed request `id` again (an edit, cancel, photo, another answer): an Undo offered for an
   * earlier version of it would only 409, so it goes. An unchanged repeat (same version) keeps it.
   */
  const dropUndoFor = (id: string, version: number) => {
    for (const [snackId, record] of undoRecords) {
      if (record.id !== id || record.version === version) continue;
      undoRecords.delete(snackId);
      if (state.snackbar?.id === snackId) {
        if (snackTimer) clearTimeout(snackTimer);
        snackTimer = undefined;
        set({ snackbar: null });
      }
    }
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

  // ---- API ----
  /**
   * Every API request of the store goes through here, except the sign-out's own. The server re-issues the
   * cookie on an authenticated answer (sliding session), so an answer that lands after a sign-out cleared
   * the cookie would bring it back: a sign-out aborts every request still on its way before it asks the
   * server (an aborted request's answer is never stored), and none starts while a sign-out is pending.
   */
  const call = <T>(path: string, opts: RequestOptions): Promise<HttpResult<T>> => {
    const e = requireEnv();
    if (networkHeld()) return Promise.resolve<HttpResult<T>>({ ok: false, kind: 'network' });
    const controller = new AbortController();
    const outer = opts.signal;
    const onOuter = () => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener('abort', onOuter, { once: true });
    inflight.add(controller);
    return apiRequest<T>(e.fetch, path, { ...opts, signal: controller.signal }).finally(() => {
      inflight.delete(controller);
      outer?.removeEventListener('abort', onOuter);
    });
  };

  const abortInflight = () => {
    for (const controller of [...inflight]) controller.abort();
    inflight.clear();
  };

  // ---- rows ----
  const alertCtx = (): AlertContext => ({
    sessionStaff: state.session.staff,
    myIds: state.myIds,
    ownMutationIds: new Set(state.outbox.map((j) => j.mutationId)),
    ownKeys,
    bell: state.prefs.bell,
    seen,
    timeZone: state.eventTimezone,
  });

  /** Closes the alert toasts of one request (a newer alert for it replaces them). */
  const dismissAlertToastsFor = (requestId: string) => {
    for (const [toastId, meta] of [...alertToasts]) if (meta.requestId === requestId) dismissToast(toastId);
  };

  /** Closes the system notification of one request's status alert. */
  const closeSystemAlert = (requestId: string) => {
    const meta = systemAlerts.get(requestId);
    if (!meta) return;
    systemAlerts.delete(requestId);
    notifier?.close(requestId, meta.key);
  };

  /** Every system notification of this app goes (sign-out, another staff): they name the previous staff's requests. */
  const closeSystemAlerts = () => {
    systemAlerts.clear();
    notifier?.closeAll();
  };

  /**
   * Closes every alert toast (and status notification) that no longer matches its request's synced status:
   * "is in medical" after the answer was changed or undone (by anyone, this phone included) must never stay
   * on screen.
   */
  const pruneAlertToasts = () => {
    for (const [toastId, meta] of [...alertToasts]) {
      if (!state.toasts.some((t) => t.id === toastId)) {
        alertToasts.delete(toastId);
        continue;
      }
      if (!alertStillCurrent(meta.kind, meta.status, state.confirmed.get(meta.requestId), meta.held)) dismissToast(toastId);
    }
    for (const [requestId, meta] of [...systemAlerts]) {
      if (!alertStillCurrent(meta.kind, meta.status, state.confirmed.get(requestId), meta.held)) closeSystemAlert(requestId);
    }
  };

  /** The in-app alert: its toast, and the listeners' chime and vibration. */
  const showAlertToast = (alert: AlertEvent, status: string | null, held?: boolean) => {
    // (R2) A message's View lands at the request's thread (thread-jump loads with the views, off the first load).
    const view = (id: string) =>
      alert.kind === 'message'
        ? void import('./thread-jump').then(
            (m) => m.openThread(id),
            () => navigate({ r: id }),
          )
        : navigate({ r: id });
    const toastId = showToast(alertToast(alert, view));
    if (alert.requestId) alertToasts.set(toastId, { requestId: alert.requestId, kind: alert.kind, status, held });
    for (const l of [...alertListeners]) {
      try {
        l(alert);
      } catch {
        // A host's failure never stops the others.
      }
    }
  };

  /**
   * The app is in the background (v2.5 A52): the alert is a system notification instead of the toast,
   * never both. If it can't be shown after all (permission withdrawn), the toast carries it.
   */
  const showSystemAlert = (n: AlertNotifier, alert: AlertEvent, status: string | null, held: boolean | undefined, sources: readonly AlertEvent[]) => {
    // The rows as they are now: the notifier builds the notification from them before it awaits anything.
    const rows = state.confirmed;
    const row = alert.requestId ? rows.get(alert.requestId) : undefined;
    // The (id, rowVersion) the notification carries (systemNotice), so only this change is ever closed.
    const key = row ? alertKey(row) : null;
    const tracked = alert.requestId && alert.kind !== 'new_request' ? alert.requestId : null;
    if (tracked) systemAlerts.set(tracked, { requestId: tracked, kind: alert.kind, status, held, key });
    const gen = state.generation;
    void n.show(alert, (id) => rows.get(id), sources).then((shown) => {
      if (shown || !running || gen !== state.generation) return;
      if (tracked && systemAlerts.get(tracked)?.key === key) systemAlerts.delete(tracked);
      if (alert.requestId && !alertStillCurrent(alert.kind, status, state.confirmed.get(alert.requestId), held)) return;
      showAlertToast(alert, status, held);
    });
  };

  const emitAlerts = (raised: readonly RaisedAlert[]) => {
    // One alert per request (the latest change wins), and only alerts still true for the synced row.
    const current = latestPerRequest(raised).filter((r) =>
      r.alert.requestId ? alertStillCurrent(r.alert.kind, r.status, state.confirmed.get(r.alert.requestId), r.held) : true,
    );
    // Decided once per batch: a system notification while the app is in the background, else the toast;
    // nothing while another app tab of this browser is in front (it toasts these alerts from its own sync),
    // and nothing for an alert another tab already delivered (v2.5 A52: never both, across tabs too).
    const n = notifier;
    const plan = n?.plan(current.map((r) => r.key)) ?? TOAST_PLAN;
    const route = plan.route;
    // Only a current alert replaces the toast of its request. A dropped one (the row changed again since,
    // and that change may have its own toast up already) closes nothing: pruneAlertToasts below still
    // closes any toast that no longer matches its row. A new notification replaces the old one by its tag;
    // an alert not shown as one here closes it.
    for (const r of current) {
      if (!r.alert.requestId) continue;
      dismissAlertToastsFor(r.alert.requestId);
      if (route !== 'system') closeSystemAlert(r.alert.requestId);
    }
    // Combined ("3 new requests") only counts what this tab shows. A device with Web Push (F4) leaves the
    // system notification to the push, and a change made while the page was hidden too (the push showed it
    // then): never both (lib/client/f4-bridge.ts).
    const pushed = (r: RaisedAlert) => (route === 'system' ? pushHooks()?.covers(r.alert.kind) === true : pushedWhileHidden(r.alert.kind, r.at));
    const shown = route === 'none' ? [] : current.filter((r) => !plan.skip.has(r.key) && !pushed(r));
    const raisedBy = new Map(shown.map((r) => [r.alert, r]));
    const sources = shown.map((r) => r.alert);
    for (const alert of coalesceAlerts(sources)) {
      const status = raisedBy.get(alert)?.status ?? null;
      const held = raisedBy.get(alert)?.held;
      if (route === 'system' && n) showSystemAlert(n, alert, status, held, alert.kind === 'combined' ? sources : [alert]);
      else showAlertToast(alert, status, held);
    }
    pruneAlertToasts();
  };

  /**
   * Rows from the server that may be someone else's changes: alert (once armed), then merge. `defer`: the
   * sync loop shows the alerts together when the sync ends (alertBacklog), so a burst coalesces.
   */
  const ingest = (rows: readonly RequestSummary[], defer = false) => {
    const valid = rows.filter(isRow);
    if (valid.length === 0) return;
    const alerts = armed ? diffRaisedAlerts(state.confirmed, valid, alertCtx()) : [];
    const messageAlerts = armed ? diffMessageAlerts(state.confirmed, valid, seen, (id) => messaging.isOpen(id)) : [];
    if (defer) alertBacklog.push(...alerts);
    const merged = mergeRows(state.confirmed, valid);
    if (merged) {
      set({ confirmed: merged, hasData: true });
      markRowsDirty();
    }
    if (!defer && alerts.length) emitAlerts(alerts);
    else if (merged) pruneAlertToasts();
    emitMessageAlerts(messageAlerts);
  };

  /**
   * F3: a new message from someone else on a request I'm involved in. Toast + chime while the app is in
   * front, through the same delivery plan as the other alerts (one tab of this browser shows it); in the
   * background nothing here (F4's Web Push carries it), nor for a message sent while the page was hidden on a
   * device whose push showed it. Never for a thread on screen.
   */
  const emitMessageAlerts = (raised: ReturnType<typeof diffMessageAlerts>) => {
    if (raised.length === 0 || !env?.visible()) return;
    const plan = notifier?.plan(raised.map((r) => r.key)) ?? TOAST_PLAN;
    if (plan.route !== 'toast') return;
    for (const r of raised) {
      if (plan.skip.has(r.key) || pushedWhileHidden('message', r.at)) continue;
      showAlertToast(r.alert, null);
    }
  };

  /** Shows the alerts of every row a sync applied (also after a later request of that sync failed). */
  const deliverAlerts = () => {
    if (alertBacklog.length === 0) {
      if (armed) pruneAlertToasts();
      return;
    }
    const raised = alertBacklog;
    alertBacklog = [];
    emitAlerts(raised);
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
    if (row && isRow(row)) {
      const stored = state.confirmed.get(row.id);
      dropUndoFor(row.id, stored?.rowVersion ?? row.rowVersion);
      if (patch.confirmed) pruneAlertToasts();
    }
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
    rowsTimer = setTimeout(
      () => {
        rowsTimer = undefined;
        void flushRows();
      },
      rowsWrittenOnce ? ROWS_WRITE_MS : 0,
    );
  };

  const flushRows = async () => {
    if (rowsTimer) clearTimeout(rowsTimer);
    rowsTimer = undefined;
    if (!rowsDirty || !cacheStaff) return;
    rowsDirty = false;
    rowsWrittenOnce = true;
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

  /**
   * The cookie now belongs to another staff member (signed in on this phone, maybe in another tab): drop
   * everything that was about the previous one. The data cache is per staff; "My requests", alerts, Undo
   * and the outbox operator prompt are all derived from the session staff, so none of them may carry over.
   */
  const resetForOtherStaff = async () => {
    staffEpoch += 1; // a sync begun for the previous staff applies nothing from here on
    await flushRows(); // the previous staff's cache keeps its latest rows
    set({ confirmed: new Map(), pending: new Map(), hasData: false });
    cursor = null;
    cursorAt = 0;
    setArmed(false);
    alertBacklog = [];
    for (const toastId of [...alertToasts.keys()]) dismissToast(toastId);
    closeSystemAlerts();
    clearSnackbar();
    approved.clear();
    touchedDuringPoll.clear();
    // Threads were the previous staff's (their read state, "You"); queued jobs stay (sent only as their owner).
    void messaging.clear(false);
  };

  /** False when a sign-out overtook it (nothing applied then). */
  const applySession = async (info: SessionInfo): Promise<boolean> => {
    const gen = ownerGen();
    const canon = canonStaff(info.staff) ?? '';
    if (cacheStaff !== canon) {
      // Someone else's (or no) cache was loaded: start clean for this staff.
      if (cacheStaff !== null) await resetForOtherStaff();
      await loadCache(canon);
      if (gen !== state.generation || signingOut) return false;
      cacheStaff = canon;
    }
    set({ session: { status: 'active', staffName: info.staffName, team: info.team, staff: info.staff, expiresAt: info.expiresAt } });
    if (sessionEndedToastId) dismissToast(sessionEndedToastId);
    sessionEndedToastId = null;
    const last: StoredStaff = { staffName: info.staffName, team: info.team, staff: info.staff };
    void enqueue((store) => store.set(K.lastStaff, last));
    refreshPrompt();
    kickOutbox();
    messaging.kick();
    // Polling stopped at a 401; a session confirmed again (signed in in another tab) restarts it.
    if (running && !pollInFlight && !pollTimer) schedulePoll(0);
    return true;
  };

  const checkSession = async (): Promise<PollOutcome> => {
    if (!env) return 'stale';
    const gen = ownerGen();
    const seq = sessionCheckSeq;
    const res = await call<SessionInfo>('/api/session', { timeoutMs: SYNC.requestTimeoutMs, signal: pollAbort?.signal });
    if (gen !== state.generation || signingOut) return 'stale';
    if (res.ok) {
      const info = res.data;
      if (typeof info.staff !== 'string' || typeof info.staffName !== 'string' || typeof info.team !== 'string') return 'http5xx';
      sessionCheckedAt = now();
      if (!(await applySession(info))) return 'stale';
      // Only now, with the new staff's session, cache and outbox prompt in place: until here every write,
      // create and outbox pass waits for this check (canFlush, writeGate and create all see it as due).
      // The outbox and poll applySession kicked wait on this same check, then go on.
      if (seq === sessionCheckSeq) sessionCheckDue = false;
      return 'ok';
    }
    const outcome = failureOutcome(res);
    if (outcome === 'unauthorized' && seq === sessionCheckSeq) sessionCheckDue = false;
    return outcome;
  };

  /** One GET /api/session at a time; the sync loop and writes share it. */
  const verifySession = (): Promise<PollOutcome> => {
    if (!sessionCheck) {
      sessionCheckSentAt = now();
      sessionCheck = checkSession().finally(() => {
        sessionCheck = null;
      });
    }
    return sessionCheck;
  };

  /** The tab resumed, or another tab signed in: who is signed in may have changed. */
  const sessionMayHaveChanged = () => {
    sessionCheckDue = true;
    sessionCheckSeq += 1;
  };

  /** verifySession until no reason to re-check is left (a newer one can come in during a check). */
  const confirmSession = async (): Promise<PollOutcome> => {
    let outcome: PollOutcome = 'ok';
    for (let i = 0; i < 3; i += 1) {
      outcome = await verifySession();
      if (outcome !== 'ok' || !sessionCheckDue) return outcome;
    }
    return sessionCheckDue ? 'network' : outcome;
  };

  /**
   * Before a write: when the session is not confirmed for this tab yet (just resumed, another tab signed
   * in, or not checked since load), confirm it first. A write prepared under another staff's identity is
   * not sent. Nothing is sent while a sign-out is pending either. Returns the failure to answer with, or
   * null to go ahead.
   */
  const writeGate = async (quiet: boolean): Promise<MutationResult | null> => {
    if (networkHeld()) {
      if (!quiet) toastFailure(COPY.sessionEnded, 'amber');
      return fail('unauthorized', COPY.sessionEnded);
    }
    if (!sessionCheckDue && state.session.status !== 'unknown') return null;
    const before = state.session.staff;
    const outcome = await confirmSession();
    if (outcome === 'ok') {
      if (before && !sameStaff(before, state.session.staff)) {
        if (!quiet) toastFailure(COPY.sessionChanged, 'amber');
        return fail('failed', COPY.sessionChanged);
      }
      return null;
    }
    if (outcome === 'unauthorized') return fail('unauthorized', COPY.sessionEnded);
    if (!quiet) toastFailure(COPY.failed);
    return fail(outcome === 'offline' ? 'offline' : 'failed', COPY.failed);
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
    // F4: a device whose session ended gets no more pushes (the browser drops its subscription; the server
    // learns on the next push; it subscribes again after sign-in). Registered by lib/client/push-client.ts.
    pushHooks()?.onSessionEnded();
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
    // (R2) A request opened at its Messages (a notification, a Message button) comes back there after sign-in.
    const target = `/signin?next=${encodeURIComponent(signInNext(e.location()))}`;
    if (recent) {
      // We were just sent back here with a cookie the API refuses: don't loop, offer the way out.
      sessionEndedToastId = showToast({ tone: 'amber', icon: 'alert', title: COPY.sessionEnded, action: { label: 'Sign in', run: () => e.redirect(target) }, durationMs: null });
      return;
    }
    void Promise.race([Promise.all([draftApi.flush(), flushRows()]), new Promise((r) => setTimeout(r, 600))]).then(() => {
      if (state.session.status === 'expired') e.redirect(target);
    });
  };

  // ---- sync loop ----
  const schedulePoll = (delayMs: number) => {
    if (!running || networkHeld()) return;
    if (pollTimer) clearTimeout(pollTimer);
    const id = runId;
    const delay = Math.max(0, delayMs);
    pollDueAt = now() + delay;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      // Far past due: the tab was frozen (phone locked). Its overdue timer can run before it hears
      // visibilitychange, and the cookie may be someone else's by now: confirm before syncing on.
      if (now() - pollDueAt > SESSION_FRESH_MS) sessionMayHaveChanged();
      void poll(id);
    }, delay);
  };

  /** An expired session is only asked again when there is a reason (resume, a sign-in in another tab). */
  const sessionBlocked = () =>
    state.session.status === 'signed_out' || (state.session.status === 'expired' && !sessionCheckDue);

  /** Focus / online / pageshow / visible / tap-the-dot: bursts coalesce into one poll. */
  const triggerSync = () => {
    if (!running || networkHeld() || sessionBlocked()) return;
    if (pollInFlight) {
      pollRerun = true;
      return;
    }
    schedulePoll(30);
  };

  const poll = async (id: number) => {
    if (!isLive(id) || pollInFlight || !env || networkHeld()) return;
    if (sessionBlocked()) return;
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
    // A sign-out (here or in another tab) aborted this poll: it is not a network failure, and nothing is
    // scheduled until it ends.
    if (!isLive(id) || gen !== state.generation || networkHeld()) return;
    if (outcome === 'stale') {
      // The data now belongs to another staff (a write or the outbox switched it): sync again for them.
      schedulePoll(0);
      return;
    }
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
        if (netFailures >= CONNECTION_FAILURES.network) setConnection('offline');
        break;
      case 'http5xx':
        failures += 1;
        httpFailures += 1;
        netFailures = 0;
        if (httpFailures >= CONNECTION_FAILURES.http) setConnection('error');
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
    const outcome = await syncPages(gen);
    // Rows applied before a later request failed keep their alerts (alertBacklog): show them now. A sync
    // cut short by a stop keeps them for the next one; a sign-out drops them with the rest of the data.
    if (outcome !== 'stale' && gen === state.generation && running && !networkHeld()) deliverAlerts();
    return outcome;
  };

  const syncPages = async (gen: number): Promise<PollOutcome> => {
    const e = env;
    if (!e) return 'stale';
    // When this tab can't be sure who is signed in (never checked, a 401, resumed, or a sign-in in another tab),
    // GET /api/session goes out with the first page, and nothing is applied until it confirms the session: the
    // cookie may now belong to someone else, and their session resets the cache and staffEpoch (stale() below).
    const check = state.session.status !== 'active' || sessionCheckDue ? confirmSession() : null;
    // Every page is for this staff: if the data switches to another staff meanwhile (a write or the outbox
    // confirmed a new session), nothing more of this sync is applied, and the cursor is not written.
    const epoch = staffEpoch;
    const stale = () => gen !== state.generation || !running || epoch !== staffEpoch;
    const full = cursor === null || now() - cursorAt > SYNC.fullFetchAfterMs;
    const reconcile = !full && reconcileDue;
    const since = full ? null : cursor;
    touchedDuringPoll.clear();
    const fullRows: RequestSummary[] = [];
    let versions: Array<[string, number]> | undefined;
    let firstServerTime: string | null = null;
    let after: SyncResponse['next'] = null;
    for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
      const path = syncPathFor(since, page === 0 && reconcile, after);
      const res = await call<SyncResponse>(path, { timeoutMs: SYNC.requestTimeoutMs, signal: pollAbort?.signal });
      if (check && (await check) !== 'ok') return check;
      if (stale()) return 'stale';
      if (!res.ok) return failureOutcome(res);
      const body = res.data;
      if (typeof body.serverTime !== 'string' || !Array.isArray(body.rows)) return 'http5xx';
      if (page === 0) {
        firstServerTime = body.serverTime;
        // F4: the Activity unread count rides on the first page (lib/client/f4-bridge.ts).
        publishSyncExtras(body);
      }
      if (Array.isArray(body.versions)) versions = [...(versions ?? []), ...body.versions];
      if (full) fullRows.push(...body.rows.filter(isRow));
      else ingest(body.rows, true);
      if (!body.hasMore || !body.next || typeof body.next.at !== 'string' || typeof body.next.id !== 'string') break;
      after = body.next;
    }
    if (full) {
      const valid = fullRows;
      if (armed) alertBacklog.push(...diffRaisedAlerts(state.confirmed, valid, alertCtx()));
      set({ confirmed: replaceAll(state.confirmed, valid, touchedDuringPoll), hasData: true });
      markRowsDirty();
    }
    if (reconcile && versions) {
      const outdated = staleIds(state.confirmed, versions);
      for (const ids of chunk(outdated, 200)) {
        const res = await call<SyncResponse>(syncPathIds(ids), { timeoutMs: SYNC.requestTimeoutMs, signal: pollAbort?.signal });
        if (stale()) return 'stale';
        if (!res.ok) return failureOutcome(res);
        if (Array.isArray(res.data.rows)) ingest(res.data.rows, true);
      }
      reconcileDue = false;
    }
    if (firstServerTime) {
      // The cursor advances only after every page is applied, verbatim (A7, A37).
      cursor = firstServerTime;
      cursorAt = now();
      writeCursor(firstServerTime);
      set({ lastSyncAt: firstServerTime, lastSyncLocalAt: now(), hasData: true });
    }
    // The first sync after load is the baseline: it alerts nothing (runSync shows what later ones raise).
    setArmed(true);
    if (state.outbox.length) kickOutbox();
    messaging.kick();
    return 'ok';
  };

  /** One row, fresh (409 follow-up, A12). */
  const fetchRow = async (id: string): Promise<RequestSummary | null> => {
    if (!env) return null;
    const gen = ownerGen();
    const res = await call<SyncResponse>(syncPathIds([id]), { timeoutMs: MUTATION_TIMEOUT_MS });
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
  /**
   * Drop the overlay, then map a failure to a result (and a toast). Never leaves unconfirmed state.
   * `quiet`: the caller shows the failure itself (MutationOptions), so no toast; a 401 still signs out.
   */
  const mutationFailed = async (id: string, res: HttpFailure, opts: { conflictToast: boolean; quiet?: boolean }): Promise<MutationResult> => {
    dropOverlay(id);
    const toast = (title: string, tone?: ToastItem['tone']) => {
      if (!opts.quiet) toastFailure(title, tone);
    };
    if (res.kind === 'http') {
      switch (res.status) {
        case 401:
          sessionExpired();
          return fail('unauthorized', COPY.sessionEnded);
        case 409: {
          const latest = await fetchRow(id);
          if (opts.conflictToast && !opts.quiet) showToast({ tone: 'amber', icon: 'alert', title: COPY.conflict, durationMs: 6_000 });
          return fail('conflict', COPY.conflict, latest ?? undefined);
        }
        case 403:
          toast(COPY.forbidden, 'amber');
          return fail('forbidden', COPY.forbidden);
        case 404:
          toast(COPY.notFound, 'amber');
          return fail('not_found', COPY.notFound);
        case 422: {
          const latest = await fetchRow(id);
          toast(COPY.invalid, 'amber');
          return fail('invalid', res.error?.message || COPY.invalid, latest ?? undefined);
        }
        default:
          break;
      }
    }
    toast(COPY.failed);
    return fail('failed', COPY.failed);
  };

  const refuseOffline = (quiet = false): MutationResult => {
    if (!quiet) showToast({ tone: 'amber', icon: 'cloud-off', title: COPY.needsConnection, durationMs: 4_000 });
    return fail('offline', COPY.needsConnection);
  };

  const postStatus = (id: string, status: SettableStatus, expectedVersion: number, kind: StatusKind) =>
    call<ChangeResponse>(`/api/requests/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      json: { status, expectedVersion, kind },
      timeoutMs: MUTATION_TIMEOUT_MS,
    });

  /** The row's latest version came from this phone, or from the same staff member on another phone. */
  const changedByThisStaff = (row: RequestSummary) => ownKeys.has(alertKey(row)) || sameStaff(row.updatedBy, state.session.staff);

  /** `hold` is the loaded hold rules (loadHold): the Undo bar's words and the hold fields the Undo restores. */
  const showUndo = (row: RequestSummary, before: RequestSummary, to: SettableStatus, hold: HoldRules) => {
    const back = undoTarget(before.status);
    if (!back || !isSettable(back) || back === to) return;
    clearSnackbar();
    const snackId = uuid();
    undoRecords.set(snackId, { id: row.id, to: back, version: row.rowVersion, restore: hold.holdFieldsOf(before) });
    // (Pending v9.1) A Not found says what it did: "Not found yet · recheck in 20 min" (the hold) or "B.W. closed ·
    // not found in medical" (the final answer).
    const words = hold.notFoundSnack(row, to);
    const message = words?.message ?? `${formatCaseNumber(row.caseNumber)} · ${statusMeta(to).shortLabel}`;
    set({ snackbar: { id: snackId, message, ...(words ? { said: words.said } : {}), expiresAt: now() + UNDO_MS } });
    // Held (the location sheet covers the bar): the countdown starts when the hold is released.
    if (undoHolds === 0) armUndo(snackId);
  };

  /** The Undo `snackId` goes in UNDO_MS from now (replacing any countdown running). */
  const armUndo = (snackId: string) => {
    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = setTimeout(() => {
      snackTimer = undefined;
      undoRecords.delete(snackId);
      if (state.snackbar?.id === snackId) set({ snackbar: null });
    }, UNDO_MS);
  };

  const holdUndo = (): (() => void) => {
    undoHolds += 1;
    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      undoHolds -= 1;
      if (undoHolds > 0) return;
      const snack = state.snackbar;
      if (!snack || !undoRecords.has(snack.id)) return;
      // A full window from the moment the bar is uncovered.
      set({ snackbar: { ...snack, expiresAt: now() + UNDO_MS } });
      armUndo(snack.id);
    };
  };

  /**
   * (Pending v9.1) Requests with an Undo on its way, and the row it brings back: a tap on that card reads it (see
   * setStatus), not the confirmed row it replaces.
   */
  const undoing = new Map<string, Pick<RequestSummary, 'status' | 'recheckAt'>>();

  const runStatus = async (
    id: string,
    to: SettableStatus,
    kind: StatusKind,
    undoVersion: number | null,
    tapHeld?: boolean | 'shown',
    restore?: HoldFields,
  ): Promise<MutationResult> => {
    // (F5) The hold's client side (loadHold). Nothing is on screen yet, so a failed load is only the toast.
    const hold = await loadHold().catch(() => null);
    if (!hold) {
      toastFailure(COPY.failed);
      return fail('failed', COPY.failed);
    }
    const gen = ownerGen();
    const row = state.confirmed.get(id);
    if (!row) return fail('not_found', COPY.notFound);
    const from = row.status;
    // A queued second tap that the first one already satisfied.
    if (undoVersion === null && from === to) return { ok: true, changed: false, request: row };
    // (F5) A Not found tapped on a request that was not on hold, queued behind one that has put it on hold (a
    // double tap): already satisfied. Sent, it would be the final answer.
    if (undoVersion === null && to === STATUS.notInMedical && kind === 'answer' && tapHeld === false && isHeld(row)) {
      return { ok: true, changed: false, request: row };
    }
    // (F6 follow-up) A "× Not located" tapped on the hold this phone showed ahead of the server: the final answer only
    // once that hold is the server's AND this phone's own first tap put it there (its committed row is in ownKeys).
    // The first tap failed, lost a 409 to someone else's hold, or the request moved on: nothing is sent.
    if (undoVersion === null && to === STATUS.notInMedical && kind === 'answer' && tapHeld === 'shown' && (!isHeld(row) || !ownKeys.has(alertKey(row)))) {
      return { ok: true, changed: false, request: row };
    }
    // (F5) A first Not found keeps the status and goes on hold (lib/client/hold-rules.ts predicts it); (Pending v9.1)
    // an Undo comes back with the hold fields it restores.
    setOverlay(id, { mutationId: uuid(), kind: 'status', fields: hold.statusOverlayFields(row, to, kind, now(), restore), startedAt: now() });
    let res: HttpResult<ChangeResponse> = await postStatus(id, to, undoVersion ?? row.rowVersion, kind);
    if (gen !== state.generation) return fail('failed', COPY.failed);
    if (!res.ok && res.kind === 'http' && res.status === 409 && kind !== 'undo') {
      // A12: only fields or photos changed (same status as the tap started from) → resend once.
      const latest = await fetchRow(id);
      if (gen !== state.generation) return fail('failed', COPY.failed);
      // (F5) Not a Not found when the hold moved: a request someone else just put on hold must not be closed by
      // the resend (the same tap, meant as the first Not found, would be the final one now).
      // (Post-event) Nor when a swap was asked for, decided or called off in between: a Friend informed tapped on
      // a view without it would close a request someone is acting on.
      if (latest && latest.status === from && sameSwap(latest, row) && !(to === STATUS.notInMedical && hold.holdChanged(row, latest))) {
        res = await postStatus(id, to, latest.rowVersion, kind);
        if (gen !== state.generation) return fail('failed', COPY.failed);
      } else {
        dropOverlay(id);
        showToast({ tone: 'amber', icon: 'alert', title: COPY.conflict, durationMs: 6_000 });
        return fail('conflict', COPY.conflict, latest ?? undefined);
      }
    }
    if (!res.ok && res.kind === 'http' && res.status === 409 && kind === 'undo') {
      // Never retried (A12). Only say "someone else" when it was someone else.
      dropOverlay(id);
      const latest = await fetchRow(id);
      if (gen !== state.generation) return fail('failed', COPY.failed);
      const message = latest && changedByThisStaff(latest) ? COPY.undoStale : COPY.conflict;
      showToast({ tone: 'amber', icon: 'alert', title: message, durationMs: 6_000 });
      return fail('conflict', message, latest ?? undefined);
    }
    if (res.ok && isRow(res.data.request)) {
      const request = res.data.request;
      commitOwn(request, id);
      markLive();
      if (res.data.changed && UNDOABLE_KINDS.has(kind)) showUndo(request, row, to, hold);
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

  /** The job record, and with `withBlobs` its photo bytes, committed in one transaction (persist.ts). */
  const persistJob = async (job: OutboxItem, withBlobs: boolean): Promise<boolean> => {
    if (!kv || !state.durableStorage) return false;
    const gen = ownerGen();
    const ok = await enqueue(async (store) => {
      if (gen !== state.generation) return false;
      const entries: Array<[string, unknown]> = [];
      if (withBlobs) for (const p of job.photos) if (!p.acked) entries.push(await photoBlobsEntry(p.photoId, p.blob, p.thumbBlob));
      entries.push([K.job(job.mutationId), jobToStored(job)]);
      await store.setMany(entries);
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

  /**
   * Deletes photo bytes nobody references (finished jobs, cleared drafts). The stored draft and jobs (other
   * tabs' included) are read and the bytes deleted in one transaction, which IndexedDB never interleaves
   * with another tab's save (bytes and their record also go in one transaction): a photo being saved
   * elsewhere is either not there yet or already referenced. References only this tab holds in memory are
   * kept too.
   */
  const gcBlobs = async () => {
    const keep = new Set<string>();
    for (const p of draftPending?.photos ?? []) keep.add(K.blob(p.photoId));
    for (const j of state.outbox) for (const p of j.photos) if (!p.acked) keep.add(K.blob(p.photoId));
    await enqueue((store) => store.collectBlobs(keep));
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
        if (!canFlush() && !sessionCheckDue) break;
        const sendable = state.outbox.some((j) => j.state !== 'needs_attention');
        if (sendable && now() - sessionCheckedAt > SESSION_FRESH_MS) sessionMayHaveChanged();
        if (sessionCheckDue) {
          if (!running || !env?.online() || networkHeld() || state.session.status === 'signed_out') break;
          // Who the cookie belongs to decides the operator prompt; confirm it before anything is sent.
          if ((await confirmSession()) !== 'ok') break;
        }
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

  // Jobs go out under the cookie's identity, so never before this tab has confirmed who that is.
  const canFlush = () => running && state.session.status === 'active' && !sessionCheckDue && !!env && env.online() && !networkHeld();

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
    let job = getJob(mutationId);
    if (!job) return 'next';
    patchJob(mutationId, { state: 'sending' });
    if (!job.serverId) {
      const existing = confirmedRowForJob(job, state.confirmed);
      if (existing) {
        // A6: it was created already (another tab, or a lost response): continue with its photos.
        createdOk(mutationId, existing);
      } else {
        const res = await call<CreateResponse>('/api/requests', { method: 'POST', json: job.payload, timeoutMs: OUTBOX_CREATE_TIMEOUT_MS });
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
      const res = await call<PhotoResponse>(`/api/requests/${encodeURIComponent(serverId)}/photos`, { method: 'POST', form, timeoutMs: PHOTO_TIMEOUT_MS });
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

  const broadcast = (
    message:
      | { type: 'logout'; generation: number }
      | { type: 'signout-pending' }
      | { type: 'signout-failed' }
      | { type: 'outbox' }
      | { type: 'myids' }
      | { type: 'outbox-idle' }
      | { type: 'mjobs' },
  ) => {
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
  /** New photo bytes and the draft record that references them, in one transaction (persist.ts). */
  const writeDraft = async (d: RequestDraft) => {
    const gen = ownerGen();
    await enqueue(async (store) => {
      if (gen !== state.generation) return;
      const entries: Array<[string, unknown]> = [];
      const added: string[] = [];
      for (const p of d.photos) {
        if (draftSavedPhotos.has(p.photoId)) continue;
        entries.push(await photoBlobsEntry(p.photoId, p.blob, p.thumbBlob));
        added.push(p.photoId);
      }
      entries.push([K.draft, draftToStored(d)]);
      await store.setMany(entries);
      for (const id of added) draftSavedPhotos.add(id);
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
    // A sign-out is pending (here or in another tab): nothing new goes out, or into an outbox it may be
    // about to discard.
    if (networkHeld()) return { outcome: 'not_saved', message: COPY.sessionEnded };

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
    if (sessionCheckDue || state.session.status === 'unknown') {
      // Saved already; it is sent only once this tab knows whose cookie it is. A different staff than
      // the one it was saved by gets the operator prompt ("Send as …?") instead of a silent send.
      const outcome = await confirmSession();
      if (gen !== state.generation) return { outcome: 'not_saved', message: COPY.notSaved };
      if (outcome !== 'ok' || promptIds.includes(mutationId)) return queued();
    }

    directSends.add(mutationId);
    let res: HttpResult<CreateResponse>;
    try {
      res = await call<CreateResponse>('/api/requests', { method: 'POST', json: payload, timeoutMs: MUTATION_TIMEOUT_MS });
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
    const blocked = await writeGate(true);
    if (blocked) return { outcome: 'not_saved', message: blocked.ok ? COPY.notSaved : blocked.message };
    const res = await call<CreateResponse>('/api/requests', { method: 'POST', json: job.payload, timeoutMs: MUTATION_TIMEOUT_MS });
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

  const addPhotos = async (
    id: string,
    photos: DraftPhoto[],
    timing: 'today' | 'older',
    opts?: MutationOptions,
  ): Promise<{ added: number; failed: number }> => {
    requireEnv();
    const quiet = !!opts?.quiet;
    if (offlineNow()) {
      refuseOffline(quiet);
      return { added: 0, failed: photos.length };
    }
    if (await writeGate(quiet)) return { added: 0, failed: photos.length };
    const gen = ownerGen();
    let added = 0;
    let failed = 0;
    for (const p of photos) {
      const form = new FormData();
      form.set('photoId', p.photoId);
      form.set('timing', timing);
      form.set('photo', p.blob, `${p.photoId}.jpg`);
      form.set('thumb', p.thumbBlob, `${p.photoId}_thumb.jpg`);
      const res = await call<PhotoResponse>(`/api/requests/${encodeURIComponent(id)}/photos`, { method: 'POST', form, timeoutMs: PHOTO_TIMEOUT_MS });
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
    if (failed > 0 && !quiet) toastFailure(failed === 1 ? "Couldn't add the photo" : `Couldn't add ${failed} photos`);
    return { added, failed };
  };

  // ---- sign out (A14) ----
  const clearLocalData = async (discardOutbox: boolean) => {
    const store = kv;
    // (F6 follow-up) The bell copied the signed-out staff member's server switch: the next one starts from theirs.
    forgetBell();
    set({
      prefs: { ...state.prefs, bell: false, bellIntroSeen: false },
      confirmed: new Map(),
      pending: new Map(),
      myIds: new Set(),
      hasData: false,
      lastSyncAt: null,
      lastSyncLocalAt: null,
      toasts: [],
      snackbar: null,
      outboxPrompt: null,
      ...(discardOutbox ? { outbox: [] } : {}),
    });
    for (const t of toastTimers.values()) clearTimeout(t);
    toastTimers.clear();
    alertToasts.clear();
    closeSystemAlerts();
    clearSnackbar();
    cursor = null;
    cursorAt = 0;
    cacheStaff = null;
    setArmed(false);
    alertBacklog = [];
    publishSyncExtras(null);
    rowsDirty = false;
    if (rowsTimer) clearTimeout(rowsTimer);
    rowsTimer = undefined;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = undefined;
    draftPending = null;
    draftHas = false;
    // Threads (memory; their cached copies are `cache:` keys, deleted below) and, with the outbox, queued
    // messages and en route taps (`mjob:` keys).
    void messaging.clear(discardOutbox);
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

  /** Our API's own 401 (an HTML 401 from a portal or proxy in between says nothing about the cookie). */
  const refusedByApi = (res: HttpResult<unknown>) => !res.ok && res.kind === 'http' && res.status === 401 && res.error !== null;

  /**
   * DELETE /api/session, then GET /api/session must answer our API's 401: only that proves the browser
   * holds no session any more (an answer that landed after the DELETE could have re-issued the cookie).
   * Retried while the outcome is uncertain, or when the cookie is still valid. Never true offline or after
   * a timeout: the HttpOnly cookie would still open the app again. These two requests are the only ones
   * that bypass call() (which holds everything while a sign-out is pending).
   */
  const deleteSession = async (e: StoreEnv): Promise<boolean> => {
    for (let attempt = 0; ; attempt += 1) {
      if (!e.online()) return false;
      const res = await apiRequest(e.fetch, '/api/session', { method: 'DELETE', timeoutMs: SIGN_OUT_TIMEOUT_MS });
      let again: boolean;
      if (res.ok || refusedByApi(res)) {
        const check = await apiRequest(e.fetch, '/api/session', { timeoutMs: SIGN_OUT_TIMEOUT_MS });
        if (refusedByApi(check)) return true;
        again = true; // still signed in (a late answer re-issued the cookie), or unknown: clear it again
      } else {
        // Not our API's answer (a portal's 401 or 2xx), a timeout or a 5xx: unknown, try again.
        again = isUncertain(res) || (res.kind === 'http' && res.error === null);
      }
      const wait = SIGN_OUT_RETRY_MS[attempt];
      if (wait === undefined || !again) return false;
      await new Promise((r) => setTimeout(r, wait));
    }
  };

  /**
   * The whole sign-out (A14), also resumed by a page that loads while one is pending. Pending first (the
   * marker, and nothing syncs or sends), then the server must confirm the cookie is gone; only then are
   * the other tabs told, the data cleared and /signin opened. If it can't be confirmed, nothing was
   * cleared: the session simply goes on and the caller tells the user.
   */
  const runSignOut = async (discard: boolean): Promise<SignOutResult> => {
    const e = requireEnv();
    const storage = e.localStorage();
    // F4: the server forgets this device's push subscription first, while the session can still say whose it
    // is (bounded, never rejects, lib/client/push-client.ts). The browser keeps it until the sign-out is
    // confirmed below.
    await pushHooks()?.beforeSignOut();
    signingOut = true;
    resumeSignOut = null;
    writeLogoutPending(storage, { at: now(), discard });
    // Every request still on its way is aborted (in this tab, and the other tabs abort theirs when they
    // hear this) before the DELETE goes: an answer landing after it could re-issue the cookie. Nothing new
    // starts until the sign-out ended (call()).
    broadcast({ type: 'signout-pending' });
    haltRuntime();
    abortInflight();
    const confirmed = await deleteSession(e);
    if (!confirmed) {
      clearLogoutPending(storage);
      signingOut = false;
      broadcast({ type: 'signout-failed' });
      // Back to normal: polling and the outbox resume (the session was never given up locally), and so do this
      // device's lock-screen alerts (F4: it tells the server about its subscription again).
      if (running && state.session.status !== 'signed_out') {
        schedulePoll(0);
        kickOutbox();
      }
      void pushHooks()?.afterSignOut(false);
      return { ok: false, reason: 'failed', message: COPY.signOutFailed };
    }
    set({ generation: state.generation + 1 });
    staffEpoch += 1;
    haltRuntime();
    abortInflight();
    broadcast({ type: 'logout', generation: state.generation });
    // F4: signed out for sure: the browser drops the push subscription (also when the push client is not
    // loaded yet, as in a sign-out resumed at load).
    await (pushHooks()?.afterSignOut(true) ?? dropBrowserPush());
    await clearLocalData(discard);
    set({ session: { status: 'signed_out', staffName: null, team: null, staff: null, expiresAt: null } });
    clearLogoutPending(storage);
    e.redirect('/signin');
    return { ok: true };
  };

  const signOutOnce = (discard: boolean): Promise<SignOutResult> => {
    if (!signOutRun) {
      signOutRun = runSignOut(discard).finally(() => {
        signOutRun = null;
      });
    }
    return signOutRun;
  };

  /** Another tab's sign-out ended without signing out (or its tab died): this tab goes on. */
  const endPeerHold = () => {
    if (peerHoldTimer) clearTimeout(peerHoldTimer);
    peerHoldTimer = undefined;
    peerSignOutUntil = 0;
    if (!running || signingOut || state.session.status === 'signed_out') return;
    if (!sessionBlocked()) schedulePoll(0);
    kickOutbox();
  };

  const onChannelMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; generation?: number } | null;
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'signout-pending':
        // Another tab is signing out: abort what this tab has on its way and send nothing until it says
        // how that ended. Any answer from now on could re-issue the cookie the server is about to clear.
        if (signingOut) return;
        peerSignOutUntil = now() + PEER_SIGN_OUT_HOLD_MS;
        haltRuntime();
        abortInflight();
        if (peerHoldTimer) clearTimeout(peerHoldTimer);
        peerHoldTimer = setTimeout(endPeerHold, PEER_SIGN_OUT_HOLD_MS);
        return;
      case 'signout-failed':
        if (peerSignOutUntil > 0) endPeerHold();
        return;
      case 'logout':
        // Sent only after the server confirmed the cookie is cleared. A tab with its own sign-out pending
        // finishes it itself (its DELETE now answers 401, which counts as done).
        if (signingOut) return;
        signingOut = true;
        if (peerHoldTimer) clearTimeout(peerHoldTimer);
        peerHoldTimer = undefined;
        peerSignOutUntil = 0;
        set({ generation: state.generation + 1, session: { status: 'signed_out', staffName: null, team: null, staff: null, expiresAt: null } });
        staffEpoch += 1;
        haltRuntime();
        abortInflight();
        void clearLocalData(false).then(() => env?.redirect('/signin'));
        return;
      case 'signin':
        // Someone signed in in another tab: the shared cookie may now be another staff member's.
        sessionMayHaveChanged();
        triggerSync();
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
      case 'mjobs':
        // Another tab queued, sent or retried a message / en route tap.
        void messaging.reload().then(() => messaging.kick());
        return;
    }
  };

  // ---- messages and en route (F3, lib/client/messages-core.ts) ----
  /** A request's activity (unread, last message, en route) as the engine learned it: same rowVersion, no alert. */
  const patchActivity = (id: string, activity: Partial<RequestSummary>) => {
    const row = state.confirmed.get(id);
    if (!row) return;
    const next = { ...row, ...activity };
    if (sameRow(row, next)) return;
    const confirmed = new Map(state.confirmed);
    confirmed.set(id, next);
    set({ confirmed });
    markRowsDirty();
  };

  // The engine itself loads after start (messages-lazy.ts): it is not part of the first-load JS (A25).
  const messaging = createLazyMessaging({
    call,
    online: () => !!env && env.online() && state.connection !== 'offline',
    visible: () => !!env && env.visible(),
    canSend: () => canFlush(),
    async ensureSession() {
      if (!running || networkHeld() || state.session.status === 'signed_out') return false;
      if (!sessionCheckDue && state.session.status === 'active') return true;
      return (await confirmSession()) === 'ok';
    },
    sessionExpired,
    staff: () => state.session.staff,
    cacheStaff: () => cacheStaff,
    generation: () => state.generation,
    kv: () => kv,
    enqueue,
    durable: () => state.durableStorage,
    row: (id) => state.confirmed.get(id),
    patchActivity,
    markLive,
    showToast,
    showUndo: showCustomUndo,
    broadcast: () => broadcast({ type: 'mjobs' }),
    locks: () => env?.locks ?? null,
  }, options.loadMessaging);

  // ---- actions ----
  const actions: StoreActions = {
    syncNow() {
      triggerSync();
      kickOutbox();
    },

    async setStatus(id, status, kind) {
      if (offlineNow()) return refuseOffline();
      // (F5) Whether the request was on hold, as the server last said, when tapped (see runStatus). Not the
      // overlay: a double tap lands while the first tap's predicted hold is on screen, and must stay a repeat.
      // (Pending v9.1) While an Undo is on its way the card on screen is the one it brings back (its overlay, held
      // again after the final Not found's Undo): a "× Not found" tapped there is meant as the final answer.
      const confirmedRow = undoing.get(id) ?? state.confirmed.get(id);
      let tapHeld: boolean | 'shown' = confirmedRow ? isHeld(confirmedRow) : false;
      // (F6 follow-up) The first Not found's hold has been on screen for longer than a double tap: this is the
      // "× Not located" the medic saw, queued behind the first and sent as the final answer once the hold is saved.
      const overlay = state.pending.get(id);
      const row = state.confirmed.get(id);
      if (!tapHeld && status === STATUS.notInMedical && kind === 'answer' && row && overlay?.kind === 'status') {
        if (isHeld({ ...row, ...overlay.fields }) && now() - overlay.startedAt >= DOUBLE_TAP_MS) tapHeld = 'shown';
      }
      return serialize(id, async () => (await writeGate(false)) ?? runStatus(id, status, kind, null, tapHeld));
    },

    async undo(snackbarId) {
      const custom = customUndos.get(snackbarId);
      if (custom) {
        clearSnackbar();
        custom();
        return null;
      }
      const record = undoRecords.get(snackbarId);
      if (!record) return null;
      clearSnackbar();
      if (offlineNow()) return refuseOffline();
      // Never retried automatically (A12); expectedVersion = the version the original mutation returned.
      return serialize(record.id, async () => {
        const blocked = await writeGate(false);
        if (blocked) return blocked;
        // This phone changed the request again while the Undo was queued behind it: it would only 409.
        const current = state.confirmed.get(record.id);
        if (current && current.rowVersion !== record.version && ownKeys.has(alertKey(current))) {
          showToast({ tone: 'amber', icon: 'alert', title: COPY.undoStale, durationMs: 6_000 });
          return fail('conflict', COPY.undoStale, current);
        }
        undoing.set(record.id, { status: record.to, recheckAt: record.restore.recheckAt });
        try {
          return await runStatus(record.id, record.to, 'undo', record.version, undefined, record.restore);
        } finally {
          undoing.delete(record.id);
        }
      });
    },

    dismissSnackbar: clearSnackbar,

    holdUndo,

    create,

    async updateFields(id, patch: RequestPatch, baseVersion, opts) {
      const quiet = !!opts?.quiet;
      if (offlineNow()) return refuseOffline(quiet);
      return serialize(id, async () => {
        const blocked = await writeGate(quiet);
        if (blocked) return blocked;
        const gen = ownerGen();
        const row = state.confirmed.get(id);
        if (!row) return fail('not_found', COPY.notFound);
        setOverlay(id, { mutationId: uuid(), kind: 'fields', fields: overlayForPatch(row, patch), startedAt: now() });
        const res = await call<ChangeResponse>(`/api/requests/${encodeURIComponent(id)}`, {
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
        return mutationFailed(id, res.ok ? { ok: false, kind: 'network' } : res, { conflictToast: false, quiet });
      });
    },

    async setMedicalLocation(id, location, opts) {
      const quiet = !!opts?.quiet;
      if (offlineNow()) return refuseOffline(quiet);
      const value = location === null ? null : location.trim() || null;
      return serialize(id, async () => {
        const blocked = await writeGate(quiet);
        if (blocked) return blocked;
        const gen = ownerGen();
        const row = state.confirmed.get(id);
        if (!row) return fail('not_found', COPY.notFound);
        if ((row.medicalLocation ?? null) === value) return { ok: true, changed: false, request: row };
        setOverlay(id, { mutationId: uuid(), kind: 'fields', fields: { medicalLocation: value }, startedAt: now() });
        const send = (version: number) =>
          call<ChangeResponse>(`/api/requests/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            json: { patch: { medicalLocation: value }, expectedVersion: version },
            timeoutMs: MUTATION_TIMEOUT_MS,
          });
        let base = row.rowVersion;
        let res = await send(base);
        if (gen !== state.generation) return fail('failed', COPY.failed);
        if (!res.ok && res.kind === 'http' && res.status === 409) {
          // Someone else saved something in between: the location is one field this person just typed, so
          // it goes on top of the latest version (once).
          const latest = await fetchRow(id);
          if (gen !== state.generation) return fail('failed', COPY.failed);
          if (latest) {
            base = latest.rowVersion;
            res = await send(base);
            if (gen !== state.generation) return fail('failed', COPY.failed);
          }
        }
        if (res.ok && isRow(res.data.request)) {
          const request = res.data.request;
          if (res.data.changed) carryUndoFor(id, base, request.rowVersion);
          commitOwn(request, id);
          markLive();
          return { ok: true, changed: !!res.data.changed, request: state.confirmed.get(id) ?? request };
        }
        return mutationFailed(id, res.ok ? { ok: false, kind: 'network' } : res, { conflictToast: true, quiet });
      });
    },

    async swap(id, swapAction, opts) {
      const quiet = !!opts?.quiet;
      if (offlineNow()) return refuseOffline(quiet);
      return serialize(id, async () => {
        const blocked = await writeGate(quiet);
        if (blocked) return blocked;
        const gen = ownerGen();
        const row = state.confirmed.get(id);
        if (!row) return fail('not_found', COPY.notFound);
        const from = row.status;
        setOverlay(id, { mutationId: uuid(), kind: 'status', fields: swapOverlayFields(swapAction, state.session.staff, new Date(now()).toISOString()), startedAt: now() });
        const send = (version: number) =>
          call<ChangeResponse>(`/api/requests/${encodeURIComponent(id)}/swap`, {
            method: 'POST',
            json: { ...swapAction, expectedVersion: version },
            timeoutMs: MUTATION_TIMEOUT_MS,
          });
        let res = await send(row.rowVersion);
        if (gen !== state.generation) return fail('failed', COPY.failed);
        if (!res.ok && res.kind === 'http' && res.status === 409) {
          // Only fields changed in between (same status and swap as the tap started from): resend once, as setStatus.
          // (Post-event) A request declined, cancelled or opened again in between is someone else's decision.
          const latest = await fetchRow(id);
          if (gen !== state.generation) return fail('failed', COPY.failed);
          if (latest && latest.status === from && sameSwap(latest, row)) {
            res = await send(latest.rowVersion);
            if (gen !== state.generation) return fail('failed', COPY.failed);
          } else {
            dropOverlay(id);
            if (!quiet) showToast({ tone: 'amber', icon: 'alert', title: COPY.conflict, durationMs: 6_000 });
            return fail('conflict', COPY.conflict, latest ?? undefined);
          }
        }
        if (res.ok && isRow(res.data.request)) {
          const request = res.data.request;
          commitOwn(request, id);
          markLive();
          if (res.data.changed && !quiet) {
            const title = swapToastTitle(swapAction, swapAction.action === 'cancel' ? row : request);
            // (Post-event) Every step has its Undo: the request's is withdraw; Cancel swap, Decline and Swap at …
            // 'restore' exactly what they replaced (the original requester kept). Quiet, but a failed Undo says so.
            showCustomUndo(title, UNDO_MS, () =>
              void actions.swap(id, { action: swapAction.action === 'request' ? 'withdraw' : 'restore' }, { quiet: true }).then((r) => {
                if (!r.ok && r.reason !== 'unauthorized') {
                  const title = r.reason === 'offline' ? COPY.needsConnection : r.reason === 'conflict' || r.reason === 'invalid' ? COPY.undoStale : COPY.failed;
                  showToast({ tone: 'amber', icon: r.reason === 'offline' ? 'cloud-off' : 'alert', title, durationMs: 6_000 });
                }
              }),
            );
            if (swapAction.action === 'request' && state.snackbar) swapRequestUndo = { snackId: state.snackbar.id, id };
          }
          return { ok: true, changed: !!res.data.changed, request: state.confirmed.get(id) ?? request };
        }
        return mutationFailed(id, res.ok ? { ok: false, kind: 'network' } : res, { conflictToast: true, quiet });
      });
    },

    async cancel(id, opts) {
      const quiet = !!opts?.quiet;
      if (offlineNow()) return refuseOffline(quiet);
      return serialize(id, async () => {
        const blocked = await writeGate(quiet);
        if (blocked) return blocked;
        const gen = ownerGen();
        const row = state.confirmed.get(id);
        if (!row) return fail('not_found', COPY.notFound);
        if (row.status === STATUS.cancelled) return { ok: true, changed: false, request: row };
        setOverlay(id, { mutationId: uuid(), kind: 'cancel', fields: { status: STATUS.cancelled }, startedAt: now() });
        const res = await call<ChangeResponse>(`/api/requests/${encodeURIComponent(id)}/cancel`, {
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
        return mutationFailed(id, res.ok ? { ok: false, kind: 'network' } : res, { conflictToast: true, quiet });
      });
    },

    addPhotos,

    async preparePhoto(file, options) {
      const { compressPhoto } = await import('./image');
      return compressPhoto(file, options);
    },

    async fetchDetail(id): Promise<RequestDetail> {
      const e = requireEnv();
      if (!isUuid(id)) throw new FetchError('not_found');
      // Never while a sign-out is pending: its answer could bring the cookie back (see call()).
      if (networkHeld()) throw new FetchError('failed');
      const gen = ownerGen();
      const res = await call<RequestDetail>(`/api/requests/${encodeURIComponent(id)}`, { timeoutMs: SYNC.requestTimeoutMs });
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

    async fetchStats(range?: StatsRange): Promise<Stats> {
      requireEnv();
      if (networkHeld()) throw new FetchError('failed');
      const gen = ownerGen();
      // PHASE2: the dashboard's range and Stats shape over the events server's (lib/client/stats-shim.ts).
      const res = await call<EventStats>(range ? `/api/stats?range=${serverRange(range)}` : '/api/stats', { timeoutMs: SYNC.requestTimeoutMs });
      if (gen !== state.generation) throw new FetchError('failed');
      if (res.ok) {
        markLive();
        return legacyStats(res.data);
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
      // The engine loads after start: its count once it has read its jobs, else the saved `mjob:` keys
      // (never waits for the engine's code to download).
      const messages = await messaging.unsentNow();
      if ((unsent > 0 || messages > 0) && !opts?.discardOutbox) {
        return { ok: false, reason: 'outbox', count: unsent, ...(messages > 0 ? { messages } : {}) };
      }
      if (state.session.status === 'signed_out') return { ok: true };
      return signOutOnce(!!opts?.discardOutbox);
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

    messages: messaging,
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
        if (last && typeof last.staff === 'string' && cacheStaff === null) {
          await loadCache(canonStaff(last.staff) ?? '');
          // Offline reload: show who was signed in (avatar, My requests, alerts) until GET /api/session
          // confirms it. The status stays 'unknown', so nothing is sent on this identity's behalf.
          if (state.session.status === 'unknown' && !state.session.staff && typeof last.staffName === 'string' && typeof last.team === 'string') {
            set({ session: { ...state.session, staffName: last.staffName, team: last.team, staff: last.staff } });
          }
        }
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
    // Not awaited: the first sync and the request outbox never wait for the messages engine's code (it may
    // still be downloading on a slow network). It reads its saved jobs and kicks them once it is there.
    if (durable) void messaging.hydrate();
    if (durable) await importLegacyQueue();
    if (!isLive(id)) return;
    const pendingSignOut = resumeSignOut;
    if (pendingSignOut) {
      // The app was reloaded or killed while signing out (start() saw the marker and has held everything
      // since): finish that before trusting the cookie again.
      const result = await signOutOnce(pendingSignOut.discard);
      if (!result.ok && result.reason === 'failed' && isLive(id)) {
        showToast({ tone: 'amber', icon: 'alert', title: COPY.signOutFailed, durationMs: null });
      }
      return; // done: /signin is opening; not done: runSignOut already resumed polling and the outbox
    }
    schedulePoll(0);
    kickOutbox();
    messaging.kick();
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
    // F4's clients send through this store (lib/client/f4-bridge.ts).
    provideApi(call);
    runId += 1;
    const id = runId;
    if (signingOut && !resumeSignOut) return stop;
    if (!signingOut) {
      // A sign-out was pending when this page loaded: hold everything from the first moment, before any
      // listener below can start a sync or send a job (boot finishes the sign-out once it has loaded).
      const pending = readLogoutPending(e.localStorage());
      if (pending) {
        signingOut = true;
        resumeSignOut = pending;
      }
    }
    if (!e.online()) setConnection('offline');
    if (!e.visible()) markHidden(true);
    offs.push(
      e.on('window', 'online', () => {
        netFailures = 0;
        triggerSync();
        kickOutbox();
        messaging.kick();
      }),
      e.on('window', 'offline', () => setConnection('offline')),
      e.on('window', 'focus', triggerSync),
      e.on('window', 'pageshow', (event) => {
        // Back from the bfcache: the cookie may be someone else's now. (The first pageshow of a load is
        // not a resume: that load checks the session anyway.)
        if ((event as PageTransitionEvent).persisted === true) sessionMayHaveChanged();
        triggerSync();
      }),
      e.on('document', 'visibilitychange', () => {
        markHidden(!e.visible());
        if (e.visible()) {
          // A resumed tab confirms who is signed in before it syncs on, writes or sends queued requests. A check sent
          // under 2 s ago (the overdue poll timer runs before this event) already answers who is signed in now.
          if (!sessionCheck || now() - sessionCheckSentAt > 2e3) sessionMayHaveChanged();
          triggerSync();
        } else {
          // iOS may kill a hidden page without a pagehide: save now.
          void draftApi.flush();
          void flushRows();
        }
      }),
      e.on('window', 'pagehide', () => {
        void draftApi.flush();
        void flushRows();
      }),
      subscribePrefs((prefs) => set({ prefs })),
    );
    channel = e.channel(SESSION_CHANNEL);
    channel?.addEventListener('message', onChannelMessage);
    notifier = e.notifier?.() ?? null;
    if (armed) notifier?.setActive(true);
    // (F5) In before anyone can tap a status (see loadHold).
    void loadHold().catch(() => undefined);
    sw = e.serviceWorker({
      onUpdateReady: () => {
        if (!state.updateReady) set({ updateReady: true });
        showUpdateToast();
      },
      onOfflineReady: () => {
        if (!state.offlineReady) set({ offlineReady: true });
      },
    });
    messaging.start();
    void boot(id);
    return stop;
  };

  const stop = () => {
    if (!running) return;
    running = false;
    haltRuntime();
    if (peerHoldTimer) clearTimeout(peerHoldTimer);
    peerHoldTimer = undefined;
    for (const off of offs.splice(0)) off();
    channel?.removeEventListener('message', onChannelMessage);
    channel?.close();
    channel = null;
    sw?.stop();
    sw = null;
    notifier?.setActive(false);
    notifier = null;
    messaging.stop();
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

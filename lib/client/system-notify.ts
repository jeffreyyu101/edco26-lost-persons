// System notifications for alerts (spec §7 Alerts, v2.5 A52; Brian 2026-11-06: "alerts should depend on the
// device — if it's desktop use regular notifications through Chrome"). No server part: no Web Push, no
// VAPID. The page that raised an alert shows it through its own service worker registration, so it works
// only while the app is open (a background tab or a minimised window included).
//
//   * Supported: 'Notification' in window, an active service worker that handles notification clicks
//     (it answers {type: 'lp-caps'}; the worker of a build before this one does not, so until the update
//     takes over the page keeps toasts), and not a Safari tab on iPhone or iPad (there only a Home Screen
//     app may notify, iOS 16.4+; the tab never prompts). That covers desktop Chrome / Edge / Firefox,
//     Safari on macOS, Android Chrome and the iPhone Home Screen app. Always
//     registration.showNotification(), never `new Notification()` (Android Chrome throws).
//   * Permission is asked only inside a tap: turning Alerts on, or "Allow notifications" (menu and sheet).
//     Denied is shown quietly ("Blocked in browser") and never asked again by the app.
//   * Delivery (routeAlert): permission granted and the page hidden, or a desktop window without focus →
//     a system notification; otherwise the in-app toast + chime as before. Never both for one alert, in
//     one tab or across the tabs and windows of the browser (createPeerBoard): a background tab shows
//     nothing while another app tab is in front (that tab toasts it from its own sync), and an alert
//     another tab already delivered is not delivered again the other way.
//   * One notification per request (tag = request id): a later alert for it replaces the earlier one, and
//     the store closes one whose alert is out of date (alerts.ts alertStillCurrent). 3+ at once are one
//     notification ("3 new requests"), like the toast.
//   * Content: the LP number, "New request" or the status, initials and the post. Never a phone number or
//     any other contact detail: it lands on the lock screen and in the notification centre.
//   * Click: public/sw.js focuses an app window and posts {type: 'lp-open', url}; this page opens that view
//     in place (no reload, so an open form or sheet is not lost) and answers {ok}. A page that does not
//     answer (a sign-in page, an older build) is navigated by the worker instead.
//
// Off the first load (A25): the store loads this module with import() after start (store-core.ts
// browserEnv), and the avatar menu and the sheets import it from their own view chunks.
import { useSyncExternalStore } from 'react';
import type { RequestSummary } from '../api-types';
import { initials, statusMeta } from '../domain';
import { formatCaseNumber } from '../format';
import { alertKey } from './alerts';
import { hrefFor, navigate, parseView, viewToParams } from './nav';
import type { AlertEvent } from './store-contract';
import { uuid } from './uuid';

export type NotifyPermission = 'default' | 'granted' | 'denied';
/** 'none': this tab is in the background and another app tab is in front, which toasts the alert itself. */
export type AlertRoute = 'system' | 'toast' | 'none';

export interface NotifyState {
  /** System notifications can be shown on this device (see the header). */
  supported: boolean;
  permission: NotifyPermission;
}

/** The server render, and every device without system notifications. */
export const NO_NOTIFY: Readonly<NotifyState> = Object.freeze({ supported: false, permission: 'default' });

/** The tag of one request's notifications: the page's and Web Push's alike, so the OS replaces, never stacks. */
export const requestTag = (id: string) => `lp-${id}`;

/** Tag of a combined notification ("3 new requests"): the next burst replaces it. */
export const COMBINED_TAG = 'lp-alerts';
const ICON = '/icons/icon-192.png';
/** LP numbers listed in a combined notification before "+N". */
const MAX_LISTED = 4;

// ---------------------------------------------------------------------------------------------------
// Decisions (pure)
// ---------------------------------------------------------------------------------------------------

export interface DeviceInfo {
  /** 'Notification' in window. */
  hasNotification: boolean;
  /** Notification.permission as the browser reports it. */
  permission: unknown;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** Running as a Home Screen / installed app. */
  standalone: boolean;
  /**
   * An active service worker registration (registration.showNotification needs one) whose worker handles
   * notification clicks.
   */
  registration: boolean;
}

export function normalizePermission(value: unknown): NotifyPermission {
  return value === 'granted' || value === 'denied' ? value : 'default';
}

/** iPhone, iPod or iPad (iPadOS Safari reports itself as a Mac with a touch screen). */
export function isAppleTouch(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /\b(iPhone|iPad|iPod)\b/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

export function notifyStateOf(device: DeviceInfo): NotifyState {
  const safariTab = isAppleTouch(device.userAgent, device.platform, device.maxTouchPoints) && !device.standalone;
  return {
    supported: device.hasNotification && device.registration && !safariTab,
    permission: normalizePermission(device.permission),
  };
}

export interface WindowInfo {
  /** document.visibilityState === 'hidden' (another tab, minimised, locked). */
  hidden: boolean;
  /** document.hasFocus(). */
  focused: boolean;
  /** A pointer that hovers (mouse or trackpad): a desktop or laptop, where an unfocused window is "away". */
  desktop: boolean;
}

/** This window is the one being looked at: visible and, on a desktop, focused. */
export function inFront(win: WindowInfo): boolean {
  return !win.hidden && (win.focused || !win.desktop);
}

/**
 * Where an alert raised now goes: the in-app toast + chime while this window is in front; else a system
 * notification, or nothing when another app tab of this browser is in front (`otherTabInFront`): that tab
 * raises the same alert from its own sync and toasts it.
 */
export function routeAlert(state: NotifyState, win: WindowInfo, otherTabInFront = false): AlertRoute {
  if (!state.supported || state.permission !== 'granted' || inFront(win)) return 'toast';
  return otherTabInFront ? 'none' : 'system';
}

/** What a system notification shows, and what a click on it opens. */
export interface SystemNotice {
  title: string;
  body: string;
  /** "lp-<request id>" (one notification per request; Web Push uses the same tag, F4), or COMBINED_TAG. */
  tag: string;
  /** Path + query a click opens: "/?r=<id>", or "/" for a combined one. */
  url: string;
  /** `${id}:${rowVersion}` of the row that alerted (null when combined): the cross-tab dedupe. */
  key: string | null;
  /** In medical stays on screen until dismissed (front of house walks the friend to Main Med). */
  requireInteraction: boolean;
}

/** "S.L. · FA 3": initials and the post, never contact details. */
function who(row: RequestSummary): string {
  return [initials(row.name), row.postShort].filter(Boolean).join(' · ');
}

/**
 * The notification of an alert. `rowOf` gives the synced row of a request; `sources` are the alerts a
 * combined one stands for (coalesceAlerts).
 */
export function systemNotice(
  alert: AlertEvent,
  rowOf: (id: string) => RequestSummary | undefined,
  sources: readonly AlertEvent[] = [alert],
): SystemNotice {
  if (alert.kind === 'combined' || !alert.requestId) {
    const allNew = sources.length > 0 && sources.every((a) => a.kind === 'new_request');
    const lps = sources.flatMap((a) => {
      const row = a.requestId ? rowOf(a.requestId) : undefined;
      return row ? [formatCaseNumber(row.caseNumber)] : [];
    });
    const listed = lps.length > MAX_LISTED ? [...lps.slice(0, MAX_LISTED), `+${lps.length - MAX_LISTED}`] : lps;
    return {
      title: `${alert.count} ${allNew ? 'new requests' : 'updates'}`,
      body: listed.join(', '),
      tag: COMBINED_TAG,
      url: '/',
      key: null,
      requireInteraction: false,
    };
  }
  const id = alert.requestId;
  const row = rowOf(id);
  const url = hrefFor({ r: id });
  const requireInteraction = alert.kind === 'in_medical';
  const tag = requestTag(id);
  if (!row) return { title: alert.title, body: '', tag, url, key: null, requireInteraction };
  const lp = formatCaseNumber(row.caseNumber);
  const title = alert.kind === 'new_request' ? `New request · ${lp}` : `${lp} · ${statusMeta(row.status).shortLabel}`;
  const body = alert.kind === 'in_medical' ? [who(row), 'Bring the friend to Main Med'].filter(Boolean).join('\n') : who(row);
  return { title, body, tag, url, key: alertKey(row), requireInteraction };
}

/** registration.showNotification options. `renotify`: every alert sounds, as its toast would have chimed. */
export function noticeOptions(notice: SystemNotice): NotificationOptions & { renotify: boolean } {
  return {
    body: notice.body,
    tag: notice.tag,
    renotify: true,
    requireInteraction: notice.requireInteraction,
    icon: ICON,
    lang: 'en-US',
    data: { url: notice.url, key: notice.key },
  };
}

// ---------------------------------------------------------------------------------------------------
// The browser side
// ---------------------------------------------------------------------------------------------------

export interface NotificationLike {
  readonly permission: string;
  requestPermission(): Promise<string> | void;
}

export interface ShownNotificationLike {
  readonly data?: unknown;
  close(): void;
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
}

export interface RegistrationLike {
  /** The worker that receives notification clicks. */
  readonly active?: WorkerLike | null;
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
  getNotifications?(filter?: { tag?: string }): Promise<readonly ShownNotificationLike[]>;
}

/** localStorage, as far as the cross-tab board uses it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * What the notifier hears from the browser: the window gained or lost focus or visibility, the page is
 * going away or is back (bfcache), the active service worker changed, or the permission changed in the
 * site settings.
 */
export type HostEvent = 'focus' | 'blur' | 'visibilitychange' | 'pagehide' | 'pageshow' | 'controllerchange' | 'permission';

/** What the notifier reads from the browser (tests pass a fake). */
export interface NotifyHost {
  /** window.Notification, or null when the browser has none. */
  notification(): NotificationLike | null;
  /** navigator.serviceWorker.ready, or null without service workers. */
  ready(): Promise<RegistrationLike> | null;
  /**
   * True once the registration's active worker says it handles notification clicks ({type: 'lp-caps'}).
   * The worker of an older build never answers: until this build's worker takes over (after "Update
   * ready · Reload"), a click on a notification would do nothing, so alerts stay toasts.
   */
  handlesClicks(registration: RegistrationLike): Promise<boolean>;
  device(): Pick<DeviceInfo, 'userAgent' | 'platform' | 'maxTouchPoints' | 'standalone'>;
  window(): WindowInfo;
  /** Calls `onChange` on each HostEvent. Returns the remover. */
  watch(onChange: (event: HostEvent) => void): () => void;
  /** localStorage (shared by the browser's tabs and windows of the app), or null when blocked. */
  storage(): StorageLike | null;
  now(): number;
}

/** Where a batch of alerts goes (AlertNotifier.plan). */
export interface AlertPlan {
  route: AlertRoute;
  /** Alert keys another tab of this browser already delivered (toast or notification): shown nowhere here. */
  skip: ReadonlySet<string>;
}

/** Every alert a toast, nothing skipped: the store's default, and every device without system notifications. */
export const TOAST_PLAN: Readonly<AlertPlan> = Object.freeze({ route: 'toast', skip: new Set<string>() });

/** What the store uses to deliver alerts (StoreEnv.notifier). */
export interface AlertNotifier {
  /**
   * Where a batch goes, decided once (routeAlert and the cross-tab board), with `keys` the (id, rowVersion)
   * of its alerts. A batch routed to 'toast' or 'system' records its keys for the browser's other tabs.
   */
  plan(keys: readonly string[]): AlertPlan;
  /**
   * Shows `alert` as a system notification (systemNotice, built at once from `rowOf`; `sources` are the
   * alerts a combined one stands for). False when it could not be shown: the store then toasts it.
   */
  show(alert: AlertEvent, rowOf: (id: string) => RequestSummary | undefined, sources: readonly AlertEvent[]): Promise<boolean>;
  /** Closes this request's notification (tag requestTag(id); only the one of `key`, when given). */
  close(requestId: string, key?: string | null): void;
  /** Closes every notification of the app (sign-out, another staff signed in), and forgets the board. */
  closeAll(): void;
  /**
   * The store is signed in and raising alerts (past its baseline sync). Only then may this tab, while in
   * front, claim the alerts of the browser's other app tabs.
   */
  setActive(active: boolean): void;
}

export interface NotifySystem extends AlertNotifier {
  /** Starts reading the registration and watching the permission (idempotent). */
  start(): void;
  /** Where an alert raised now would go (plan() without recording anything). */
  route(): AlertRoute;
  /** Shows a built notice (show() builds it from the alert). */
  showNotice(notice: SystemNotice): Promise<boolean>;
  state(): NotifyState;
  subscribe(listener: () => void): () => void;
  /**
   * Asks for permission. Call it synchronously inside a tap: browsers only prompt for a user gesture.
   * Does nothing (resolves the current permission) when unsupported or already answered.
   */
  request(): Promise<NotifyPermission>;
}

function keyOf(shown: ShownNotificationLike): string | null {
  const data = shown.data as { key?: unknown } | null | undefined;
  return data && typeof data.key === 'string' ? data.key : null;
}

// ---------------------------------------------------------------------------------------------------
// Across tabs: never both (one browser, several app tabs or windows)
// ---------------------------------------------------------------------------------------------------
//
// Each tab has its own store, sync and `seen` set, so each raises the same alert on its own. With system
// notifications on, two records in localStorage keep one alert from showing as a toast in one tab and as a
// notification in another:
//   * FRONT_KEY {tab, until}: the app tab in front (visible, and focused on a desktop), refreshed while it
//     is. A background tab shows nothing while another tab holds it: that tab toasts the same alert from
//     its own sync (every 6 s in front). It expires on its own if the tab dies without pagehide.
//   * DELIVERED_KEY {key: until}: the (id, rowVersion) each tab delivered, for 10 minutes. A tab that
//     raises one of them later (it polled later, or came to the front since) shows nothing for it.

export const FRONT_KEY = 'lp-alerts-front';
export const DELIVERED_KEY = 'lp-alerts-delivered';
/** A front claim lasts this long unless refreshed (a tab that died without pagehide stops claiming). */
export const FRONT_TTL_MS = 30_000;
const FRONT_REFRESH_MS = 10_000;
/** Longer than a background tab's poll (60 s), even throttled. */
export const DELIVERED_TTL_MS = 10 * 60_000;
const DELIVERED_MAX = 300;

export interface PeerBoard {
  /** Another app tab of this browser holds a fresh front claim. */
  otherInFront(): boolean;
  /** Claims (or refreshes) the front for this tab, or releases this tab's claim. */
  setFront(front: boolean): void;
  /** A tab of this browser delivered this alert key in the last DELIVERED_TTL_MS. */
  delivered(key: string): boolean;
  markDelivered(keys: readonly string[]): void;
  /** Forgets the delivered keys and releases this tab's claim (sign-out, another staff). */
  clear(): void;
}

export function createPeerBoard(storage: () => StorageLike | null, tab: string, now: () => number): PeerBoard {
  const readJson = (key: string): unknown => {
    try {
      const raw = storage()?.getItem(key);
      return raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: unknown) => {
    try {
      storage()?.setItem(key, JSON.stringify(value));
    } catch {
      // Full or blocked: this tab decides alone, as before.
    }
  };
  const remove = (key: string) => {
    try {
      storage()?.removeItem(key);
    } catch {
      // blocked
    }
  };
  const claim = (): { tab: string; until: number } | null => {
    const c = readJson(FRONT_KEY) as { tab?: unknown; until?: unknown } | null;
    return c && typeof c.tab === 'string' && typeof c.until === 'number' ? { tab: c.tab, until: c.until } : null;
  };
  const deliveredMap = (): Record<string, number> => {
    const raw = readJson(DELIVERED_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const t = now();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'number' && v > t) out[k] = v;
    return out;
  };
  const releaseMine = () => {
    if (claim()?.tab === tab) remove(FRONT_KEY);
  };
  return {
    otherInFront() {
      const c = claim();
      return !!c && c.tab !== tab && c.until > now();
    },
    setFront(front) {
      if (front) write(FRONT_KEY, { tab, until: now() + FRONT_TTL_MS });
      else releaseMine();
    },
    delivered: (key) => key in deliveredMap(),
    markDelivered(keys) {
      if (keys.length === 0) return;
      const map = deliveredMap();
      const until = now() + DELIVERED_TTL_MS;
      for (const k of keys) map[k] = until;
      const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, DELIVERED_MAX);
      write(DELIVERED_KEY, Object.fromEntries(entries));
    },
    clear() {
      remove(DELIVERED_KEY);
      releaseMine();
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The notifier
// ---------------------------------------------------------------------------------------------------

export function createNotifySystem(host: NotifyHost): NotifySystem {
  let registration: RegistrationLike | null = null;
  let snapshot: NotifyState = NO_NOTIFY;
  let started = false;
  const listeners = new Set<() => void>();
  const board = createPeerBoard(() => host.storage(), uuid(), () => host.now());
  /** The store is signed in and alerting (setActive). */
  let active = false;
  /** pagehide: the page is going away (or into the bfcache), so it no longer claims the front. */
  let leaving = false;
  let claimTimer: ReturnType<typeof setInterval> | undefined;
  let checkSeq = 0;
  let checking = false;

  const read = (): NotifyState => {
    const n = host.notification();
    return notifyStateOf({ ...host.device(), hasNotification: n !== null, permission: n?.permission, registration: registration !== null });
  };
  const refresh = () => {
    const next = read();
    if (next.supported === snapshot.supported && next.permission === snapshot.permission) return;
    snapshot = next;
    for (const l of [...listeners]) l();
  };
  /** System notifications are on here: only then do this browser's tabs coordinate (toast-only tabs are as before). */
  const coordinated = () => snapshot.supported && snapshot.permission === 'granted';

  /** Claims the front while this tab is in front and alerting; releases it otherwise. */
  const updateClaim = () => {
    const front = active && !leaving && coordinated() && inFront(host.window());
    board.setFront(front);
    if (front && claimTimer === undefined) claimTimer = setInterval(updateClaim, FRONT_REFRESH_MS);
    if (!front && claimTimer !== undefined) {
      clearInterval(claimTimer);
      claimTimer = undefined;
    }
  };
  const sync = () => {
    refresh();
    updateClaim();
  };

  /** Reads the registration and asks its active worker whether it handles clicks (the latest check wins). */
  const checkWorker = () => {
    const ready = host.ready();
    if (!ready) return;
    const seq = ++checkSeq;
    checking = true;
    ready.then(
      async (r) => {
        let ok = false;
        try {
          ok = await host.handlesClicks(r);
        } catch {
          ok = false;
        }
        if (seq !== checkSeq) return;
        checking = false;
        registration = ok ? r : null;
        sync();
      },
      () => {
        if (seq === checkSeq) checking = false;
      },
    );
  };

  const start = () => {
    if (started) return;
    started = true;
    refresh();
    checkWorker();
    host.watch((event) => {
      if (event === 'pagehide') leaving = true;
      else if (event === 'pageshow') leaving = false;
      // A new worker took over, or an earlier check found none that handles clicks (it timed out, or an
      // older build's worker was active): ask again.
      if (event === 'controllerchange' || (registration === null && !checking && (event === 'focus' || event === 'visibilitychange'))) checkWorker();
      sync();
    });
  };

  const route = (): AlertRoute => {
    refresh();
    const win = host.window();
    return routeAlert(snapshot, win, !inFront(win) && board.otherInFront());
  };

  const showNotice = async (notice: SystemNotice): Promise<boolean> => {
    const r = registration;
    if (!r || read().permission !== 'granted') return false;
    if (notice.key && r.getNotifications) {
      try {
        const open = await r.getNotifications({ tag: notice.tag });
        // Another tab of this browser already showed this very change.
        if (open.some((n) => keyOf(n) === notice.key)) return true;
      } catch {
        // Only the dedupe is lost.
      }
    }
    try {
      await r.showNotification(notice.title, noticeOptions(notice));
      return true;
    } catch {
      return false;
    }
  };

  const closeWhere = (filter: { tag?: string } | undefined, match: (n: ShownNotificationLike) => boolean) => {
    const get = registration?.getNotifications?.bind(registration);
    if (!get) return;
    void get(filter).then(
      (list) => {
        for (const n of list) if (match(n)) n.close();
      },
      () => undefined,
    );
  };

  return {
    start,
    state: () => snapshot,
    subscribe(listener) {
      start();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request() {
      start();
      refresh();
      const n = host.notification();
      if (!n || !snapshot.supported || n.permission !== 'default') return Promise.resolve(snapshot.permission);
      return new Promise<NotifyPermission>((resolve) => {
        const done = () => {
          sync();
          resolve(snapshot.permission);
        };
        try {
          const asked = n.requestPermission();
          if (asked && typeof asked.then === 'function') asked.then(done, done);
          else done();
        } catch {
          done();
        }
      });
    },
    route,
    plan(keys) {
      const r = route();
      if (!coordinated() || r === 'none') return { route: r, skip: TOAST_PLAN.skip };
      const skip = new Set(keys.filter((k) => board.delivered(k)));
      // Recorded before anything is shown, so a tab raising the same keys a moment later already sees them.
      board.markDelivered(keys.filter((k) => !skip.has(k)));
      return { route: r, skip };
    },
    setActive(on) {
      active = on;
      updateClaim();
    },
    // The notice is built before anything is awaited, from the rows the store holds at this moment.
    show: (alert, rowOf, sources) => showNotice(systemNotice(alert, rowOf, sources)),
    showNotice,
    close(requestId, key) {
      closeWhere({ tag: requestTag(requestId) }, (n) => key === undefined || key === null || keyOf(n) === key);
    },
    closeAll() {
      closeWhere(undefined, () => true);
      board.clear();
    },
  };
}

/** The message public/sw.js answers with {notificationClick: true} (a worker of an older build never does). */
export const CAPS_MESSAGE = 'lp-caps';
/** How long the active worker may take to answer (it may have to start up first). */
export const CAPS_REPLY_MS = 5_000;

/** Asks `worker` for {type: 'lp-caps'}; true once it says it handles notification clicks. */
export function askWorkerCaps(worker: WorkerLike | null | undefined, timeoutMs = CAPS_REPLY_MS): Promise<boolean> {
  if (!worker || typeof MessageChannel === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const done = (ok: boolean) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent<{ notificationClick?: unknown } | null>) => done(event.data?.notificationClick === true);
    try {
      worker.postMessage({ type: CAPS_MESSAGE }, [channel.port2]);
    } catch {
      done(false);
    }
  });
}

/** The real browser. Only called on the client. */
export function browserNotifyHost(): NotifyHost {
  return {
    notification: () => {
      const w = window as unknown as { Notification?: NotificationLike };
      return 'Notification' in window && w.Notification ? w.Notification : null;
    },
    ready: () => ('serviceWorker' in navigator ? (navigator.serviceWorker.ready as unknown as Promise<RegistrationLike>) : null),
    handlesClicks: (registration) => askWorkerCaps(registration.active),
    device: () => {
      const nav = navigator as Navigator & { standalone?: boolean };
      return {
        userAgent: nav.userAgent ?? '',
        platform: nav.platform ?? '',
        maxTouchPoints: nav.maxTouchPoints ?? 0,
        standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
      };
    },
    window: () => ({
      hidden: document.visibilityState === 'hidden',
      focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
      desktop: window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true,
    }),
    watch(onChange) {
      const offs: Array<() => void> = [];
      const on = (target: EventTarget, type: string, event: HostEvent) => {
        const handler = () => onChange(event);
        target.addEventListener(type, handler);
        offs.push(() => target.removeEventListener(type, handler));
      };
      on(window, 'focus', 'focus');
      on(window, 'blur', 'blur');
      on(window, 'pagehide', 'pagehide');
      on(window, 'pageshow', 'pageshow');
      on(document, 'visibilitychange', 'visibilitychange');
      if ('serviceWorker' in navigator) on(navigator.serviceWorker, 'controllerchange', 'controllerchange');
      // Chrome and Firefox report a change made in the browser's site settings.
      navigator.permissions?.query({ name: 'notifications' as PermissionName }).then(
        (status) => on(status, 'change', 'permission'),
        () => undefined,
      );
      return () => offs.splice(0).forEach((off) => off());
    },
    storage: () => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
}

const NULL_SYSTEM: NotifySystem = {
  start: () => undefined,
  state: () => NO_NOTIFY,
  subscribe: () => () => undefined,
  request: () => Promise.resolve('default'),
  route: () => 'toast',
  plan: () => TOAST_PLAN,
  setActive: () => undefined,
  show: () => Promise.resolve(false),
  showNotice: () => Promise.resolve(false),
  close: () => undefined,
  closeAll: () => undefined,
};

let shared: NotifySystem | null = null;

/** The page's one notifier (a no-op on the server). */
export function notifySystem(): NotifySystem {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return NULL_SYSTEM;
  shared ??= createNotifySystem(browserNotifyHost());
  return shared;
}

const serverState = () => NO_NOTIFY;

/** System notification support and permission, live (the avatar menu and the "Alerts are on" sheet). */
export function useNotifyState(): NotifyState {
  const system = notifySystem();
  return useSyncExternalStore(system.subscribe, system.state, serverState);
}

/** Ask for permission from a tap; a no-op where unsupported or already answered. */
export function askNotifyPermission(): Promise<NotifyPermission> {
  return notifySystem().request();
}

// ---------------------------------------------------------------------------------------------------
// Notification clicks (the page side of public/sw.js notificationclick)
// ---------------------------------------------------------------------------------------------------

/** The message public/sw.js posts when a notification is clicked. */
export const OPEN_MESSAGE = 'lp-open';

/**
 * Open `url` (a path + query of `/`, e.g. "/?r=<id>") as an in-app view. False when it is not a view of
 * this page (another origin or path): the worker then navigates the window.
 */
export function openFromNotification(url: string): boolean {
  if (typeof window === 'undefined') return false;
  let target: URL;
  try {
    target = new URL(url, window.location.origin);
  } catch {
    return false;
  }
  if (target.origin !== window.location.origin || target.pathname !== '/') return false;
  const params = viewToParams(parseView(target.searchParams));
  // Already showing it: no second history entry (Back would land on the same view).
  if (hrefFor(params) === `${window.location.pathname}${window.location.search}`) return true;
  navigate(params);
  return true;
}

/** Answers the worker's {type: 'lp-open', url} messages. Returns the remover. */
export function listenForNotificationOpens(
  container: Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>,
  open: (url: string) => boolean = openFromNotification,
): () => void {
  const onMessage = (event: Event) => {
    const { data, ports } = event as MessageEvent<{ type?: unknown; url?: unknown } | null>;
    if (!data || data.type !== OPEN_MESSAGE || typeof data.url !== 'string') return;
    let ok = false;
    try {
      ok = open(data.url);
    } catch {
      ok = false;
    }
    try {
      ports?.[0]?.postMessage({ ok });
    } catch {
      // The worker stopped waiting.
    }
  };
  container.addEventListener('message', onMessage);
  return () => container.removeEventListener('message', onMessage);
}

let opensInstalled = false;

/**
 * The store's entry point (loaded with import() after start): the page's notifier, started, and the
 * notification-click listener, installed once for the page's lifetime.
 */
export function startNotify(): NotifySystem {
  const system = notifySystem();
  system.start();
  if (!opensInstalled && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    opensInstalled = true;
    listenForNotificationOpens(navigator.serviceWorker);
  }
  return system;
}

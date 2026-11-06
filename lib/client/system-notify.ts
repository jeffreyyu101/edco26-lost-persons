// System notifications for alerts (spec §7 Alerts, v2.5 A52; Brian 2026-11-06: "alerts should depend on the
// device — if it's desktop use regular notifications through Chrome"). No server part: no Web Push, no
// VAPID. The page that raised an alert shows it through its own service worker registration, so it works
// only while the app is open (a background tab or a minimised window included).
//
//   * Supported: 'Notification' in window, an active service worker registration, and not a Safari tab on
//     iPhone or iPad (there only a Home Screen app may notify, iOS 16.4+; the tab never prompts). That
//     covers desktop Chrome / Edge / Firefox, Safari on macOS, Android Chrome and the iPhone Home Screen
//     app. Always registration.showNotification(), never `new Notification()` (Android Chrome throws).
//   * Permission is asked only inside a tap: turning Alerts on, or "Allow notifications" (menu and sheet).
//     Denied is shown quietly ("Blocked in browser") and never asked again by the app.
//   * Delivery (routeAlert): permission granted and the page hidden, or a desktop window without focus →
//     a system notification; otherwise the in-app toast + chime as before. Never both for one alert.
//   * One notification per request (tag = request id): a later alert for it replaces the earlier one, and
//     the store closes one whose alert is out of date (alerts.ts alertStillCurrent). 3+ at once are one
//     notification ("3 new requests"), like the toast. Another tab that already showed the same
//     (id, rowVersion) is not shown twice.
//   * Content: the LP number, "New request" or the status, initials and the post. Never a phone number or
//     any other contact detail: it lands on the lock screen and in the notification centre.
import { useSyncExternalStore } from 'react';
import type { RequestSummary } from '../api-types';
import { initials, statusMeta } from '../domain';
import { formatCaseNumber } from '../format';
import { alertKey } from './alerts';
import { hrefFor } from './nav';
import type { AlertEvent } from './store-contract';

export type NotifyPermission = 'default' | 'granted' | 'denied';
export type AlertRoute = 'system' | 'toast';

export interface NotifyState {
  /** System notifications can be shown on this device (see the header). */
  supported: boolean;
  permission: NotifyPermission;
}

/** The server render, and every device without system notifications. */
export const NO_NOTIFY: Readonly<NotifyState> = Object.freeze({ supported: false, permission: 'default' });

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
  /** An active service worker registration (registration.showNotification needs one). */
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

/** Where an alert raised now goes: a system notification, or the in-app toast + chime. */
export function routeAlert(state: NotifyState, win: WindowInfo): AlertRoute {
  if (!state.supported || state.permission !== 'granted') return 'toast';
  return win.hidden || (win.desktop && !win.focused) ? 'system' : 'toast';
}

/** What a system notification shows, and what a click on it opens. */
export interface SystemNotice {
  title: string;
  body: string;
  /** The request id (one notification per request), or COMBINED_TAG. */
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
  if (!row) return { title: alert.title, body: '', tag: id, url, key: null, requireInteraction };
  const lp = formatCaseNumber(row.caseNumber);
  const title = alert.kind === 'new_request' ? `New request · ${lp}` : `${lp} · ${statusMeta(row.status).shortLabel}`;
  const body = alert.kind === 'in_medical' ? [who(row), 'Bring the friend to Main Med'].filter(Boolean).join('\n') : who(row);
  return { title, body, tag: id, url, key: alertKey(row), requireInteraction };
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

export interface RegistrationLike {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
  getNotifications?(filter?: { tag?: string }): Promise<readonly ShownNotificationLike[]>;
}

/** What the notifier reads from the browser (tests pass a fake). */
export interface NotifyHost {
  /** window.Notification, or null when the browser has none. */
  notification(): NotificationLike | null;
  /** navigator.serviceWorker.ready, or null without service workers. */
  ready(): Promise<RegistrationLike> | null;
  device(): Pick<DeviceInfo, 'userAgent' | 'platform' | 'maxTouchPoints' | 'standalone'>;
  window(): WindowInfo;
  /** Calls `onChange` when the permission may have changed. Returns the remover. */
  watch(onChange: () => void): () => void;
}

/** What the store uses to deliver alerts (StoreEnv.notifier). */
export interface AlertNotifier {
  route(): AlertRoute;
  /** Shows it; false when it could not be shown (the store then toasts it). */
  show(notice: SystemNotice): Promise<boolean>;
  /** Closes the notification with this tag (only the one of `key`, when given). */
  close(tag: string, key?: string | null): void;
  /** Closes every notification of the app (sign-out, another staff signed in). */
  closeAll(): void;
}

export interface NotifySystem extends AlertNotifier {
  /** Starts reading the registration and watching the permission (idempotent). */
  start(): void;
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

export function createNotifySystem(host: NotifyHost): NotifySystem {
  let registration: RegistrationLike | null = null;
  let snapshot: NotifyState = NO_NOTIFY;
  let started = false;
  const listeners = new Set<() => void>();

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

  const start = () => {
    if (started) return;
    started = true;
    refresh();
    host.ready()?.then(
      (r) => {
        registration = r;
        refresh();
      },
      () => undefined,
    );
    host.watch(refresh);
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
          refresh();
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
    route() {
      refresh();
      return routeAlert(snapshot, host.window());
    },
    async show(notice) {
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
    },
    close(tag, key) {
      closeWhere({ tag }, (n) => key === undefined || key === null || keyOf(n) === key);
    },
    closeAll() {
      closeWhere(undefined, () => true);
    },
  };
}

/** The real browser. Only called on the client. */
export function browserNotifyHost(): NotifyHost {
  return {
    notification: () => {
      const w = window as unknown as { Notification?: NotificationLike };
      return 'Notification' in window && w.Notification ? w.Notification : null;
    },
    ready: () => ('serviceWorker' in navigator ? (navigator.serviceWorker.ready as Promise<RegistrationLike>) : null),
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
      const on = (target: EventTarget, type: string) => {
        target.addEventListener(type, onChange);
        offs.push(() => target.removeEventListener(type, onChange));
      };
      on(window, 'focus');
      on(document, 'visibilitychange');
      // Chrome and Firefox report a change made in the browser's site settings.
      navigator.permissions?.query({ name: 'notifications' as PermissionName }).then(
        (status) => on(status, 'change'),
        () => undefined,
      );
      return () => offs.splice(0).forEach((off) => off());
    },
  };
}

const NULL_SYSTEM: NotifySystem = {
  start: () => undefined,
  state: () => NO_NOTIFY,
  subscribe: () => () => undefined,
  request: () => Promise.resolve('default'),
  route: () => 'toast',
  show: () => Promise.resolve(false),
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

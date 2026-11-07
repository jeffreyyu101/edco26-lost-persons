// This device's Web Push subscription and the Alerts switches (F4, spec §18 A54–A55, A58). Loaded with
// import() (the Activity host, the banner, the Alerts sheet), so it costs nothing on the first load.
//
// Lifecycle:
//   * start(staff): asks the server whether push is on and for the switches (POST /api/push/prefs), checks
//     that the active service worker shows pushes ({type: 'lp-caps'} → push: true; an older build's worker
//     does not, and a push it got would show nothing), then ensure().
//   * ensure(): with permission granted, makes sure this browser holds a subscription for the server's
//     current key (a changed key → unsubscribe and subscribe again) and tells the server once per page load
//     and staff member (POST /api/push/subscribe), which re-binds the device to whoever is signed in. A
//     rotated endpoint is sent with the old one (oldEndpoint), which the server drops.
//   * turnOn(): "Turn on" in the banner or the sheet. pushManager.subscribe() is called synchronously in the
//     tap (it asks for permission where needed; iPhone and Safari only ask from a tap).
//   * The permission is read again on focus and visibilitychange (and the Permissions API change event):
//     revoked later → not subscribed → the banner returns.
//   * Sign-out: beforeSignOut() has the server forget the subscription (DELETE, while the session still says
//     whose it is); afterSignOut(true), once the sign-out is confirmed, drops it in the browser and forgets the
//     staff member. afterSignOut(false), a sign-out that did not happen (offline, 5xx), keeps it and tells the
//     server again, so the device never silently loses its alerts. onSessionEnded() (a 401): the browser
//     drops it. Both clear the app icon badge.
//   * The store reaches the page's client through lib/client/f4-bridge.ts (pushHooksFor): whether the push
//     carries an alert (no double alerts, A54), and sign-out / 401, bounded and never rejecting.
// Never logs anything.
import { useSyncExternalStore } from 'react';
import type { PushConfigResponse, PushTestResponse } from '../activity';
import {
  alertsStatus,
  detectPlatform,
  type AlertsStatus,
  type DeviceSignals,
  type Permission,
  type Platform,
} from './alerts-platform';
import { readPrefs } from './prefs';
import { registerPushHooks, type ApiRequest, type PushHooks } from './f4-bridge';
import type { AlertEvent } from './store-contract';
import { viaStore } from './via-store';

export interface SubscriptionLike {
  readonly endpoint: string;
  readonly options?: { applicationServerKey?: ArrayBuffer | null } | null;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

export interface PushRegistrationLike {
  readonly active?: { postMessage(message: unknown, transfer?: unknown[]): void } | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What the push client reads from the browser (tests pass a fake). */
export interface PushHost {
  device(): DeviceSignals;
  hasServiceWorker(): boolean;
  hasPushManager(): boolean;
  hasNotification(): boolean;
  permission(): Permission;
  requestPermission(): Promise<Permission>;
  /** navigator.serviceWorker.ready, or null without service workers. */
  ready(): Promise<PushRegistrationLike> | null;
  /** The active worker shows pushes (it answers lp-caps with push: true). */
  workerShowsPush(registration: PushRegistrationLike): Promise<boolean>;
  getSubscription(registration: PushRegistrationLike): Promise<SubscriptionLike | null>;
  subscribe(registration: PushRegistrationLike, applicationServerKey: Uint8Array): Promise<SubscriptionLike>;
  /** The store's door to the API (lib/client/f4-bridge.ts storeApi). */
  request: ApiRequest;
  storage(): StorageLike | null;
  /** Calls back on focus / visibilitychange / permission change. Returns the remover. */
  watch(onChange: () => void): () => void;
  /** The app icon badge (navigator.setAppBadge / clearAppBadge), best effort. */
  setBadge(count: number): void;
}

export interface AlertPrefs {
  newRequests: boolean;
  myUpdates: boolean;
}

export interface AlertsState {
  status: AlertsStatus;
  platform: Platform | null;
  permission: Permission;
  subscribed: boolean;
  /** The switches (server-side), once read. */
  prefs: AlertPrefs | null;
  /** Turn on / a test alert / a switch is on its way. */
  busy: boolean;
  /** The last Turn on or test alert failed (shown in the sheet). */
  error: 'failed' | null;
  /** The last test alert reached the push service. */
  tested: boolean;
}

export const INITIAL_ALERTS: Readonly<AlertsState> = Object.freeze({
  status: 'checking',
  platform: null,
  permission: 'default',
  subscribed: false,
  prefs: null,
  busy: false,
  error: null,
  tested: false,
});

/** The endpoint the server last confirmed for this device (rotation is sent with the old one). */
export const ENDPOINT_KEY = 'lp-push-endpoint';
const TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 10_000;

/** base64url → bytes (the VAPID public key). */
export function keyBytes(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64Url.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** The subscription was made with this key (a missing key on the subscription counts as the same). */
export function sameKey(subscription: SubscriptionLike, key: Uint8Array): boolean {
  const have = subscription.options?.applicationServerKey;
  if (!have) return true;
  const a = new Uint8Array(have);
  if (a.length !== key.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== key[i]) return false;
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(timer));
}

export interface PushClient {
  start(staff: string): void;
  getState(): AlertsState;
  subscribe(listener: () => void): () => void;
  /** Call synchronously inside the tap. */
  turnOn(): Promise<void>;
  /** The blocked banner's re-check, and focus / visibility. */
  recheck(): void;
  setPrefs(change: Partial<AlertPrefs>): Promise<boolean>;
  sendTest(): Promise<boolean>;
  /** Before a sign-out (the session is still there): the server forgets this device. */
  beforeSignOut(): Promise<void>;
  /** Confirmed: the browser drops the subscription. Not confirmed: the server is told about it again. */
  afterSignOut(confirmed: boolean): Promise<void>;
  onSessionEnded(): Promise<void>;
}

export function createPushClient(host: PushHost): PushClient {
  let state: AlertsState = INITIAL_ALERTS;
  const listeners = new Set<() => void>();
  let staff: string | null = null;
  let epoch = 0;
  let configured: boolean | null = null;
  let publicKey: string | null = null;
  let registration: PushRegistrationLike | null = null;
  let workerReady: boolean | null = null;
  let told = false;
  let telling: Promise<void> | null = null;
  let unwatch: (() => void) | null = null;
  let endpointRefused = false;
  /** beforeSignOut's DELETE may have reached the server (the sign-out may still fail). */
  let forgotten = false;

  const platform = (): Platform => detectPlatform(host.device());

  const compute = (patch: Partial<AlertsState> = {}) => {
    const next = { ...state, ...patch };
    const p = next.platform ?? platform();
    const status: AlertsStatus = endpointRefused
      ? 'unsupported'
      : alertsStatus({
          platform: p,
          pushConfigured: configured,
          hasServiceWorker: host.hasServiceWorker(),
          hasPushManager: host.hasPushManager(),
          hasNotification: host.hasNotification(),
          workerReady,
          permission: next.permission,
          subscribed: next.subscribed,
        });
    state = { ...next, platform: p, status };
    for (const l of [...listeners]) l();
  };

  const storage = () => host.storage();
  const storedEndpoint = (): string | null => {
    try {
      return storage()?.getItem(ENDPOINT_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const storeEndpoint = (endpoint: string | null) => {
    try {
      if (endpoint) storage()?.setItem(ENDPOINT_KEY, endpoint);
      else storage()?.removeItem(ENDPOINT_KEY);
    } catch {
      // private mode: rotation is still caught by the server (the old row fails and is pruned)
    }
  };

  const applyConfig = (data: PushConfigResponse) => {
    configured = data.enabled === true;
    publicKey = typeof data.publicKey === 'string' && data.publicKey ? data.publicKey : null;
    if (!publicKey) configured = false;
    return { newRequests: data.newRequests === true, myUpdates: data.myUpdates !== false };
  };

  /** Tells the server about `sub` (once per page load and staff member, or when the endpoint changed). */
  const tell = async (sub: SubscriptionLike, gen: number): Promise<boolean> => {
    const json = sub.toJSON();
    const keys = json.keys ?? {};
    if (!json.endpoint || !keys.p256dh || !keys.auth) return false;
    const old = storedEndpoint();
    const res = await host.request<PushConfigResponse>('/api/push/subscribe', {
      method: 'POST',
      json: {
        endpoint: json.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        ...(old && old !== json.endpoint ? { oldEndpoint: old } : {}),
        bell: readPrefs().bell,
      },
      timeoutMs: TIMEOUT_MS,
    });
    if (gen !== epoch) return false;
    if (!res.ok) {
      if (res.kind === 'http' && res.status === 422) {
        // A push service the server does not post to: alerts can't work here (no banner).
        endpointRefused = true;
        compute({ subscribed: false });
      }
      return false;
    }
    const prefs = applyConfig(res.data);
    if (!configured) {
      compute({ subscribed: false, prefs });
      return false;
    }
    storeEndpoint(json.endpoint);
    told = true;
    compute({ subscribed: true, prefs });
    return true;
  };

  /** With permission granted: a subscription for the current key, and the server knows it. */
  const ensure = async (gen: number): Promise<void> => {
    if (!configured || !registration || workerReady !== true || !publicKey || !staff) return;
    const permission = host.permission();
    if (permission !== 'granted') {
      if (state.subscribed || state.permission !== permission) compute({ permission, subscribed: false });
      return;
    }
    const key = keyBytes(publicKey);
    let sub: SubscriptionLike | null = null;
    try {
      sub = await host.getSubscription(registration);
      if (sub && !sameKey(sub, key)) {
        await sub.unsubscribe().catch(() => false);
        sub = null;
      }
      if (!sub) sub = await host.subscribe(registration, key);
    } catch {
      sub = null;
    }
    if (gen !== epoch) return;
    if (!sub) {
      compute({ permission: host.permission(), subscribed: false });
      return;
    }
    const known = storedEndpoint() === sub.endpoint;
    if (told && known && state.subscribed) {
      compute({ permission });
      return;
    }
    await tell(sub, gen);
  };

  const runEnsure = (gen: number) => {
    if (telling) return telling;
    telling = ensure(gen).finally(() => {
      telling = null;
    });
    return telling;
  };

  const loadConfig = async (gen: number): Promise<void> => {
    const res = await host.request<PushConfigResponse>('/api/push/prefs', {
      method: 'POST',
      json: { bell: readPrefs().bell },
      timeoutMs: TIMEOUT_MS,
    });
    if (gen !== epoch || !res.ok) return;
    const prefs = applyConfig(res.data);
    compute({ prefs });
  };

  const loadWorker = async (gen: number): Promise<void> => {
    if (!host.hasServiceWorker() || !host.hasPushManager()) return;
    const ready = host.ready();
    if (!ready) return;
    const reg = await withTimeout(ready, READY_TIMEOUT_MS);
    if (gen !== epoch || !reg) return;
    registration = reg;
    let ok = false;
    try {
      ok = await host.workerShowsPush(reg);
    } catch {
      ok = false;
    }
    if (gen !== epoch) return;
    workerReady = ok;
    compute();
  };

  const recheck = () => {
    if (!staff) return;
    const permission = host.permission();
    if (permission !== state.permission) compute({ permission, ...(permission === 'granted' ? {} : { subscribed: false }) });
    // Allowed again in the site settings, or the worker updated since: try again.
    if (configured === null) void loadConfig(epoch).then(() => runEnsure(epoch));
    else if (workerReady !== true) void loadWorker(epoch).then(() => runEnsure(epoch));
    else if (permission === 'granted' && !endpointRefused && (!state.subscribed || !told)) void runEnsure(epoch);
  };

  const reset = () => {
    epoch += 1;
    staff = null;
    told = false;
    endpointRefused = false;
    configured = null;
    publicKey = null;
    state = { ...INITIAL_ALERTS };
    host.setBadge(0);
    for (const l of [...listeners]) l();
  };

  const browserSubscription = async (): Promise<SubscriptionLike | null> => {
    let reg = registration;
    if (!reg) {
      const ready = host.ready();
      reg = ready ? await withTimeout(ready, 1_500) : null;
    }
    return reg ? await host.getSubscription(reg).catch(() => null) : null;
  };

  const dropBrowserSubscription = async () => {
    const sub = await browserSubscription();
    if (sub) await sub.unsubscribe().catch(() => false);
    storeEndpoint(null);
  };

  return {
    start(next) {
      if (staff === next) return;
      if (staff !== null) reset();
      staff = next;
      const gen = ++epoch;
      told = false;
      compute({ platform: platform(), permission: host.permission() });
      unwatch ??= host.watch(() => recheck());
      void Promise.all([loadConfig(gen), loadWorker(gen)]).then(() => runEnsure(gen));
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    turnOn() {
      const gen = epoch;
      const reg = registration;
      const key = publicKey;
      // Synchronously, inside the tap: subscribe() asks for permission where it has not been answered.
      let subscribing: Promise<SubscriptionLike | null>;
      if (reg && key && host.hasPushManager()) {
        try {
          subscribing = host.subscribe(reg, keyBytes(key)).catch(() => null);
        } catch {
          subscribing = Promise.resolve(null);
        }
      } else {
        subscribing = host.requestPermission().then(() => null, () => null);
      }
      compute({ busy: true, error: null });
      return subscribing.then(async (sub) => {
        if (gen !== epoch) return;
        const permission = host.permission();
        if (sub) {
          told = false;
          const ok = await tell(sub, gen);
          if (gen !== epoch) return;
          compute({ permission, busy: false, error: ok ? null : 'failed' });
          return;
        }
        if (permission === 'granted') await runEnsure(gen);
        if (gen !== epoch) return;
        compute({ permission, busy: false, error: permission === 'denied' || state.subscribed ? null : 'failed' });
      });
    },
    recheck,
    async setPrefs(change) {
      const before = state.prefs;
      if (!before) return false;
      const gen = epoch;
      compute({ prefs: { ...before, ...change } });
      const res = await host.request<PushConfigResponse>('/api/push/prefs', { method: 'POST', json: change, timeoutMs: TIMEOUT_MS });
      if (gen !== epoch) return false;
      if (!res.ok) {
        compute({ prefs: before });
        return false;
      }
      compute({ prefs: applyConfig(res.data) });
      return true;
    },
    async sendTest() {
      const reg = registration;
      if (!reg || !state.subscribed) return false;
      const gen = epoch;
      compute({ busy: true, error: null, tested: false });
      const sub = await host.getSubscription(reg).catch(() => null);
      const res = sub
        ? await host.request<PushTestResponse>('/api/push/test', { method: 'POST', json: { endpoint: sub.endpoint }, timeoutMs: TIMEOUT_MS })
        : null;
      if (gen !== epoch) return false;
      const sent = !!res && res.ok && res.data.sent === true;
      compute({ busy: false, error: sent ? null : 'failed', tested: sent });
      // The push service no longer knows this device: subscribe again.
      if (!sent && res && !res.ok && res.kind === 'http' && res.status === 404) {
        told = false;
        compute({ subscribed: false });
        void runEnsure(gen);
      }
      return sent;
    },
    async beforeSignOut() {
      forgotten = false;
      const sub = await browserSubscription();
      if (!sub) return;
      const res = await host.request('/api/push/subscribe', { method: 'DELETE', json: { endpoint: sub.endpoint }, timeoutMs: 2_500 });
      // Only a request that never left (offline) certainly changed nothing on the server.
      forgotten = res.ok || res.kind !== 'network';
    },
    async afterSignOut(confirmed) {
      if (confirmed) {
        forgotten = false;
        try {
          await dropBrowserSubscription();
        } finally {
          reset();
        }
        return;
      }
      // The session goes on: so do this device's alerts. The server is told again where it may have forgotten
      // them; if that fails too, the device counts as not subscribed (the page's own notifications stand in,
      // covers() is false) until focus / online / visibility tries again (recheck).
      if (!forgotten || !staff) return;
      forgotten = false;
      told = false;
      const gen = epoch;
      await runEnsure(gen);
      if (gen === epoch && !told) compute({ subscribed: false });
    },
    async onSessionEnded() {
      try {
        await dropBrowserSubscription();
      } finally {
        reset();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------------

export const CAPS_MESSAGE = 'lp-caps';

/** Asks the active worker whether it shows pushes ({type: 'lp-caps'} → {push: true}). */
export function askWorkerPush(worker: { postMessage(message: unknown, transfer?: unknown[]): void } | null | undefined, timeoutMs = 5_000): Promise<boolean> {
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
    channel.port1.onmessage = (event: MessageEvent<{ push?: unknown } | null>) => done(event.data?.push === true);
    try {
      worker.postMessage({ type: CAPS_MESSAGE }, [channel.port2]);
    } catch {
      done(false);
    }
  });
}

const normalizePermission = (value: unknown): Permission => (value === 'granted' || value === 'denied' ? value : 'default');

export function browserPushHost(): PushHost {
  const sw = () => navigator.serviceWorker;
  return {
    device: () => {
      const nav = navigator as Navigator & { standalone?: boolean };
      return {
        userAgent: nav.userAgent ?? '',
        platform: nav.platform ?? '',
        maxTouchPoints: nav.maxTouchPoints ?? 0,
        standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
      };
    },
    hasServiceWorker: () => 'serviceWorker' in navigator,
    hasPushManager: () => 'PushManager' in window,
    hasNotification: () => 'Notification' in window,
    permission: () => ('Notification' in window ? normalizePermission(window.Notification.permission) : 'default'),
    requestPermission: async () => {
      if (!('Notification' in window)) return 'default';
      try {
        return normalizePermission(await window.Notification.requestPermission());
      } catch {
        return normalizePermission(window.Notification.permission);
      }
    },
    ready: () => ('serviceWorker' in navigator ? (sw().ready as Promise<PushRegistrationLike>) : null),
    workerShowsPush: (registration) => askWorkerPush(registration.active),
    getSubscription: (registration) => (registration as unknown as ServiceWorkerRegistration).pushManager.getSubscription() as Promise<SubscriptionLike | null>,
    subscribe: (registration, applicationServerKey) =>
      (registration as unknown as ServiceWorkerRegistration).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as BufferSource,
      }) as Promise<SubscriptionLike>,
    request: viaStore,
    storage: () => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    },
    watch(onChange) {
      const offs: Array<() => void> = [];
      const on = (target: EventTarget, type: string) => {
        target.addEventListener(type, onChange);
        offs.push(() => target.removeEventListener(type, onChange));
      };
      on(window, 'focus');
      on(window, 'online');
      on(document, 'visibilitychange');
      if ('serviceWorker' in navigator) on(sw(), 'controllerchange');
      navigator.permissions?.query({ name: 'notifications' as PermissionName }).then(
        (status) => on(status, 'change'),
        () => undefined,
      );
      return () => offs.splice(0).forEach((off) => off());
    },
    setBadge(count) {
      const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      try {
        if (count > 0) void nav.setAppBadge?.(count)?.catch(() => undefined);
        else void nav.clearAppBadge?.()?.catch(() => undefined);
      } catch {
        // best effort
      }
    },
  };
}

let shared: PushClient | null = null;

/** The page's one push client. */
export function pushClient(): PushClient {
  shared ??= createPushClient(browserPushHost());
  return shared;
}

/** How long a sign-out waits for this device to stop its pushes before it goes on regardless. */
export const SIGN_OUT_WAIT_MS = 3_000;

/**
 * The page's own alert kinds whose events the server pushes in this build: every answer and status change.
 * Both Not found answers are pushed by the stage release (F5, lib/server/stage-notify.ts): the final one is the
 * page's 'not_in_medical', the "Not found yet" hold its 'status_changed' (alerts.ts holdAlert). A combined
 * alert ("3 new requests") is split before it is asked. Message alerts are toasts only (never a system
 * notification), so they are not listed.
 */
export const PUSHED_ALERT_KINDS: ReadonlySet<AlertEvent['kind']> = new Set<AlertEvent['kind']>(['in_medical', 'not_in_medical', 'reunited', 'new_request', 'status_changed']);

/**
 * The push carries this alert on this device: subscribed (the server confirmed it), the server pushes the
 * kind, and the staff member's switch for it is on ("New requests" for a new request, "Updates on my
 * requests" for the rest). Otherwise the page notifies as before (v2.5 A52).
 */
export function pushCovers(state: Pick<AlertsState, 'subscribed' | 'prefs'>, kind: AlertEvent['kind']): boolean {
  if (!state.subscribed || !state.prefs || !PUSHED_ALERT_KINDS.has(kind)) return false;
  return kind === 'new_request' ? state.prefs.newRequests : state.prefs.myUpdates;
}

const bounded = (work: Promise<void>, waitMs: number): Promise<void> =>
  Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);

/** What the store asks of a push client (lib/client/f4-bridge.ts), never rejecting and bounded in time. */
export function pushHooksFor(client: () => PushClient, waitMs = SIGN_OUT_WAIT_MS): PushHooks {
  return {
    covers: (kind) => pushCovers(client().getState(), kind),
    beforeSignOut: () => bounded(client().beforeSignOut(), waitMs),
    afterSignOut: (confirmed) => bounded(client().afterSignOut(confirmed), waitMs),
    onSessionEnded: () => void client().onSessionEnded().catch(() => undefined),
  };
}

if (typeof window !== 'undefined') registerPushHooks(pushHooksFor(pushClient));

const serverState = () => INITIAL_ALERTS;

export function useAlerts(): AlertsState {
  const client = pushClient();
  return useSyncExternalStore(client.subscribe, client.getState, serverState);
}

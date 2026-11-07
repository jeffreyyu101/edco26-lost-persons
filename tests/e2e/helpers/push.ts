// A fake Web Push for e2e (F4): Notification.permission and requestPermission, PushManager.subscribe /
// getSubscription (a fake subscription whose endpoint is a dead local port the test server accepts because
// .env.test sets LP_PUSH_ALLOW_LOCAL=1), and the Home Screen display mode. The real service worker of this
// build still answers lp-caps (push: true), so the app's own checks run unchanged.
import type { BrowserContext, Page } from '@playwright/test';

export interface FakePushOptions {
  /** Notification.permission at load. */
  permission: 'default' | 'granted' | 'denied';
  /** What the person answers when asked. */
  answer?: 'granted' | 'denied';
  /** Running as a Home Screen / installed app. */
  standalone?: boolean;
  /** No Web Push in this browser (no PushManager). */
  noPush?: boolean;
  /** The browser already holds a subscription (permission granted earlier). */
  subscribed?: boolean;
}

export interface FakePushState {
  perm: string;
  subscribeCalls: number;
  endpoint: string | null;
}

declare global {
  interface Window {
    __fakePush: { perm: string; answer: string; subscribeCalls: number; sub: unknown; endpoint: string | null };
  }
}

export async function fakePush(context: BrowserContext, options: FakePushOptions): Promise<void> {
  await context.addInitScript((o: FakePushOptions) => {
    const w = window as unknown as Record<string, unknown> & Window;
    // A permission given in an earlier page of this context stays given (as in a browser).
    let savedPerm: string | null = null;
    try {
      savedPerm = localStorage.getItem('lp-e2e-push-perm');
    } catch {
      savedPerm = null;
    }
    const state = { perm: savedPerm ?? (o.permission as string), answer: o.answer ?? 'granted', subscribeCalls: 0, sub: null as unknown, endpoint: null as string | null };
    const remember = () => {
      try {
        localStorage.setItem('lp-e2e-push-perm', state.perm);
      } catch {
        // ignore
      }
    };
    w.__fakePush = state;
    const make = (endpoint: string) => ({
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint, keys: { p256dh: 'BPe2eFakeDeviceKeyForTestsOnly0123456789', auth: 'e2eFakeAuth01' } }),
      unsubscribe: async () => {
        state.sub = null;
        state.endpoint = null;
        try {
          localStorage.removeItem('lp-e2e-push-endpoint');
        } catch {
          // ignore
        }
        return true;
      },
    });
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('lp-e2e-push-endpoint');
    } catch {
      saved = null;
    }
    if (o.subscribed || saved) {
      state.endpoint = saved ?? `https://127.0.0.1:9/e2e/${crypto.randomUUID()}`;
      state.sub = make(state.endpoint);
    }
    if (o.noPush) {
      delete (w as Record<string, unknown>).PushManager;
    } else {
      if (!('PushManager' in w)) (w as Record<string, unknown>).PushManager = function PushManager() {};
      const proto = (w.PushManager as unknown as { prototype: Record<string, unknown> }).prototype;
      proto.getSubscription = async () => state.sub;
      proto.subscribe = async () => {
        state.subscribeCalls += 1;
        if (state.perm === 'default') {
          state.perm = state.answer;
          remember();
        }
        if (state.perm !== 'granted') throw new DOMException('Permission denied', 'NotAllowedError');
        state.endpoint = `https://127.0.0.1:9/e2e/${crypto.randomUUID()}`;
        try {
          localStorage.setItem('lp-e2e-push-endpoint', state.endpoint);
        } catch {
          // ignore
        }
        state.sub = make(state.endpoint);
        return state.sub;
      };
      if (typeof ServiceWorkerRegistration !== 'undefined' && !('pushManager' in ServiceWorkerRegistration.prototype)) {
        const pm = Object.create(proto);
        Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { configurable: true, get: () => pm });
      }
    }
    if (typeof Notification !== 'undefined') {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => state.perm });
      Notification.requestPermission = (async () => {
        if (state.perm === 'default') {
          state.perm = state.answer;
          remember();
        }
        return state.perm as NotificationPermission;
      }) as typeof Notification.requestPermission;
    } else if (!o.noPush) {
      const N = function Notification() {} as unknown as Record<string, unknown>;
      Object.defineProperty(N, 'permission', { configurable: true, get: () => state.perm });
      N.requestPermission = async () => {
        if (state.perm === 'default') state.perm = state.answer;
        return state.perm;
      };
      (w as Record<string, unknown>).Notification = N;
    }
    if (o.standalone) {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q: string) => {
        if (/display-mode:\s*standalone/.test(q)) {
          const m = real('(min-width: 0px)');
          return Object.assign(Object.create(Object.getPrototypeOf(m) as object), m, { matches: true, media: q }) as MediaQueryList;
        }
        return real(q);
      };
    }
  }, options);
}

export const fakePushState = (page: Page): Promise<FakePushState> =>
  page.evaluate(() => ({ perm: window.__fakePush.perm, subscribeCalls: window.__fakePush.subscribeCalls, endpoint: window.__fakePush.endpoint }));

/** Waits until this build's service worker controls the page (the app's push checks need it). */
export async function workerReady(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
}

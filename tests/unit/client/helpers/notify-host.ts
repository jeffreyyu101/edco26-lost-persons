// A fake browser for lib/client/system-notify.ts: Notification and its permission prompt, the service
// worker registration (its notifications, and whether its active worker answers lp-caps), the window's
// visibility and focus, localStorage (shared by fake tabs of one browser) and a clock.
import type { HostEvent, NotifyHost, RegistrationLike, ShownNotificationLike, WindowInfo } from '@/lib/client/system-notify';
import { MemoryStorage } from './env';

export const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
};

export interface Shown extends ShownNotificationLike {
  title: string;
  tag: string;
  closed: boolean;
}

/** One origin's service worker registration: every tab of the browser shares it and its notifications. */
export function fakeRegistration() {
  const open: Shown[] = [];
  const shows: Array<{ title: string; options: NotificationOptions | undefined }> = [];
  let failShow = false;
  /** The active worker answers lp-caps (this build's worker); false: an older build's worker. */
  let clicks = true;
  const caps: unknown[] = [];
  const registration: RegistrationLike = {
    active: {
      postMessage: (message: unknown) => {
        caps.push(message);
      },
    },
    showNotification: async (title: string, options?: NotificationOptions) => {
      if (failShow) throw new TypeError('No active registration');
      shows.push({ title, options });
      const tag = options?.tag ?? '';
      for (const n of open.filter((x) => x.tag === tag)) open.splice(open.indexOf(n), 1);
      const n: Shown = { title, tag, data: options?.data, closed: false, close: () => ((n.closed = true), open.splice(open.indexOf(n), 1)) };
      open.push(n);
    },
    getNotifications: async (filter?: { tag?: string }) => open.filter((n) => !filter?.tag || n.tag === filter.tag),
  };
  return {
    registration,
    open,
    shows,
    /** lp-caps messages the pages sent. */
    caps,
    handlesClicks: () => clicks,
    setClicks: (v: boolean) => {
      clicks = v;
    },
    failShow: (v: boolean) => {
      failShow = v;
    },
  };
}

export type FakeRegistration = ReturnType<typeof fakeRegistration>;

export interface FakeHostOptions {
  permission?: string;
  /** What the prompt answers. */
  answer?: string;
  ua?: string;
  platform?: string;
  touch?: number;
  noNotification?: boolean;
  noWorker?: boolean;
  /** Shared with other fake tabs of the same browser. */
  registration?: FakeRegistration;
  storage?: MemoryStorage;
  /** The service worker is ready at once (default: when the test calls ready()). */
  readyNow?: boolean;
  window?: Partial<WindowInfo>;
}

export function fakeNotifyHost(opts: FakeHostOptions = {}) {
  let permission = opts.permission ?? 'default';
  let asked = 0;
  let win: WindowInfo = { hidden: false, focused: true, desktop: true, ...opts.window };
  const watchers = new Set<(event: HostEvent) => void>();
  const reg = opts.registration ?? fakeRegistration();
  const storage = opts.storage ?? new MemoryStorage();
  let resolveReady: () => void = () => undefined;
  const readyPromise = new Promise<RegistrationLike>((resolve) => {
    resolveReady = () => resolve(reg.registration);
  });
  if (opts.readyNow) resolveReady();
  let readyCalls = 0;
  const notification = {
    get permission() {
      return permission;
    },
    requestPermission: () => {
      asked += 1;
      permission = opts.answer ?? 'granted';
      return Promise.resolve(permission);
    },
  };
  const host: NotifyHost = {
    notification: () => (opts.noNotification ? null : notification),
    ready: () => {
      if (opts.noWorker) return null;
      readyCalls += 1;
      return readyPromise;
    },
    handlesClicks: async (r) => {
      r.active?.postMessage({ type: 'lp-caps' });
      return reg.handlesClicks();
    },
    device: () => ({ userAgent: opts.ua ?? UA.chromeMac, platform: opts.platform ?? 'MacIntel', maxTouchPoints: opts.touch ?? 0, standalone: false }),
    window: () => win,
    watch: (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    storage: () => storage,
    now: () => Date.now(),
  };
  return {
    host,
    reg,
    open: reg.open,
    shows: reg.shows,
    storage,
    asked: () => asked,
    readyCalls: () => readyCalls,
    /** The service worker becomes ready (and the lp-caps answer arrives). */
    ready: async () => {
      resolveReady();
      await flush();
    },
    setPermission: (p: string) => {
      permission = p;
    },
    /** Changes the window and tells the notifier, as the browser's focus / blur / visibilitychange would. */
    setWindow: async (patch: Partial<WindowInfo>, event: HostEvent = 'visibilitychange') => {
      win = { ...win, ...patch };
      for (const fn of [...watchers]) fn(event);
      await flush();
    },
    /** Changes the window without an event (the next route() reads it). */
    peekWindow: (patch: Partial<WindowInfo>) => {
      win = { ...win, ...patch };
    },
    fire: async (event: HostEvent) => {
      for (const fn of [...watchers]) fn(event);
      await flush();
    },
  };
}

export type FakeNotifyHost = ReturnType<typeof fakeNotifyHost>;

/** Lets the notifier's promise chains (ready, lp-caps) finish. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

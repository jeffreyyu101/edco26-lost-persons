// System notifications for alerts (v2.5 A52, lib/client/system-notify.ts): which devices support them,
// when permission is asked, where an alert goes (system notification or toast), and what a notification
// may show (never contact details). Notification, the service worker registration and visibility are
// fakes. Synthetic rows only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { newRequestAlert, statusAlert, coalesceAlerts } from '@/lib/client/alerts';
import {
  COMBINED_TAG,
  browserNotifyHost,
  createNotifySystem,
  isAppleTouch,
  noticeOptions,
  notifyStateOf,
  routeAlert,
  systemNotice,
  type DeviceInfo,
  type NotifyHost,
  type NotifyState,
  type ShownNotificationLike,
  type WindowInfo,
} from '@/lib/client/system-notify';
import { STATUS } from '@/lib/domain';
import { makeRow } from './helpers/fake-server';

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
};

const device = (patch: Partial<DeviceInfo> = {}): DeviceInfo => ({
  hasNotification: true,
  permission: 'default',
  userAgent: UA.chromeMac,
  platform: 'MacIntel',
  maxTouchPoints: 0,
  standalone: false,
  registration: true,
  ...patch,
});

describe('which devices support system notifications', () => {
  it('desktop Chrome / Edge / Firefox, Safari on macOS and Android Chrome do, once a service worker is active', () => {
    expect(notifyStateOf(device()).supported).toBe(true);
    expect(notifyStateOf(device({ userAgent: UA.safariMac })).supported).toBe(true);
    expect(notifyStateOf(device({ userAgent: UA.android, platform: 'Linux armv8l', maxTouchPoints: 5 })).supported).toBe(true);
    // No service worker yet (first load, development, blocked): nothing to show them with.
    expect(notifyStateOf(device({ registration: false })).supported).toBe(false);
    // No Notification API at all (older browsers).
    expect(notifyStateOf(device({ hasNotification: false })).supported).toBe(false);
  });

  it('a Safari tab on iPhone or iPad does not (toast + chime only, never a prompt); the Home Screen app does', () => {
    const iPhoneTab = device({ userAgent: UA.iPhone, platform: 'iPhone', maxTouchPoints: 5 });
    expect(notifyStateOf(iPhoneTab).supported).toBe(false);
    expect(notifyStateOf({ ...iPhoneTab, standalone: true }).supported).toBe(true);
    // iPadOS Safari says it is a Mac; the touch screen gives it away.
    const iPadTab = device({ userAgent: UA.safariMac, platform: 'MacIntel', maxTouchPoints: 5 });
    expect(isAppleTouch(iPadTab.userAgent, iPadTab.platform, iPadTab.maxTouchPoints)).toBe(true);
    expect(notifyStateOf(iPadTab).supported).toBe(false);
    expect(notifyStateOf({ ...iPadTab, standalone: true }).supported).toBe(true);
  });

  it('reads the permission as default, granted or denied', () => {
    expect(notifyStateOf(device({ permission: 'granted' })).permission).toBe('granted');
    expect(notifyStateOf(device({ permission: 'denied' })).permission).toBe('denied');
    expect(notifyStateOf(device({ permission: 'prompt' })).permission).toBe('default');
    expect(notifyStateOf(device({ permission: undefined })).permission).toBe('default');
  });
});

describe('where an alert goes', () => {
  const granted: NotifyState = { supported: true, permission: 'granted' };
  const win = (patch: Partial<WindowInfo> = {}): WindowInfo => ({ hidden: false, focused: true, desktop: true, ...patch });

  it('a hidden page with permission: a system notification (desktop or phone)', () => {
    expect(routeAlert(granted, win({ hidden: true, focused: false }))).toBe('system');
    expect(routeAlert(granted, win({ hidden: true, focused: false, desktop: false }))).toBe('system');
  });

  it('a desktop window without focus: a system notification; a phone in front: the toast', () => {
    expect(routeAlert(granted, win({ focused: false }))).toBe('system');
    expect(routeAlert(granted, win({ focused: false, desktop: false }))).toBe('toast');
  });

  it('a page in front: the toast + chime', () => {
    expect(routeAlert(granted, win())).toBe('toast');
    expect(routeAlert(granted, win({ desktop: false }))).toBe('toast');
  });

  it('without permission, or where unsupported: always the toast, even hidden', () => {
    const hidden = win({ hidden: true, focused: false });
    expect(routeAlert({ supported: true, permission: 'default' }, hidden)).toBe('toast');
    expect(routeAlert({ supported: true, permission: 'denied' }, hidden)).toBe('toast');
    expect(routeAlert({ supported: false, permission: 'granted' }, hidden)).toBe('toast');
  });
});

describe('what a notification shows', () => {
  const sofia = makeRow(4, {
    firstName: 'Sofia',
    lastName: 'Lopez',
    reportingLocation: 'FA 3 – Kinetic',
    contactName: 'Maya Friend',
    contactPhone: '+1 407 555 0100',
    contactRelationship: 'Sister',
    contactNotes: 'Call 407-555-0199 first',
    status: STATUS.inMedical,
    rowVersion: 3,
  });
  const rows = new Map<string, RequestSummary>([[sofia.id, sofia]]);
  const rowOf = (id: string) => rows.get(id);

  it('In medical: the LP number and status, initials and post, the next step; sticky until dismissed', () => {
    const n = systemNotice(statusAlert(sofia), rowOf);
    expect(n).toEqual({
      title: 'LP-1004 · In medical',
      body: 'S.L. · FA 3\nBring the friend to Main Med',
      tag: sofia.id,
      url: `/?r=${sofia.id}`,
      key: `${sofia.id}:3`,
      requireInteraction: true,
    });
  });

  it('the other answers and changes read "LP-#### · <status>"', () => {
    for (const [status, title] of [
      [STATUS.notInMedical, 'LP-1004 · Not in medical'],
      [STATUS.reunited, 'LP-1004 · Reunited'],
      [STATUS.waiting, 'LP-1004 · Waiting for check'],
      [STATUS.cancelled, 'LP-1004 · Cancelled'],
    ] as const) {
      const row = { ...sofia, status };
      const n = systemNotice(statusAlert(row), () => row);
      expect(n.title).toBe(title);
      expect(n.body).toBe('S.L. · FA 3');
      expect(n.requireInteraction).toBe(false);
    }
  });

  it('a new request: "New request · LP-####", initials and post (no age or gender either)', () => {
    const row = makeRow(13, { firstName: 'Tara', lastName: 'Reyes', age: '24', gender: 'Female', caseNumber: 1013, contactPhone: '4075550123' });
    const n = systemNotice(newRequestAlert(row), () => row);
    expect(n).toMatchObject({ title: 'New request · LP-1013', body: 'T.R. · FA 4', tag: row.id, url: `/?r=${row.id}` });
  });

  it('never carries a phone number, a contact or a full name, in the text or the data', () => {
    const shown = JSON.stringify([systemNotice(statusAlert(sofia), rowOf), noticeOptions(systemNotice(statusAlert(sofia), rowOf))]);
    for (const secret of ['555', '0100', '0199', 'Maya', 'Sister', 'Call', 'Sofia', 'Lopez', 'Red hoodie']) expect(shown).not.toContain(secret);
  });

  it('3 or more at once: one notification, "3 new requests" (or "3 updates" when mixed), opening the log', () => {
    const fresh = [20, 21, 22].map((n) => makeRow(n, { caseNumber: 1000 + n }));
    const lookup = (id: string) => [...fresh, sofia].find((r) => r.id === id);
    const news = fresh.map(newRequestAlert);
    const [combined] = coalesceAlerts(news);
    expect(systemNotice(combined!, lookup, news)).toEqual({
      title: '3 new requests',
      body: 'LP-1020, LP-1021, LP-1022',
      tag: COMBINED_TAG,
      url: '/',
      key: null,
      requireInteraction: false,
    });
    const mixed = [...news, statusAlert(sofia)];
    expect(systemNotice(coalesceAlerts(mixed)[0]!, lookup, mixed).title).toBe('4 updates');
    const many = [20, 21, 22, 23, 24, 25].map((n) => makeRow(n, { caseNumber: 1000 + n }));
    const manyAlerts = many.map(newRequestAlert);
    expect(systemNotice(coalesceAlerts(manyAlerts)[0]!, (id) => many.find((r) => r.id === id), manyAlerts).body).toBe(
      'LP-1020, LP-1021, LP-1022, LP-1023, +2',
    );
  });

  it('options: tag per request so a later alert replaces it, renotify so it sounds, the click target in data', () => {
    const options = noticeOptions(systemNotice(statusAlert(sofia), rowOf));
    expect(options).toMatchObject({
      tag: sofia.id,
      renotify: true,
      requireInteraction: true,
      icon: '/icons/icon-192.png',
      data: { url: `/?r=${sofia.id}`, key: `${sofia.id}:3` },
    });
  });
});

// ---- The notifier against fake browser parts ----

interface Shown extends ShownNotificationLike {
  title: string;
  tag: string;
  closed: boolean;
}

function fakeHost(opts: { permission?: string; answer?: string; ua?: string; platform?: string; touch?: number; noNotification?: boolean; noWorker?: boolean } = {}) {
  let permission = opts.permission ?? 'default';
  let asked = 0;
  let resolveReady: () => void = () => undefined;
  let win: WindowInfo = { hidden: false, focused: true, desktop: true };
  let onWatch: (() => void) | null = null;
  const open: Shown[] = [];
  const shows: Array<{ title: string; options: NotificationOptions | undefined }> = [];
  let failShow = false;
  const registration = {
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
    ready: () => (opts.noWorker ? null : new Promise((resolve) => (resolveReady = () => resolve(registration)))),
    device: () => ({ userAgent: opts.ua ?? UA.chromeMac, platform: opts.platform ?? 'MacIntel', maxTouchPoints: opts.touch ?? 0, standalone: false }),
    window: () => win,
    watch: (fn) => {
      onWatch = fn;
      return () => (onWatch = null);
    },
  };
  return {
    host,
    open,
    shows,
    asked: () => asked,
    ready: async () => {
      resolveReady();
      await Promise.resolve();
      await Promise.resolve();
    },
    setPermission: (p: string) => {
      permission = p;
    },
    setWindow: (patch: Partial<WindowInfo>) => {
      win = { ...win, ...patch };
    },
    failShow: (v: boolean) => {
      failShow = v;
    },
    fireWatch: () => onWatch?.(),
  };
}

const sample = () => systemNotice(statusAlert(makeRow(4, { status: STATUS.inMedical, rowVersion: 2 })), () => makeRow(4, { status: STATUS.inMedical, rowVersion: 2 }));

describe('the notifier', () => {
  it('becomes supported once the service worker is ready, and tells its subscribers', async () => {
    const f = fakeHost();
    const system = createNotifySystem(f.host);
    const heard = vi.fn();
    system.subscribe(heard);
    expect(system.state()).toEqual({ supported: false, permission: 'default' });
    await f.ready();
    expect(system.state()).toEqual({ supported: true, permission: 'default' });
    expect(heard).toHaveBeenCalled();
  });

  it('asks for permission once from a tap, and reflects the answer', async () => {
    const f = fakeHost({ answer: 'granted' });
    const system = createNotifySystem(f.host);
    system.start();
    await f.ready();
    expect(await system.request()).toBe('granted');
    expect(f.asked()).toBe(1);
    expect(system.state().permission).toBe('granted');
    // Already answered: never asked again.
    expect(await system.request()).toBe('granted');
    expect(f.asked()).toBe(1);
  });

  it('never asks again once denied (no nagging), nor where unsupported', async () => {
    const denied = fakeHost({ permission: 'denied' });
    const a = createNotifySystem(denied.host);
    a.start();
    await denied.ready();
    expect(await a.request()).toBe('denied');
    expect(denied.asked()).toBe(0);

    const iPhoneTab = fakeHost({ ua: UA.iPhone, platform: 'iPhone', touch: 5 });
    const b = createNotifySystem(iPhoneTab.host);
    b.start();
    await iPhoneTab.ready();
    expect(b.state().supported).toBe(false);
    expect(await b.request()).toBe('default');
    expect(iPhoneTab.asked()).toBe(0);

    const noWorker = fakeHost({ noWorker: true });
    const c = createNotifySystem(noWorker.host);
    expect(await c.request()).toBe('default');
    expect(noWorker.asked()).toBe(0);
  });

  it('routes by the live permission and window: hidden or unfocused desktop → system, else toast', async () => {
    const f = fakeHost({ permission: 'granted' });
    const system = createNotifySystem(f.host);
    system.start();
    expect(system.route()).toBe('toast'); // no service worker yet
    await f.ready();
    expect(system.route()).toBe('toast');
    f.setWindow({ hidden: true, focused: false });
    expect(system.route()).toBe('system');
    f.setWindow({ hidden: false, focused: false });
    expect(system.route()).toBe('system');
    f.setWindow({ desktop: false });
    expect(system.route()).toBe('toast');
    // Blocked in the browser's site settings meanwhile: back to the toast.
    f.setWindow({ hidden: true });
    f.setPermission('denied');
    expect(system.route()).toBe('toast');
  });

  it('hears a permission change made in the browser settings', async () => {
    const f = fakeHost({ permission: 'granted' });
    const system = createNotifySystem(f.host);
    const heard = vi.fn();
    system.subscribe(heard);
    await f.ready();
    heard.mockClear();
    f.setPermission('denied');
    f.fireWatch();
    expect(system.state().permission).toBe('denied');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('shows through registration.showNotification, and not twice for the same (id, rowVersion)', async () => {
    const f = fakeHost({ permission: 'granted' });
    const system = createNotifySystem(f.host);
    system.start();
    await f.ready();
    const notice = sample();
    expect(await system.show(notice)).toBe(true);
    expect(f.shows).toHaveLength(1);
    expect(f.shows[0]).toMatchObject({ title: 'LP-1004 · In medical', options: { tag: notice.tag, renotify: true } });
    // Another tab of this browser raises the same alert: already showing.
    expect(await system.show(notice)).toBe(true);
    expect(f.shows).toHaveLength(1);
    // A newer change of the request replaces it (same tag).
    expect(await system.show({ ...notice, title: 'LP-1004 · Not in medical', key: `${notice.tag}:3` })).toBe(true);
    expect(f.shows).toHaveLength(2);
    expect(f.open.map((n) => n.title)).toEqual(['LP-1004 · Not in medical']);
  });

  it('reports failure so the store can toast instead: no permission, no worker, or showNotification throws', async () => {
    const f = fakeHost({ permission: 'default' });
    const system = createNotifySystem(f.host);
    system.start();
    expect(await system.show(sample())).toBe(false); // no worker yet
    await f.ready();
    expect(await system.show(sample())).toBe(false); // not granted
    f.setPermission('granted');
    f.failShow(true);
    expect(await system.show(sample())).toBe(false);
    expect(f.shows).toHaveLength(0);
  });

  it('closes one request’s notification only when it is still the same change, and closes all on sign-out', async () => {
    const f = fakeHost({ permission: 'granted' });
    const system = createNotifySystem(f.host);
    system.start();
    await f.ready();
    const a = sample();
    const b = { ...a, tag: 'other', key: 'other:1' };
    await system.show(a);
    await system.show(b);
    system.close(a.tag, `${a.tag}:99`); // an older change: leaves the newer notification alone
    await Promise.resolve();
    await Promise.resolve();
    expect(f.open.map((n) => n.tag)).toEqual([a.tag, 'other']);
    system.close(a.tag, a.key);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.open.map((n) => n.tag)).toEqual(['other']);
    system.closeAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.open).toEqual([]);
  });
});

describe('the browser host (stubbed globals)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBrowser(opts: { ua: string; platform: string; touch: number; standalone?: boolean; hidden: boolean; focused: boolean; hover: boolean; permission: string }) {
    const showNotification = vi.fn(async () => undefined);
    const registration = { showNotification, getNotifications: async () => [] };
    const target = () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const Notification = { permission: opts.permission, requestPermission: vi.fn(async () => 'granted') };
    vi.stubGlobal('window', {
      ...target(),
      Notification,
      matchMedia: (q: string) => ({ matches: q.includes('standalone') ? !!opts.standalone : opts.hover }),
    });
    vi.stubGlobal('navigator', {
      userAgent: opts.ua,
      platform: opts.platform,
      maxTouchPoints: opts.touch,
      serviceWorker: { ready: Promise.resolve(registration) },
      permissions: { query: async () => target() },
    });
    vi.stubGlobal('document', { ...target(), visibilityState: opts.hidden ? 'hidden' : 'visible', hasFocus: () => opts.focused });
    return { showNotification, Notification };
  }

  it('desktop Chrome, minimised, permission granted: the alert is a system notification', async () => {
    const b = stubBrowser({ ua: UA.chromeMac, platform: 'MacIntel', touch: 0, hidden: true, focused: false, hover: true, permission: 'granted' });
    const system = createNotifySystem(browserNotifyHost());
    system.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(system.state()).toEqual({ supported: true, permission: 'granted' });
    expect(system.route()).toBe('system');
    expect(await system.show(sample())).toBe(true);
    expect(b.showNotification).toHaveBeenCalledWith('LP-1004 · In medical', expect.objectContaining({ tag: sample().tag, renotify: true }));
  });

  it('an iPhone Safari tab: unsupported, routed to the toast, never prompted', async () => {
    const b = stubBrowser({ ua: UA.iPhone, platform: 'iPhone', touch: 5, hidden: true, focused: false, hover: false, permission: 'default' });
    const system = createNotifySystem(browserNotifyHost());
    system.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(system.state().supported).toBe(false);
    expect(system.route()).toBe('toast');
    await system.request();
    expect(b.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('the iPhone Home Screen app: supported', async () => {
    stubBrowser({ ua: UA.iPhone, platform: 'iPhone', touch: 5, standalone: true, hidden: true, focused: false, hover: false, permission: 'granted' });
    const system = createNotifySystem(browserNotifyHost());
    system.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(system.state()).toEqual({ supported: true, permission: 'granted' });
    expect(system.route()).toBe('system');
  });
});

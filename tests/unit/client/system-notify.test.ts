// System notifications for alerts (v2.5 A52, lib/client/system-notify.ts): which devices support them,
// when permission is asked, where an alert goes (system notification or toast), and what a notification
// may show (never contact details). Notification, the service worker registration and visibility are
// fakes. Synthetic rows only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { newRequestAlert, statusAlert, coalesceAlerts } from '@/lib/client/alerts';
import {
  CAPS_REPLY_MS,
  COMBINED_TAG,
  DELIVERED_KEY,
  DELIVERED_TTL_MS,
  FRONT_KEY,
  FRONT_TTL_MS,
  askWorkerCaps,
  browserNotifyHost,
  createPeerBoard,
  createNotifySystem,
  isAppleTouch,
  noticeOptions,
  notifyStateOf,
  routeAlert,
  systemNotice,
  type DeviceInfo,
  type NotifyState,
  type WindowInfo,
} from '@/lib/client/system-notify';
import { STATUS, STATUS_META } from '@/lib/domain';
import { MemoryStorage } from './helpers/env';
import { makeRow } from './helpers/fake-server';
import { UA, fakeNotifyHost, fakeRegistration, flush } from './helpers/notify-host';


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

  it('another app tab of this browser in front: a background tab shows nothing (that tab toasts it)', () => {
    expect(routeAlert(granted, win({ hidden: true, focused: false }), true)).toBe('none');
    expect(routeAlert(granted, win({ focused: false }), true)).toBe('none');
    // This window is the one in front: its own toast, whatever another tab claims.
    expect(routeAlert(granted, win(), true)).toBe('toast');
    expect(routeAlert(granted, win({ focused: false, desktop: false }), true)).toBe('toast');
    // Toast-only tabs are as before.
    expect(routeAlert({ supported: true, permission: 'denied' }, win({ hidden: true, focused: false }), true)).toBe('toast');
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

  it('In medical: the full name and status (no LP number, F4), the post, the next step; sticky until dismissed', () => {
    const n = systemNotice(statusAlert(sofia), rowOf);
    expect(n).toEqual({
      title: 'Sofia Lopez · Located',
      body: 'FA 3\nFriend can head over',
      tag: `lp-${sofia.id}`,
      url: `/?r=${sofia.id}`,
      key: `${sofia.id}:3`,
      requireInteraction: true,
    });
  });

  it('the other answers and changes read "<full name> · <status>" (the label from STATUS_META), never an LP number', () => {
    for (const status of [STATUS.notInMedical, STATUS.reunited, STATUS.waiting, STATUS.cancelled] as const) {
      const row = { ...sofia, status };
      const n = systemNotice(statusAlert(row), () => row);
      expect(n.title).toBe(`Sofia Lopez · ${STATUS_META[status].shortLabel}`);
      expect(n.title).not.toMatch(/LP-?\d/);
      expect(n.body).toBe('FA 3');
      expect(n.requireInteraction).toBe(false);
    }
  });

  it('a new request: "New request" (no LP number, F4), the full name and post (no age or gender either)', () => {
    const row = makeRow(13, { firstName: 'Tara', lastName: 'Reyes', age: '24', gender: 'Female', caseNumber: 1013, contactPhone: '4075550123' });
    const n = systemNotice(newRequestAlert(row), () => row);
    expect(n).toMatchObject({ title: 'New request', body: 'Tara Reyes · FA 4', tag: `lp-${row.id}`, url: `/?r=${row.id}` });
    // Not synced yet: the alert's own title would carry the LP number; the notification never does.
    expect(systemNotice(newRequestAlert(row), () => undefined).title).toBe('New request');
  });

  it('shows the full name but never a phone number or a contact, in the text or the data', () => {
    const shown = JSON.stringify([systemNotice(statusAlert(sofia), rowOf), noticeOptions(systemNotice(statusAlert(sofia), rowOf))]);
    expect(shown).toContain('Sofia Lopez');
    for (const secret of ['555', '0100', '0199', 'Maya', 'Sister', 'Call', 'Red hoodie']) expect(shown).not.toContain(secret);
  });

  // Ann R20, Bnn R21, … (shown as entered)
  const named = (n: number) => makeRow(n, { caseNumber: 1000 + n, firstName: `${String.fromCharCode(45 + n)}nn`, lastName: `R${n}` });

  it('3 or more at once: one notification, "3 new requests" (or "3 updates" when mixed), opening the log; the names, no LP numbers', () => {
    const fresh = [20, 21, 22].map(named);
    const lookup = (id: string) => [...fresh, sofia].find((r) => r.id === id);
    const news = fresh.map(newRequestAlert);
    const [combined] = coalesceAlerts(news);
    expect(systemNotice(combined!, lookup, news)).toEqual({
      title: '3 new requests',
      body: 'Ann R20, Bnn R21, Cnn R22',
      tag: COMBINED_TAG,
      url: '/',
      key: null,
      requireInteraction: false,
    });
    const mixed = [...news, statusAlert(sofia)];
    expect(systemNotice(coalesceAlerts(mixed)[0]!, lookup, mixed).title).toBe('4 updates');
    const many = [20, 21, 22, 23, 24, 25].map(named);
    const manyAlerts = many.map(newRequestAlert);
    expect(systemNotice(coalesceAlerts(manyAlerts)[0]!, (id) => many.find((r) => r.id === id), manyAlerts).body).toBe(
      'Ann R20, Bnn R21, Cnn R22, Dnn R23, +2',
    );
  });

  it('options: tag per request so a later alert replaces it, renotify so it sounds, the click target in data', () => {
    const options = noticeOptions(systemNotice(statusAlert(sofia), rowOf));
    expect(options).toMatchObject({
      tag: `lp-${sofia.id}`,
      renotify: true,
      requireInteraction: true,
      icon: '/icons/icon-192.png',
      data: { url: `/?r=${sofia.id}`, key: `${sofia.id}:3` },
    });
  });
});

// ---- The notifier against fake browser parts ----

const fakeHost = fakeNotifyHost;

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
    f.peekWindow({ hidden: true, focused: false });
    expect(system.route()).toBe('system');
    f.peekWindow({ hidden: false, focused: false });
    expect(system.route()).toBe('system');
    f.peekWindow({ desktop: false });
    expect(system.route()).toBe('toast');
    // Blocked in the browser's site settings meanwhile: back to the toast.
    f.peekWindow({ hidden: true });
    f.setPermission('denied');
    expect(system.route()).toBe('toast');
  });

  it('only once the active worker handles clicks (lp-caps): an older build’s worker keeps alerts toasts until the update takes over', async () => {
    const f = fakeHost({ permission: 'granted' });
    f.reg.setClicks(false);
    const system = createNotifySystem(f.host);
    const heard = vi.fn();
    system.subscribe(heard);
    await f.ready();
    expect(f.reg.caps).toEqual([{ type: 'lp-caps' }]);
    expect(system.state()).toEqual({ supported: false, permission: 'granted' });
    f.peekWindow({ hidden: true, focused: false });
    expect(system.route()).toBe('toast');
    expect(await system.showNotice(sample())).toBe(false);
    expect(f.shows).toEqual([]);
    // "Update ready · Reload" in another tab: this build's worker takes over this page too.
    f.reg.setClicks(true);
    await f.fire('controllerchange');
    expect(system.state()).toEqual({ supported: true, permission: 'granted' });
    expect(system.route()).toBe('system');
    expect(heard).toHaveBeenCalled();
  });

  it('asks the worker again on focus while it has no answer yet, and not once it has one', async () => {
    const f = fakeHost({ permission: 'granted' });
    f.reg.setClicks(false);
    const system = createNotifySystem(f.host);
    system.start();
    await f.ready();
    expect(f.reg.caps).toHaveLength(1);
    f.reg.setClicks(true);
    await f.fire('focus');
    expect(f.reg.caps).toHaveLength(2);
    expect(system.state().supported).toBe(true);
    await f.fire('focus');
    await f.fire('visibilitychange');
    expect(f.reg.caps).toHaveLength(2);
  });

  it('hears a permission change made in the browser settings', async () => {
    const f = fakeHost({ permission: 'granted' });
    const system = createNotifySystem(f.host);
    const heard = vi.fn();
    system.subscribe(heard);
    await f.ready();
    heard.mockClear();
    f.setPermission('denied');
    await f.fire('permission');
    expect(system.state().permission).toBe('denied');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('shows through registration.showNotification, and not twice for the same (id, rowVersion)', async () => {
    const f = fakeHost({ permission: 'granted' });
    const system = createNotifySystem(f.host);
    system.start();
    await f.ready();
    const notice = sample();
    expect(await system.showNotice(notice)).toBe(true);
    expect(f.shows).toHaveLength(1);
    expect(f.shows[0]).toMatchObject({ title: notice.title, options: { tag: notice.tag, renotify: true } });
    // Another tab of this browser raises the same alert: already showing.
    expect(await system.showNotice(notice)).toBe(true);
    expect(f.shows).toHaveLength(1);
    // A newer change of the request replaces it (same tag).
    expect(await system.showNotice({ ...notice, title: 'T.R. · Not located', key: `${notice.tag}:3` })).toBe(true);
    expect(f.shows).toHaveLength(2);
    expect(f.open.map((n) => n.title)).toEqual(['T.R. · Not located']);
  });

  it('show(alert) builds the notification from the rows at call time (the store’s entry point)', async () => {
    const f = fakeHost({ permission: 'granted' });
    const system = createNotifySystem(f.host);
    system.start();
    await f.ready();
    let row: RequestSummary | undefined = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', status: STATUS.inMedical, rowVersion: 2 });
    const alert = statusAlert(row);
    const shown = system.show(alert, () => row, [alert]);
    row = undefined; // the store moves on; the notification was already built
    expect(await shown).toBe(true);
    expect(f.shows[0]).toMatchObject({ title: 'Sofia Lopez · Located', options: { body: 'FA 4\nFriend can head over', data: { key: `${alert.requestId}:2` } } });
  });

  it('reports failure so the store can toast instead: no permission, no worker, or showNotification throws', async () => {
    const f = fakeHost({ permission: 'default' });
    const system = createNotifySystem(f.host);
    system.start();
    expect(await system.showNotice(sample())).toBe(false); // no worker yet
    await f.ready();
    expect(await system.showNotice(sample())).toBe(false); // not granted
    f.setPermission('granted');
    f.reg.failShow(true);
    expect(await system.showNotice(sample())).toBe(false);
    expect(f.shows).toHaveLength(0);
  });

  it('closes one request’s notification only when it is still the same change, and closes all on sign-out', async () => {
    const f = fakeHost({ permission: 'granted' });
    const system = createNotifySystem(f.host);
    system.start();
    await f.ready();
    const a = sample();
    const b = { ...a, tag: 'other', key: 'other:1' };
    await system.showNotice(a);
    await system.showNotice(b);
    const id = makeRow(4).id;
    system.close(id, `${id}:99`); // an older change: leaves the newer notification alone
    await Promise.resolve();
    await Promise.resolve();
    expect(f.open.map((n) => n.tag)).toEqual([a.tag, 'other']);
    system.close(id, a.key);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.open.map((n) => n.tag)).toEqual(['other']);
    system.closeAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.open).toEqual([]);
  });
});

// ---- Two tabs of one browser (one localStorage, one registration) ----

describe('across tabs: never a toast in one and a notification in another', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.parse('2026-11-07T03:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Tab `a` (the list, focused) and tab `b` (another window or tab), both with permission granted. */
  async function twoTabs(permission = 'granted') {
    const registration = fakeRegistration();
    const storage = new MemoryStorage();
    const a = fakeNotifyHost({ permission, registration, storage, readyNow: true });
    const b = fakeNotifyHost({ permission, registration, storage, readyNow: true, window: { hidden: true, focused: false } });
    const ta = createNotifySystem(a.host);
    const tb = createNotifySystem(b.host);
    ta.start();
    tb.start();
    await flush();
    return { a, b, ta, tb, storage, registration };
  }

  it('the tab in front claims; a background tab shows nothing and records nothing; the front tab toasts and records', async () => {
    const { b, ta, tb, storage } = await twoTabs();
    expect(tb.state()).toEqual({ supported: true, permission: 'granted' });
    ta.setActive(true);
    tb.setActive(true);
    expect(JSON.parse(storage.getItem(FRONT_KEY) ?? 'null')).toMatchObject({ until: Date.now() + FRONT_TTL_MS });
    // The background tab polled first.
    expect(tb.plan(['r1:2'])).toEqual({ route: 'none', skip: new Set() });
    expect(storage.getItem(DELIVERED_KEY)).toBeNull();
    // The tab in front sees it on its own poll: its toast + chime.
    expect(ta.plan(['r1:2'])).toEqual({ route: 'toast', skip: new Set() });
    // A dashboard window, visible on another monitor but not focused: nothing either.
    await b.setWindow({ hidden: false, focused: false });
    expect(tb.plan(['r2:1'])).toEqual({ route: 'none', skip: new Set() });
    // The claim is kept while the tab stays in front (refreshed), and is not taken over by the other tab.
    await vi.advanceTimersByTimeAsync(FRONT_TTL_MS * 3);
    expect(tb.route()).toBe('none');
  });

  it('an alert one tab delivered is shown nowhere else: not later as a notification, not as a toast on coming to the front', async () => {
    const { a, ta, tb } = await twoTabs();
    ta.setActive(true);
    tb.setActive(true);
    expect(ta.plan(['r1:2']).route).toBe('toast');
    // Everything goes to the background (another app is focused): no claim any more.
    await a.setWindow({ focused: false }, 'blur');
    expect(tb.route()).toBe('system');
    // The other tab raises r1 a minute later on its own poll: already delivered (as the toast).
    expect(tb.plan(['r1:2', 'r3:1'])).toEqual({ route: 'system', skip: new Set(['r1:2']) });
    // r3 went out as a notification from tab b; tab a raises it later and comes to the front: no toast.
    await a.setWindow({ focused: true }, 'focus');
    expect(ta.plan(['r3:1'])).toEqual({ route: 'toast', skip: new Set(['r3:1']) });
    // A newer change of the same request is a new key.
    expect(ta.plan(['r3:2'])).toEqual({ route: 'toast', skip: new Set() });
  });

  it('only a signed-in, alerting tab claims the front (not one still on its baseline sync, not one that is leaving)', async () => {
    const { a, ta, tb } = await twoTabs();
    expect(tb.route()).toBe('system'); // tab a is not alerting yet
    ta.setActive(true);
    expect(tb.route()).toBe('none');
    await a.fire('pagehide');
    expect(tb.route()).toBe('system');
    await a.fire('pageshow');
    expect(tb.route()).toBe('none');
    ta.setActive(false); // signed out, or stopped
    expect(tb.route()).toBe('system');
  });

  it('a claim left by a tab that died without pagehide expires', async () => {
    const { tb, storage } = await twoTabs();
    storage.setItem(FRONT_KEY, JSON.stringify({ tab: 'crashed-tab', until: Date.now() + FRONT_TTL_MS }));
    expect(tb.route()).toBe('none');
    await vi.advanceTimersByTimeAsync(FRONT_TTL_MS + 1);
    expect(tb.route()).toBe('system');
  });

  it('delivered keys are forgotten after a while, and on sign-out (closeAll)', async () => {
    const { ta, tb, storage } = await twoTabs();
    ta.setActive(true);
    ta.plan(['r1:2']);
    expect(tb.plan(['r1:2']).route).toBe('none');
    ta.setActive(false);
    await vi.advanceTimersByTimeAsync(DELIVERED_TTL_MS + 1);
    expect(tb.plan(['r1:2'])).toEqual({ route: 'system', skip: new Set() });
    tb.closeAll();
    expect(storage.getItem(DELIVERED_KEY)).toBeNull();
  });

  it('toast-only tabs (permission not granted) are as before: each toasts, nothing is claimed or recorded', async () => {
    const { ta, tb, storage } = await twoTabs('default');
    ta.setActive(true);
    tb.setActive(true);
    expect(storage.getItem(FRONT_KEY)).toBeNull();
    expect(ta.plan(['r1:2'])).toEqual({ route: 'toast', skip: new Set() });
    expect(tb.plan(['r1:2'])).toEqual({ route: 'toast', skip: new Set() });
    expect(storage.getItem(DELIVERED_KEY)).toBeNull();
  });

  it('blocked localStorage: each tab decides alone, nothing throws', async () => {
    const board = createPeerBoard(
      () => ({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      }),
      'tab-x',
      () => Date.now(),
    );
    board.setFront(true);
    board.markDelivered(['r1:2']);
    expect(board.otherInFront()).toBe(false);
    expect(board.delivered('r1:2')).toBe(false);
    board.clear();
  });
});

describe('the browser host (stubbed globals)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The active worker: this build's answers lp-caps; an older build's ('old') never does. */
  function activeWorker(kind: 'current' | 'old') {
    const asked: unknown[] = [];
    return {
      asked,
      postMessage: (message: unknown, transfer?: unknown[]) => {
        asked.push(message);
        const port = transfer?.[0] as MessagePort | undefined;
        if (kind === 'current' && (message as { type?: string }).type === 'lp-caps') port?.postMessage({ notificationClick: true });
      },
    };
  }

  function stubBrowser(opts: {
    ua: string;
    platform: string;
    touch: number;
    standalone?: boolean;
    hidden: boolean;
    focused: boolean;
    hover: boolean;
    permission: string;
    worker?: 'current' | 'old';
  }) {
    const showNotification = vi.fn(async () => undefined);
    const active = activeWorker(opts.worker ?? 'current');
    const registration = { active, showNotification, getNotifications: async () => [] };
    const target = () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const Notification = { permission: opts.permission, requestPermission: vi.fn(async () => 'granted') };
    const serviceWorker = { ...target(), ready: Promise.resolve(registration) };
    vi.stubGlobal('window', {
      ...target(),
      Notification,
      localStorage: new MemoryStorage(),
      matchMedia: (q: string) => ({ matches: q.includes('standalone') ? !!opts.standalone : opts.hover }),
    });
    vi.stubGlobal('navigator', {
      userAgent: opts.ua,
      platform: opts.platform,
      maxTouchPoints: opts.touch,
      serviceWorker,
      permissions: { query: async () => target() },
    });
    vi.stubGlobal('document', { ...target(), visibilityState: opts.hidden ? 'hidden' : 'visible', hasFocus: () => opts.focused });
    return { showNotification, Notification, active, serviceWorker };
  }

  /** Lets ready, the lp-caps round trip (a real MessageChannel) and the state update finish. */
  const settleHost = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setImmediate(r));
  };

  it('desktop Chrome, minimised, permission granted: the alert is a system notification', async () => {
    const b = stubBrowser({ ua: UA.chromeMac, platform: 'MacIntel', touch: 0, hidden: true, focused: false, hover: true, permission: 'granted' });
    const system = createNotifySystem(browserNotifyHost());
    system.start();
    await settleHost();
    expect(system.state()).toEqual({ supported: true, permission: 'granted' });
    expect(system.route()).toBe('system');
    expect(await system.showNotice(sample())).toBe(true);
    expect(b.showNotification).toHaveBeenCalledWith(sample().title, expect.objectContaining({ tag: sample().tag, renotify: true }));
  });

  it('an iPhone Safari tab: unsupported, routed to the toast, never prompted', async () => {
    const b = stubBrowser({ ua: UA.iPhone, platform: 'iPhone', touch: 5, hidden: true, focused: false, hover: false, permission: 'default' });
    const system = createNotifySystem(browserNotifyHost());
    system.start();
    await settleHost();
    expect(system.state().supported).toBe(false);
    expect(system.route()).toBe('toast');
    await system.request();
    expect(b.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('asks the active worker for lp-caps over a MessageChannel; a worker of an older build keeps alerts toasts', async () => {
    const current = stubBrowser({ ua: UA.chromeMac, platform: 'MacIntel', touch: 0, hidden: true, focused: false, hover: true, permission: 'granted' });
    const system = createNotifySystem(browserNotifyHost());
    system.start();
    await settleHost();
    expect(current.active.asked).toEqual([{ type: 'lp-caps' }]);
    expect(system.state().supported).toBe(true);
    vi.unstubAllGlobals();

    // The production worker before this build: no notificationclick handler, no answer. A notification
    // would show, and a click on it would do nothing.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const old = stubBrowser({ ua: UA.chromeMac, platform: 'MacIntel', touch: 0, hidden: true, focused: false, hover: true, permission: 'granted', worker: 'old' });
      const stale = createNotifySystem(browserNotifyHost());
      stale.start();
      await vi.advanceTimersByTimeAsync(CAPS_REPLY_MS + 10);
      expect(old.active.asked).toEqual([{ type: 'lp-caps' }]);
      expect(stale.state()).toEqual({ supported: false, permission: 'granted' });
      expect(stale.route()).toBe('toast');
      expect(await stale.showNotice(sample())).toBe(false);
      expect(old.showNotification).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('askWorkerCaps: no worker, or one that never answers, is false', async () => {
    expect(await askWorkerCaps(null)).toBe(false);
    expect(await askWorkerCaps({ postMessage: () => undefined }, 20)).toBe(false);
    expect(
      await askWorkerCaps({
        postMessage: () => {
          throw new Error('redundant');
        },
      }),
    ).toBe(false);
  });

  it('the iPhone Home Screen app: supported', async () => {
    stubBrowser({ ua: UA.iPhone, platform: 'iPhone', touch: 5, standalone: true, hidden: true, focused: false, hover: false, permission: 'granted' });
    const system = createNotifySystem(browserNotifyHost());
    system.start();
    await settleHost();
    expect(system.state()).toEqual({ supported: true, permission: 'granted' });
    expect(system.route()).toBe('system');
  });
});

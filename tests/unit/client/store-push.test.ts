// No double alerts with Web Push (F4, spec §18 A54), through the real store: on a device with a push
// subscription the page never shows its own system notification for an alert (the push does); in front the
// toast is unchanged; without a subscription the page's notification is as before (v2.5 A52). The Activity
// unread count rides on sync (f4-bridge). A sign-out removes the subscription only once it is confirmed (one
// that fails keeps the device's alerts; one resumed at load drops it without the push client). Fake notifier;
// synthetic rows only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertNotifier, AlertRoute, SystemNotice } from '@/lib/client/system-notify';
import { systemNotice } from '@/lib/client/system-notify';
import { publishSyncExtras, registerPushHooks, storeApi, subscribeSyncExtras, type ActivityUnread, type PushHooks } from '@/lib/client/f4-bridge';
import { LOGOUT_PENDING_KEY } from '@/lib/client/session-signals';
import { STATUS } from '@/lib/domain';
import { MemoryStorage, advance } from './helpers/env';
import { boot, finish, installStoreHooks, ready } from './helpers/boot';
import { FakeServer, STAFF, apiError, makeRow } from './helpers/fake-server';

installStoreHooks();

afterEach(() => {
  registerPushHooks(null);
  publishSyncExtras(null);
  vi.unstubAllGlobals();
});

/** A device whose push subscription the server confirmed (lib/client/push-client.ts pushHooksFor). */
const subscribed = () =>
  registerPushHooks({ covers: (kind) => kind !== 'combined', beforeSignOut: async () => undefined, afterSignOut: async () => undefined, onSessionEnded: () => undefined });

/** Hooks that record what the store asked, and when (by the server log's length at that moment). */
function recordingHooks(server: FakeServer) {
  const calls: string[] = [];
  const hooks: PushHooks = {
    covers: () => true,
    beforeSignOut: async () => {
      calls.push(`before@${server.log.length}`);
    },
    afterSignOut: async (confirmed) => {
      calls.push(`after:${confirmed}`);
    },
    onSessionEnded: () => calls.push('ended'),
  };
  registerPushHooks(hooks);
  return calls;
}

/** The last Activity count the store handed over (what a client starting now begins from). */
function lastActivityUnread(): ActivityUnread | null {
  let last: ActivityUnread | null = null;
  subscribeSyncExtras((u) => {
    last = u;
  })();
  return last;
}

function bootWith(server: FakeServer, route: AlertRoute) {
  const shown: SystemNotice[] = [];
  const notifier: AlertNotifier = {
    plan: () => ({ route, skip: new Set<string>() }),
    setActive: () => undefined,
    show: async (alert, rowOf, sources) => {
      shown.push(systemNotice(alert, rowOf, sources));
      return true;
    },
    close: () => undefined,
    closeAll: () => undefined,
  };
  const booted = boot(server, {}, (env) => {
    env.notifier = () => notifier;
  });
  return { ...booted, shown };
}

describe('Web Push covers the page notification', () => {
  it('subscribed, app in the background: no page notification (the push carries it), no toast', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, shown } = bootWith(server, 'system');
    subscribed();
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(shown).toEqual([]);
    expect(s().toasts).toEqual([]);
  });

  it('subscribed, app in front: the toast as before (the worker showed nothing)', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, shown } = bootWith(server, 'toast');
    subscribed();
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(shown).toEqual([]);
    expect(s().toasts.map((t) => t.title)).toEqual(['LP-1004 · T. R4 located']);
  });

  it('not subscribed: the page notification as before (v2.5 A52)', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { shown } = bootWith(server, 'system');
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(shown.map((n) => n.title)).toEqual(['T. R4']);
  });
});

/** The page's own rule: a system notification while hidden, the toast in front (system-notify routeAlert). */
function bootByVisibility(server: FakeServer) {
  const shown: SystemNotice[] = [];
  let visible = () => true;
  const notifier: AlertNotifier = {
    plan: () => ({ route: visible() ? 'toast' : 'system', skip: new Set<string>() }),
    setActive: () => undefined,
    show: async (alert, rowOf, sources) => {
      shown.push(systemNotice(alert, rowOf, sources));
      return true;
    },
    close: () => undefined,
    closeAll: () => undefined,
  };
  const booted = boot(server, {}, (env) => {
    env.notifier = () => notifier;
    visible = env.visible;
  });
  /** The phone locks: hidden, and (an iPhone) suspended: no timer runs while the clock moves on. */
  const lock = () => {
    booted.fe.setVisible(false);
    booted.fe.fire('document', 'visibilitychange');
  };
  const unlock = async (afterMs = 5 * 60_000) => {
    vi.setSystemTime(Date.now() + afterMs);
    booted.fe.setVisible(true);
    booted.fe.fire('document', 'visibilitychange');
    await advance(100);
  };
  return { ...booted, shown, lock, unlock };
}

describe('regression: a hidden, suspended page (an iPhone) never toasts what its push already showed', () => {
  const MESSAGE = { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' };
  const messageRow = () =>
    makeRow(4, { createdBy: STAFF.dana.staff, messageCount: 0, unread: 0, lastMessage: null, lastMessageAt: null, needsInfo: false, enroute: null, involved: true });

  it('subscribed: a change made while locked shows no toast when the app is opened (the lock screen had it)', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, shown, lock, unlock } = bootByVisibility(server);
    subscribed();
    await ready();
    lock();
    server.change(mine.id, { status: STATUS.inMedical });
    // The fake server's clock is its seq: put the change a minute into the lock.
    server.rows.get(mine.id)!.row.updatedAt = new Date(Date.now() + 60_000).toISOString();
    await unlock();
    expect(s().confirmed.get(mine.id)?.status).toBe(STATUS.inMedical);
    expect(s().toasts).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('subscribed: a change made after the app is opened again toasts as before', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, lock, unlock } = bootByVisibility(server);
    subscribed();
    await ready();
    lock();
    await unlock();
    server.change(mine.id, { status: STATUS.inMedical });
    server.rows.get(mine.id)!.row.updatedAt = new Date(Date.now() + 10_000).toISOString();
    await advance(6_000);
    expect(s().toasts.map((t) => t.title)).toEqual(['LP-1004 · T. R4 located']);
  });

  it('not subscribed: the change made while locked toasts when the app is opened (nothing else showed it)', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, lock, unlock } = bootByVisibility(server);
    await ready();
    lock();
    server.change(mine.id, { status: STATUS.inMedical });
    server.rows.get(mine.id)!.row.updatedAt = new Date(Date.now() + 60_000).toISOString();
    await unlock();
    expect(s().toasts.map((t) => t.title)).toEqual(['LP-1004 · T. R4 located']);
  });

  it('subscribed: a message sent while locked shows no toast when the app is opened; one after it does', async () => {
    const row = messageRow();
    const server = new FakeServer([row]);
    const { s, lock, unlock } = bootByVisibility(server);
    subscribed();
    await ready();
    lock();
    server.put({ ...row, messageCount: 1, unread: 1, lastMessageAt: new Date(Date.now() + 60_000).toISOString(), lastMessage: MESSAGE });
    await unlock();
    expect(s().confirmed.get(row.id)?.messageCount).toBe(1);
    expect(s().toasts).toEqual([]);
    server.put({ ...row, messageCount: 2, unread: 2, lastMessageAt: new Date(Date.now() + 10_000).toISOString(), lastMessage: { ...MESSAGE, text: 'Bring 1 person only' } });
    await advance(6_000);
    expect(s().toasts.map((t) => t.subtitle)).toEqual(['Rae C.: Bring 1 person only']);
  });

  it('not subscribed: the message sent while locked toasts when the app is opened', async () => {
    const row = messageRow();
    const server = new FakeServer([row]);
    const { s, lock, unlock } = bootByVisibility(server);
    await ready();
    lock();
    server.put({ ...row, messageCount: 1, unread: 1, lastMessageAt: new Date(Date.now() + 60_000).toISOString(), lastMessage: MESSAGE });
    await unlock();
    expect(s().toasts.map((t) => t.subtitle)).toEqual(['Rae C.: Any tattoos or marks?']);
  });
});

describe('the Activity count rides on sync', () => {
  it('the first page of a poll publishes activityUnread (an older server: nothing)', async () => {
    const server = new FakeServer([makeRow(1)]);
    bootWith(server, 'toast');
    await ready();
    expect(lastActivityUnread()).toBeNull();
  });

  it('a server with Activity: the count and the key reach the bell on every poll', async () => {
    const server = new FakeServer([makeRow(1)]);
    server.syncExtras = { activityUnread: 2, activityKey: '0123456789abcdef' };
    bootWith(server, 'toast');
    await ready();
    expect(lastActivityUnread()).toEqual({ count: 2, key: '0123456789abcdef' });
    server.syncExtras = { activityUnread: 0, activityKey: 'fedcba9876543210' };
    await advance(6_000);
    expect(lastActivityUnread()).toEqual({ count: 0, key: 'fedcba9876543210' });
  });
});

describe('F4 sends through the store', () => {
  it('with the store’s fetch; a sign-out tells the push service first, then holds every later request', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a } = boot(server);
    await ready();
    const api = storeApi();
    expect(api).not.toBeNull();
    await finish(api!('/api/activity', { timeoutMs: 1_000 }));
    expect(server.requests('GET', '/api/activity')).toHaveLength(1);
    registerPushHooks({
      covers: () => false,
      beforeSignOut: async () => {
        await storeApi()!('/api/push/subscribe', { method: 'DELETE', json: { endpoint: 'x' }, timeoutMs: 1_000 });
      },
      afterSignOut: async () => undefined,
      onSessionEnded: () => undefined,
    });
    expect(await finish(a.signOut())).toEqual({ ok: true });
    const order = server.log.map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf('DELETE /api/push/subscribe')).toBeGreaterThan(-1);
    expect(order.indexOf('DELETE /api/push/subscribe')).toBeLessThan(order.indexOf('DELETE /api/session'));
    expect(await finish(api!('/api/activity', { timeoutMs: 1_000 }))).toEqual({ ok: false, kind: 'network' });
    expect(server.requests('GET', '/api/activity')).toHaveLength(1);
  });
});

describe('sign-out and this device’s push subscription', () => {
  it('confirmed: the server is told before the session goes, the browser drops it after', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a } = boot(server);
    await ready();
    const calls = recordingHooks(server);
    const before = server.log.length;
    expect(await finish(a.signOut())).toEqual({ ok: true });
    expect(calls).toEqual([`before@${before}`, 'after:true']);
    const order = server.log.slice(before).map((r) => `${r.method} ${r.path}`);
    expect(order[0]).toBe('DELETE /api/session');
  });

  it('regression: offline, the sign-out fails and the device keeps its subscription (never dropped)', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, s, fe } = boot(server);
    await ready();
    const calls = recordingHooks(server);
    fe.setOnline(false);
    const res = await finish(a.signOut());
    expect(res).toMatchObject({ ok: false, reason: 'failed' });
    expect(s().session.status).toBe('active');
    expect(calls).toEqual([expect.stringMatching(/^before@/), 'after:false']);
    expect(calls).not.toContain('after:true');
  });

  it('regression: the server refused it (5xx): the session goes on and so does the subscription', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a } = boot(server);
    await ready();
    const calls = recordingHooks(server);
    server.override = (req) => (req.path === '/api/session' && req.method === 'DELETE' ? apiError(503, 'unavailable', 'Try again') : undefined);
    const res = await finish(a.signOut(), 5_000);
    expect(res).toMatchObject({ ok: false, reason: 'failed' });
    expect(calls.at(-1)).toBe('after:false');
    expect(calls).not.toContain('after:true');
  });

  it('regression: a sign-out resumed at load, before the push client is loaded, still drops the browser’s subscription', async () => {
    const server = new FakeServer([makeRow(1)]);
    let unsubscribed = 0;
    const sub = { unsubscribe: async () => (unsubscribed += 1) > 0 };
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }) },
    });
    const local = new MemoryStorage();
    local.setItem(LOGOUT_PENDING_KEY, JSON.stringify({ at: Date.now(), discard: false }));
    const { s, fe } = boot(server, { local });
    await ready();
    await advance(100);
    expect(s().session.status).toBe('signed_out');
    expect(fe.redirects).toEqual(['/signin']);
    expect(unsubscribed).toBe(1);
  });
});

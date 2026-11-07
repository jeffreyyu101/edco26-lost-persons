// public/sw.js Web Push (F4, spec §18 A54): a push shows its notification (title, body, tag "lp-<id>", the
// app icon, renotify for messages) and sets the app icon badge; while a window of the app is visible AND
// focused it shows nothing and tells the window to sync (never a toast and a notification), except on WebKit,
// which revokes silent pushes: there it is shown silently and closed at once. A malformed push still shows
// something. pushsubscriptionchange re-subscribes and tells the server with the old endpoint. A click on a
// push opens the request. Synthetic ids only.
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeCacheStorage, FakeNetwork, ORIGIN, loadWorker, type PageClient, type Worker } from './harness';

const ID = '0f0f0f0f-0000-4000-8000-000000000044';
const IPHONE_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

const payload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  title: 'J.D.',
  body: 'In medical · Chair 9',
  tag: `lp-${ID}`,
  url: `/?r=${ID}`,
  kind: 'in_medical',
  requestId: ID,
  renotify: false,
  badge: 3,
  ...over,
});

interface Win extends PageClient {
  messages: unknown[];
}

function win(id: string, opts: { focused?: boolean; visible?: boolean; path?: string } = {}): Win {
  const w: Win = {
    id,
    url: `${ORIGIN}${opts.path ?? '/'}`,
    focused: opts.focused ?? false,
    visibilityState: opts.visible === false ? 'hidden' : 'visible',
    messages: [],
    postMessage: (m: unknown) => {
      w.messages.push(m);
    },
  };
  return w;
}

let pages: PageClient[];
let worker: Worker;

beforeEach(() => {
  pages = [];
  worker = loadWorker({ version: 'p1', caches: new FakeCacheStorage(), network: new FakeNetwork(), active: 'p1', pages });
});

describe('push (no window in front)', () => {
  it('shows the notification from the payload, with the app icon, and sets the badge', async () => {
    await worker.push(payload());
    expect(worker.notifications).toHaveLength(1);
    const [n] = worker.notifications;
    expect(n?.title).toBe('J.D.');
    expect(n?.options).toMatchObject({ body: 'In medical · Chair 9', tag: `lp-${ID}`, icon: '/icons/icon-192.png', renotify: false, silent: false });
    expect(n?.data).toMatchObject({ url: `/?r=${ID}`, push: true, requestId: ID });
    expect(worker.badge()).toBe(3);
  });

  it('a later push about the same request replaces the notification (one per request); messages sound again', async () => {
    await worker.push(payload());
    await worker.push(payload({ kind: 'message', body: 'Rae C.: Bring 1 person only', renotify: true }));
    expect(worker.notifications).toHaveLength(1);
    expect(worker.notifications[0]?.options).toMatchObject({ body: 'Rae C.: Bring 1 person only', renotify: true });
  });

  it('a hidden or unfocused window does not stop it, and hears about it', async () => {
    const hidden = win('a', { focused: false, visible: false });
    const unfocused = win('b', { focused: false, visible: true });
    pages.push(hidden, unfocused);
    await worker.push(payload());
    expect(worker.notifications).toHaveLength(1);
    expect(hidden.messages).toEqual([{ type: 'lp-push', kind: 'in_medical', requestId: ID }]);
  });

  it('a malformed or empty push still shows something (WebKit revokes silent pushes)', async () => {
    await worker.push('not json');
    await worker.push(undefined);
    expect(worker.shownLog.length).toBeGreaterThanOrEqual(1);
    expect(worker.shownLog[0]?.title).toBe('Is my friend in medical?');
    expect(worker.shownLog[0]?.options.tag).toBe('lp-update');
  });

  it('only same-origin click targets and lp- tags are used', async () => {
    await worker.push(payload({ url: 'https://evil.example/x', tag: 'other' }));
    const [n] = worker.notifications;
    expect(n?.data?.url).toBe('/');
    expect(n?.options.tag).toBe('lp-update');
  });

  it('a click on a push opens the request', async () => {
    await worker.push(payload());
    const data = worker.notifications[0]?.data;
    const res = await worker.notificationClick(data);
    expect(res.closed).toBe(true);
    expect(worker.opened).toEqual([`/?r=${ID}`]);
  });
});

describe('push while the app is in front (never both)', () => {
  it('a visible, focused window: no notification; the window syncs (its toast carries the event)', async () => {
    const front = win('front', { focused: true, visible: true });
    pages.push(front);
    await worker.push(payload());
    expect(worker.shownLog).toHaveLength(0);
    expect(front.messages).toEqual([{ type: 'lp-push', kind: 'in_medical', requestId: ID }]);
    // The badge still follows the unread count.
    expect(worker.badge()).toBe(3);
  });

  it('WebKit (an iPhone Home Screen app): shown silently and closed at once, so the subscription survives', async () => {
    const w = loadWorker({ version: 'p2', caches: new FakeCacheStorage(), network: new FakeNetwork(), active: 'p2', pages, userAgent: IPHONE_APP });
    pages.push(win('front', { focused: true, visible: true }));
    await w.push(payload({ renotify: true }));
    expect(w.shownLog).toHaveLength(1);
    expect(w.shownLog[0]?.options).toMatchObject({ silent: true, renotify: false });
    expect(w.notifications).toHaveLength(0);
  });

  it('WebKit with no window in front shows it normally', async () => {
    const w = loadWorker({ version: 'p3', caches: new FakeCacheStorage(), network: new FakeNetwork(), active: 'p3', pages, userAgent: IPHONE_APP });
    await w.push(payload());
    expect(w.notifications).toHaveLength(1);
    expect(w.notifications[0]?.options.silent).toBe(false);
  });

  it('a window of another site path (not the app) does not count as the app in front', async () => {
    pages.push({ ...win('x', { focused: true, visible: true }), url: 'https://other.example/' });
    await worker.push(payload());
    expect(worker.notifications).toHaveLength(1);
  });
});

describe('pushsubscriptionchange', () => {
  function recordingNetwork() {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const net = new FakeNetwork();
    const fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, net: Object.assign(net, { fetch }) as unknown as FakeNetwork };
  }
  const sub = (endpoint: string) => ({
    endpoint,
    options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'BPkeykeykeykeykeykey', auth: 'authauthauth' } }),
  });

  it('re-subscribes with the same key and tells the server, which drops the old endpoint', async () => {
    const { calls, net } = recordingNetwork();
    const asked: unknown[] = [];
    const w = loadWorker({
      version: 'p4',
      caches: new FakeCacheStorage(),
      network: net,
      active: 'p4',
      subscribe: async (o) => {
        asked.push(o);
        return sub('https://fcm.googleapis.com/fcm/send/new-1');
      },
    });
    await w.pushSubscriptionChange({ oldSubscription: sub('https://fcm.googleapis.com/fcm/send/old-1') });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ userVisibleOnly: true });
    expect(calls).toEqual([
      {
        url: '/api/push/subscribe',
        method: 'POST',
        body: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/new-1',
          keys: { p256dh: 'BPkeykeykeykeykeykey', auth: 'authauthauth' },
          oldEndpoint: 'https://fcm.googleapis.com/fcm/send/old-1',
        },
      },
    ]);
  });

  it('uses the new subscription the browser hands over', async () => {
    const { calls, net } = recordingNetwork();
    const w = loadWorker({ version: 'p5', caches: new FakeCacheStorage(), network: net, active: 'p5' });
    await w.pushSubscriptionChange({ newSubscription: sub('https://updates.push.services.mozilla.com/wpush/v2/n') });
    expect(calls[0]?.body).toMatchObject({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/n', oldEndpoint: null });
  });

  it('with neither subscription nor key it does nothing (no throw)', async () => {
    const { calls, net } = recordingNetwork();
    const w = loadWorker({ version: 'p6', caches: new FakeCacheStorage(), network: net, active: 'p6' });
    await w.pushSubscriptionChange({});
    expect(calls).toEqual([]);
  });
});

describe('lp-caps', () => {
  it('says this worker shows pushes', async () => {
    expect(await worker.message({ type: 'lp-caps' })).toEqual({ notificationClick: true, push: true });
  });
});

// lib/client/push-client.ts (F4, spec §18 A54, A55, A58): the subscription lifecycle with a fake browser:
// subscribe once permission is granted, from the tap; one subscription per device, told to the server once per
// page load and staff member (a different staff signing in re-binds it); a changed key or a rotated endpoint
// subscribes again; permission revoked later brings the banner back; sign-out removes it on the server and in
// the browser; a 401 removes it in the browser; push off on the server → no banner. Synthetic values only.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPushClient, keyBytes, pushHooksFor, sameKey, type PushClient, type PushHost, type SubscriptionLike } from '@/lib/client/push-client';
import type { Permission } from '@/lib/client/alerts-platform';
import { apiRequest } from '@/lib/client/http';

const KEY_A = 'BEaPyhQXb8N_tL40dgifi5XzkMxfyb9Fq-fyPyhDqG_owTqxDe7FG9PoHwIYVWkQFVaeTf0nbxe42jSDHlw0w28';
const KEY_B = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const DANA = 'Dana Kim · GC/HX - Dispatch';
const RAE = 'Rae Chen · Medical';

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

class FakeSub implements SubscriptionLike {
  unsubscribed = false;
  readonly options: { applicationServerKey: ArrayBuffer };
  constructor(
    readonly endpoint: string,
    key: string,
    private readonly host: FakeHost,
  ) {
    this.options = { applicationServerKey: keyBytes(key).buffer as ArrayBuffer };
  }
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: 'BPdevicekeydevicekeydevicekey', auth: 'authsecret12' } };
  }
  async unsubscribe() {
    this.unsubscribed = true;
    if (this.host.sub === this) this.host.sub = null;
    return true;
  }
}

class FakeHost implements PushHost {
  perm: Permission = 'default';
  /** What the user answers when asked. */
  answer: Permission = 'granted';
  sub: FakeSub | null = null;
  subscribeCalls = 0;
  subscribeFails = false;
  syncInTap: boolean[] = [];
  inTap = false;
  calls: Call[] = [];
  enabled = true;
  serverKey = KEY_A;
  prefs = { newRequests: false, myUpdates: true };
  subscribeStatus = 200;
  testSent = true;
  badges: number[] = [];
  store = new Map<string, string>();
  workerPush = true;
  private onChange: (() => void) | null = null;
  private seq = 0;

  device = () => ({ userAgent: DESKTOP, platform: 'MacIntel', maxTouchPoints: 0, standalone: false });
  hasServiceWorker = () => true;
  hasPushManager = () => true;
  hasNotification = () => true;
  permission = () => this.perm;
  requestPermission = async () => {
    this.perm = this.answer;
    return this.perm;
  };
  ready = () => Promise.resolve({ active: null });
  workerShowsPush = async () => this.workerPush;
  getSubscription = async () => this.sub;
  subscribe = (_reg: unknown, key: Uint8Array) => {
    this.subscribeCalls += 1;
    this.syncInTap.push(this.inTap);
    if (this.perm === 'default') this.perm = this.answer;
    if (this.perm !== 'granted' || this.subscribeFails) return Promise.reject(new Error('NotAllowedError'));
    this.seq += 1;
    let k = '';
    for (const b of key) k += String.fromCharCode(b);
    const keyText = btoa(k).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    this.sub = new FakeSub(`https://fcm.googleapis.com/fcm/send/device-${this.seq}`, keyText, this);
    return Promise.resolve(this.sub);
  };
  // The store's door (lib/client/f4-bridge.ts) over a fake fetch.
  request: PushHost['request'] = (path, opts) => apiRequest(this.fetch, path, opts);
  fetch = async (input: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    this.calls.push({ path: input, method: init?.method ?? 'GET', body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (input === '/api/push/prefs') {
      if (body && typeof body.newRequests === 'boolean') this.prefs.newRequests = body.newRequests;
      if (body && typeof body.myUpdates === 'boolean') this.prefs.myUpdates = body.myUpdates;
      return json({ enabled: this.enabled, publicKey: this.enabled ? this.serverKey : null, ...this.prefs });
    }
    if (input === '/api/push/subscribe' && init?.method === 'POST') {
      if (this.subscribeStatus !== 200) return json({ error: { code: 'invalid', message: 'x', field: 'endpoint' } }, this.subscribeStatus);
      return json({ enabled: true, publicKey: this.serverKey, ...this.prefs });
    }
    if (input === '/api/push/subscribe' && init?.method === 'DELETE') return json({ removed: true });
    if (input === '/api/push/test') return this.testSent ? json({ sent: true }) : json({ error: { code: 'not_found', message: 'x' } }, 404);
    return json({ error: { code: 'not_found', message: 'x' } }, 404);
  };
  storage = () => ({
    getItem: (k: string) => this.store.get(k) ?? null,
    setItem: (k: string, v: string) => void this.store.set(k, v),
    removeItem: (k: string) => void this.store.delete(k),
  });
  watch = (onChange: () => void) => {
    this.onChange = onChange;
    return () => undefined;
  };
  setBadge = (n: number) => void this.badges.push(n);
  /** focus / visibilitychange / a permission change. */
  fire() {
    this.onChange?.();
  }
  posts(path: string, method = 'POST') {
    return this.calls.filter((c) => c.path === path && c.method === method);
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

let host: FakeHost;

beforeEach(() => {
  host = new FakeHost();
});

describe('turning alerts on', () => {
  it('not asked yet: off, and the tap subscribes synchronously, then tells the server', async () => {
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    expect(client.getState().status).toBe('off');
    expect(host.subscribeCalls).toBe(0); // never asks on load
    host.inTap = true;
    const done = client.turnOn();
    host.inTap = false;
    expect(host.syncInTap).toEqual([true]); // subscribe() ran inside the tap
    await done;
    await settle();
    expect(client.getState()).toMatchObject({ status: 'on', subscribed: true, permission: 'granted' });
    const posts = host.posts('/api/push/subscribe');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: expect.any(String), auth: 'authsecret12' } });
    const hooks = pushHooksFor(() => client);
    expect(hooks.covers('in_medical')).toBe(true);
    expect(hooks.covers('combined')).toBe(false);
  });

  it('refused at the prompt: blocked (the banner shows the path)', async () => {
    host.answer = 'denied';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    await client.turnOn();
    await settle();
    expect(client.getState().status).toBe('blocked');
    expect(host.posts('/api/push/subscribe')).toHaveLength(0);
  });

  it('push off on the server (no VAPID keys): unsupported, never subscribes', async () => {
    host.enabled = false;
    host.perm = 'granted';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    expect(client.getState().status).toBe('unsupported');
    expect(host.subscribeCalls).toBe(0);
  });

  it('an active worker from before push: unsupported until it updates (a push would show nothing)', async () => {
    host.workerPush = false;
    host.perm = 'granted';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    expect(client.getState().status).toBe('unsupported');
    expect(host.subscribeCalls).toBe(0);
  });

  it('a push service the server refuses: unsupported (no banner)', async () => {
    host.perm = 'granted';
    host.subscribeStatus = 422;
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    expect(client.getState().status).toBe('unsupported');
  });
});

describe('an existing subscription', () => {
  it('permission granted on load: one subscription, told to the server once per page load', async () => {
    host.perm = 'granted';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    expect(client.getState().status).toBe('on');
    host.fire();
    host.fire();
    await settle();
    expect(host.subscribeCalls).toBe(1);
    expect(host.posts('/api/push/subscribe')).toHaveLength(1);
  });

  it('a different staff signing in re-binds the same device', async () => {
    host.perm = 'granted';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    client.start(RAE);
    await settle();
    expect(host.subscribeCalls).toBe(1);
    const posts = host.posts('/api/push/subscribe');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body?.endpoint).toBe(posts[0]?.body?.endpoint);
  });

  it('a changed server key: unsubscribe and subscribe again', async () => {
    host.perm = 'granted';
    let client = createPushClient(host);
    client.start(DANA);
    await settle();
    const first = host.sub;
    host.serverKey = KEY_B;
    client = createPushClient(host); // the next page load
    client.start(DANA);
    await settle();
    expect(first?.unsubscribed).toBe(true);
    expect(host.subscribeCalls).toBe(2);
    expect(sameKey(host.sub as SubscriptionLike, keyBytes(KEY_B))).toBe(true);
    expect(client.getState().status).toBe('on');
  });

  it('a rotated endpoint is sent with the old one, which the server drops', async () => {
    host.perm = 'granted';
    createPushClient(host).start(DANA);
    await settle();
    // The browser rotated the subscription while the app was closed.
    host.sub = null;
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    const posts = host.posts('/api/push/subscribe');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-2', oldEndpoint: 'https://fcm.googleapis.com/fcm/send/device-1' });
  });

  it('permission revoked later: not subscribed, the banner returns (blocked)', async () => {
    host.perm = 'granted';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    host.perm = 'denied';
    host.fire();
    await settle();
    expect(client.getState()).toMatchObject({ status: 'blocked', subscribed: false });
    expect(pushHooksFor(() => client).covers('in_medical')).toBe(false);
  });

  it('allowed again in the site settings: re-check subscribes without asking', async () => {
    host.perm = 'denied';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    expect(client.getState().status).toBe('blocked');
    host.perm = 'granted';
    client.recheck();
    await settle();
    expect(client.getState().status).toBe('on');
  });
});

describe('switches and the test alert', () => {
  it('reads the switches (with the phone bell as the default) and changes them server-side', async () => {
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    expect(host.posts('/api/push/prefs')[0]?.body).toEqual({ bell: false });
    expect(client.getState().prefs).toEqual({ newRequests: false, myUpdates: true });
    expect(await client.setPrefs({ newRequests: true })).toBe(true);
    expect(client.getState().prefs).toEqual({ newRequests: true, myUpdates: true });
    expect(host.posts('/api/push/prefs').at(-1)?.body).toEqual({ newRequests: true });
  });

  it('sends a test alert to this device only', async () => {
    host.perm = 'granted';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    expect(await client.sendTest()).toBe(true);
    expect(host.posts('/api/push/test')[0]?.body).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-1' });
    expect(client.getState().tested).toBe(true);
  });
});

describe('lifecycle', () => {
  it('sign-out: the server forgets it, the browser drops it, the badge clears', async () => {
    host.perm = 'granted';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    const sub = host.sub;
    await client.onSignOut();
    expect(host.posts('/api/push/subscribe', 'DELETE')[0]?.body).toEqual({ endpoint: sub?.endpoint });
    expect(sub?.unsubscribed).toBe(true);
    expect(client.getState()).toMatchObject({ subscribed: false, status: 'checking' });
    expect(host.badges.at(-1)).toBe(0);
    expect(pushHooksFor(() => client).covers('in_medical')).toBe(false);
    expect(host.store.size).toBe(0);
  });

  it('a 401: the browser drops it (the server cannot be told without a session)', async () => {
    host.perm = 'granted';
    const client = createPushClient(host);
    client.start(DANA);
    await settle();
    const sub = host.sub;
    await client.onSessionEnded();
    expect(sub?.unsubscribed).toBe(true);
    expect(host.posts('/api/push/subscribe', 'DELETE')).toHaveLength(0);
    // Signing in again subscribes again (permission is still granted).
    client.start(DANA);
    await settle();
    expect(client.getState().status).toBe('on');
    expect(host.subscribeCalls).toBe(2);
  });

  it('the store’s hooks never reject, and a sign-out goes on after the wait however the server answers', async () => {
    const stuck = {
      getState: () => ({ subscribed: true }),
      onSignOut: () => new Promise<void>(() => undefined),
      onSessionEnded: () => Promise.reject(new Error('gone')),
    } as unknown as PushClient;
    const hooks = pushHooksFor(() => stuck, 20);
    const started = Date.now();
    await expect(hooks.onSignOut()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(() => hooks.onSessionEnded()).not.toThrow();
    const failing = { ...stuck, onSignOut: () => Promise.reject(new Error('offline')) } as unknown as PushClient;
    await expect(pushHooksFor(() => failing, 1_000).onSignOut()).resolves.toBeUndefined();
  });
});

// Sending (lib/client/telemetry/send.ts, design §4.4): only when quiet, spacing (60 s discrete, 300 s counts only),
// gzip where CompressionStream exists, the answers (200 settings and skew, 204 off for 30 min, 401 pause, 413/422
// drop, 5xx keep and back off 5 min, 3 tries then drop, capped pauses to the next hour), and the hidden page's beacon.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBuffer, type StoredBatch } from '@/lib/client/telemetry/buffer';
import { Sender, gzipText, nextHour, type SenderDeps } from '@/lib/client/telemetry/send';
import { TEL_KEYS } from '@/lib/telemetry';
import { FakeStorage, MemoryBatchStore } from './fakes';

interface Setup {
  sender: Sender;
  buffer: EventBuffer;
  store: MemoryBatchStore;
  storage: FakeStorage;
  posts: Array<{ url: string; init: RequestInit; body: unknown }>;
  beacons: Array<{ url: string; body: string }>;
  quiet: { v: boolean };
  online: { v: boolean };
  answer: { status: number; body?: unknown; throws?: boolean };
  off: { n: number };
  answers: unknown[];
}

function setup(over: Partial<SenderDeps> = {}): Setup {
  const buffer = new EventBuffer();
  const store = new MemoryBatchStore();
  const storage = new FakeStorage();
  const posts: Setup['posts'] = [];
  const beacons: Setup['beacons'] = [];
  const quiet = { v: true };
  const online = { v: true };
  const answer: Setup['answer'] = { status: 200, body: { on: true, until: Date.now() + 86_400_000, flushSeconds: 60, sample: 1, now: Date.now() } };
  const off = { n: 0 };
  const answers: unknown[] = [];
  const sender = new Sender({
    now: () => Date.now(),
    fetch: async (url, init) => {
      const raw = init.body;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
      posts.push({ url, init, body });
      if (answer.throws) throw new TypeError('Load failed');
      return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), { status: answer.status });
    },
    beacon: (url, body) => {
      beacons.push({ url, body });
      return true;
    },
    compress: async () => null,
    online: () => online.v,
    kv: { get: (k) => storage.getItem(k), set: (k, v) => storage.setItem(k, v), remove: (k) => storage.removeItem(k) },
    store,
    buffer,
    envelope: () => ({ d: 'device0000000001', ctx: { plat: 'ios' } }),
    session: 'sess000001',
    quiet: () => quiet.v,
    idle: (fn) => fn(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    random: Math.random,
    onOff: () => (off.n += 1),
    onAnswer: (a) => answers.push(a),
    onAuth: () => undefined,
    ...over,
  });
  return { sender, buffer, store, storage, posts, beacons, quiet, online, answer, off, answers };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 9, 3, 0, 0) }));
afterEach(() => vi.useRealTimers());

describe('when to send', () => {
  it('never while not quiet (hidden, offline, syncing, a job sending, a request in flight, a recent tap)', async () => {
    const t = setup();
    t.buffer.push({ n: 'view', at: Date.now() });
    t.quiet.v = false;
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(0);
    t.quiet.v = true;
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(1);
  });

  it('60 s between sends for discrete events, 300 s when only counts wait', async () => {
    const t = setup();
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    t.buffer.push({ n: 'view', at: Date.now() });
    vi.advanceTimersByTime(59_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(2);
    t.buffer.agg('tap', () => ({ n: 'tap', at: Date.now(), k: 0 }), (e) => (e.k = 1));
    vi.advanceTimersByTime(120_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(2);
    vi.advanceTimersByTime(181_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(3);
  });

  it('the request: POST /api/telemetry, same-origin, no-store, low priority, the envelope with the session and device', async () => {
    const t = setup();
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    const [post] = t.posts;
    expect(post?.url).toBe('/api/telemetry');
    expect(post?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', priority: 'low', keepalive: false, headers: { 'Content-Type': 'application/json' } });
    expect(post?.body).toMatchObject({ v: 1, d: 'device0000000001', s: 'sess000001', ctx: { plat: 'ios' }, ev: [{ n: 'view' }] });
    expect((post?.body as { b: string }).b).toMatch(/^[a-z0-9]{12}$/);
  });

  it('gzip with CompressionStream where it exists, plain JSON without', async () => {
    const gz = setup({ compress: async (text) => new TextEncoder().encode(`gz:${text}`).buffer as ArrayBuffer });
    gz.buffer.push({ n: 'view', at: Date.now() });
    gz.sender.maybeSend();
    await flush();
    expect(gz.posts[0]?.init.headers).toEqual({ 'Content-Type': 'application/x-lp-tel+gzip' });
    vi.useRealTimers();
    const out = await gzipText('{"a":1}');
    if (typeof CompressionStream !== 'undefined') expect(new Uint8Array(out as ArrayBuffer).slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
  });
});

describe('answers', () => {
  it('200: the batch is gone; the settings and the clock go to onAnswer; capped pauses to the next hour', async () => {
    const t = setup();
    t.answer.body = { on: true, until: 123, flushSeconds: 120, sample: 0.5, now: Date.now(), capped: true };
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    expect(t.answers).toEqual([expect.objectContaining({ until: 123, sample: 0.5, capped: true })]);
    expect(t.store.map.size).toBe(0);
    t.buffer.push({ n: 'view', at: Date.now() });
    vi.advanceTimersByTime(130_000);
    expect(t.sender.due()).toBe(nextHour(Date.now() - 130_000) <= Date.now());
  });

  it('204: everything stops, the buffers are cleared and the next probe is 30 min away', async () => {
    const t = setup();
    t.answer.status = 204;
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    expect(t.off.n).toBe(1);
    expect(Number(t.storage.getItem(TEL_KEYS.off))).toBe(Date.now() + 30 * 60_000);
    t.buffer.push({ n: 'view', at: Date.now() });
    vi.advanceTimersByTime(600_000);
    expect(t.sender.due()).toBe(false);
  });

  it('401: dropped, and nothing more until the session is active again', async () => {
    const t = setup();
    t.answer.status = 401;
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    expect(t.store.map.size).toBe(0);
    t.buffer.push({ n: 'view', at: Date.now() });
    vi.advanceTimersByTime(120_000);
    expect(t.sender.due()).toBe(false);
    t.sender.resumeAuth();
    expect(t.sender.due()).toBe(true);
  });

  it('413 / 422: dropped for good', async () => {
    for (const status of [413, 422]) {
      const t = setup();
      t.answer.status = status;
      t.buffer.push({ n: 'view', at: Date.now() });
      t.sender.maybeSend();
      await flush();
      expect(t.store.map.size).toBe(0);
      expect(t.sender.storedCount).toBe(0);
    }
  });

  it('5xx / network: kept in IndexedDB, tried again after 5 min with the same batch id, dropped after 3 tries', async () => {
    const t = setup();
    t.answer.status = 503;
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    const ids = new Set(t.posts.map((p) => (p.body as { b: string }).b));
    expect(t.store.map.size).toBe(1);
    vi.advanceTimersByTime(299_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(1);
    t.answer.throws = true;
    vi.advanceTimersByTime(2_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(2);
    vi.advanceTimersByTime(301_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(3);
    for (const p of t.posts) ids.add((p.body as { b: string }).b);
    expect(ids.size).toBe(1);
    expect(t.store.map.size).toBe(0);
    vi.advanceTimersByTime(301_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(3);
  });

  it('the probe: an empty batch marked probe: 1; on again only on a 200', async () => {
    const t = setup();
    expect(await t.sender.probe()).toBe(true);
    expect(t.posts[0]?.body).toMatchObject({ probe: 1, ev: [] });
    const off = setup();
    off.answer.status = 204;
    expect(await off.sender.probe()).toBe(false);
    const signedOut = setup();
    signedOut.answer.status = 401;
    expect(await signedOut.sender.probe()).toBe(false);
  });
});

describe('a hidden page', () => {
  it('builds one batch, stores it, and hands it to sendBeacon (online only); the next start sends it again with the same id', async () => {
    const t = setup();
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.flushHidden();
    await flush();
    expect(t.beacons).toHaveLength(1);
    const beaconed = JSON.parse(t.beacons[0]?.body ?? '{}') as { b: string; ev: unknown[] };
    expect(beaconed.ev).toHaveLength(1);
    expect([...t.store.map.values()]).toEqual([expect.objectContaining({ b: beaconed.b, beacon: true })]);
    // Same page: the beacon copy is not resent.
    vi.advanceTimersByTime(120_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(0);
    // The next start: it goes again (the server drops the repeat).
    const next = setup({ store: t.store });
    await next.sender.load();
    next.sender.maybeSend();
    await flush();
    expect((next.posts[0]?.body as { b: string }).b).toBe(beaconed.b);
  });

  it('offline: no beacon, the batch waits in IndexedDB', async () => {
    const t = setup();
    t.online.v = false;
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.flushHidden();
    await flush();
    expect(t.beacons).toHaveLength(0);
    expect([...t.store.map.values()][0]).toMatchObject({ beacon: false } satisfies Partial<StoredBatch>);
  });
});

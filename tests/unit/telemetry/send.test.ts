// Sending (lib/client/telemetry/send.ts, design §4.4): only when quiet, spacing (60 s discrete, 300 s counts only),
// gzip where CompressionStream exists, the answers (200 settings and skew, 204 off for 30 min, 401 pause, 413/422
// drop, 5xx keep and back off 5 min, 3 tries then drop, capped pauses to the next hour), stepping aside for the app's
// own requests, and the hidden page's beacon (only when the app is idle and it can be accepted; never kept after).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBuffer, type StoredBatch } from '@/lib/client/telemetry/buffer';
import { BEACON_MAX_BYTES, Sender, gzipText, nextHour, type SenderDeps } from '@/lib/client/telemetry/send';
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
  canBeacon: { v: boolean };
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
  const canBeacon = { v: true };
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
    canBeacon: () => canBeacon.v,
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
  return { sender, buffer, store, storage, posts, beacons, quiet, online, canBeacon, answer, off, answers };
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

describe('stepping aside for the app', () => {
  /** A fetch that only ends when it is aborted (a slow festival link). */
  const hanging = (posts: Setup['posts']) => async (url: string, init: RequestInit) => {
    posts.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  };

  it('a send in flight is aborted when the app starts a request: the batch is kept, no try counted, no backoff', async () => {
    const posts: Setup['posts'] = [];
    const t = setup({ fetch: hanging(posts) });
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    expect(posts).toHaveLength(1);
    t.sender.yieldToApp();
    await flush();
    expect(t.sender.storedCount).toBe(1);
    expect([...t.store.map.values()]).toEqual([expect.objectContaining({ b: (posts[0]?.body as { b: string }).b, tries: 0 })]);
    // Not the 5-minute backoff: the next quiet, due moment (a minute on) sends it again, same id.
    vi.advanceTimersByTime(61_000);
    expect(t.sender.due()).toBe(true);
  });

  it('an abort by the 8 s timeout is a failed try (backoff), not a step aside', async () => {
    const posts: Setup['posts'] = [];
    const t = setup({ fetch: hanging(posts) });
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    vi.advanceTimersByTime(8_000);
    await flush();
    expect([...t.store.map.values()]).toEqual([expect.objectContaining({ tries: 1 })]);
    vi.advanceTimersByTime(61_000);
    expect(t.sender.due()).toBe(false);
  });

  it('nothing in flight: yieldToApp does nothing', async () => {
    const t = setup();
    t.sender.yieldToApp();
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(1);
    expect(t.sender.storedCount).toBe(0);
  });
});

describe('a hidden page', () => {
  it('hands one batch to sendBeacon (online, the app idle) and keeps no copy: nothing is sent again, now or at the next start', async () => {
    const t = setup();
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.flushHidden();
    await flush();
    expect(t.beacons).toHaveLength(1);
    const beaconed = JSON.parse(t.beacons[0]?.body ?? '{}') as { b: string; ev: unknown[] };
    expect(beaconed.ev).toHaveLength(1);
    expect(t.store.map.size).toBe(0);
    vi.advanceTimersByTime(120_000);
    t.sender.maybeSend();
    await flush();
    expect(t.posts).toHaveLength(0);
    const next = setup({ store: t.store });
    await next.sender.load();
    next.sender.maybeSend();
    await flush();
    expect(next.posts).toHaveLength(0);
  });

  it('the app busy (or a beacon this engine would have refused): no beacon, the batch waits in IndexedDB and goes when visible', async () => {
    const t = setup();
    t.canBeacon.v = false;
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.flushHidden();
    await flush();
    expect(t.beacons).toHaveLength(0);
    const [stored] = [...t.store.map.values()];
    expect(stored?.ev).toHaveLength(1);
    t.sender.maybeSend();
    await flush();
    expect((t.posts[0]?.body as { b: string }).b).toBe(stored?.b);
  });

  it('offline: no beacon, the batch waits in IndexedDB', async () => {
    const t = setup();
    t.online.v = false;
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.flushHidden();
    await flush();
    expect(t.beacons).toHaveLength(0);
    expect([...t.store.map.values()][0]).toMatchObject({ tries: 0 } satisfies Partial<StoredBatch>);
  });
});

// (network fix 8, 2026-11-08) The worst cases stay idle-only: a beacon never carries more than 8 KB (it could still be
// uploading when the phone is reopened seconds later), and a batch that keeps stepping aside for the app is split.
describe('worst cases (fix 8)', () => {
  it('a batch over 8 KB is not beaconed: it waits in IndexedDB for an idle (gzip) send', async () => {
    const t = setup();
    for (let i = 0; i < 300; i += 1) t.buffer.push({ n: 'view', at: Date.now() + i });
    t.sender.flushHidden();
    await flush();
    expect(t.beacons).toHaveLength(0);
    const [stored] = [...t.store.map.values()];
    expect(stored?.ev.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored?.ev).length).toBeGreaterThan(BEACON_MAX_BYTES);
    t.sender.maybeSend();
    await flush();
    expect((t.posts[0]?.body as { b: string }).b).toBe(stored?.b);
  });

  it('a small batch is still beaconed', async () => {
    const t = setup();
    t.buffer.push({ n: 'view', at: Date.now() });
    t.sender.flushHidden();
    await flush();
    expect(t.beacons).toHaveLength(1);
  });

  it('three yields in a row split the batch in two (the first half keeps the id); then each goes on its own', async () => {
    const posts: Setup['posts'] = [];
    const hang = async (url: string, init: RequestInit) => {
      posts.push({ url, init, body: JSON.parse(String(init.body)) });
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    };
    const t = setup({ fetch: hang });
    for (let i = 0; i < 10; i += 1) t.buffer.push({ n: 'view', at: Date.now() + i });
    for (let round = 0; round < 3; round += 1) {
      if (round) vi.advanceTimersByTime(61_000);
      t.sender.maybeSend();
      await flush();
      t.sender.yieldToApp();
      await flush();
    }
    expect(posts).toHaveLength(3);
    const id = (posts[0]?.body as { b: string }).b;
    expect(posts.every((p) => (p.body as { b: string }).b === id)).toBe(true);
    const stored = [...t.store.map.values()];
    expect(stored).toHaveLength(2);
    expect(stored.map((b) => b.ev.length).sort()).toEqual([5, 5]);
    expect(stored.find((b) => b.b === id)?.ev.map((e) => e.at)).toEqual(Array.from({ length: 5 }, (_, i) => Date.now() - 2 * 61_000 + i));
    expect(stored.every((b) => b.tries === 0)).toBe(true);
    // Two yields only: not split.
    const u = setup({ fetch: hang });
    for (let i = 0; i < 10; i += 1) u.buffer.push({ n: 'view', at: Date.now() + i });
    for (let round = 0; round < 2; round += 1) {
      if (round) vi.advanceTimersByTime(61_000);
      u.sender.maybeSend();
      await flush();
      u.sender.yieldToApp();
      await flush();
    }
    expect([...u.store.map.values()]).toHaveLength(1);
  });
});

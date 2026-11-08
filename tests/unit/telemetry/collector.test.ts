// The collector against the app (lib/client/telemetry/index.ts): it never competes with the app's own work. A send in
// flight steps aside when the app starts a request (kept, not a try); the hide and pagehide listeners are bubble phase
// (after the store's own "save now"); a hidden page beacons only when nothing of the app is in flight and the beacon
// can be accepted (an iPhone before Safari 16.4 sends Origin: null without Sec-Fetch-Site); an api `slow` goes out once
// per pattern per minute with `k` counting the ones it stands for.
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTelemetry, type TelemetryHandle } from '@/lib/client/telemetry';
import { MemoryBatchStore, fakeBrowser, fakeHost, fakeStore, type FakeStore, type Fakes } from './fakes';

let f: Fakes;
let handle: TelemetryHandle | null = null;
let batches: MemoryBatchStore;
let store: FakeStore;

const ok = () => Promise.resolve(new Response(JSON.stringify({ on: true, until: Date.now() + 86_400_000, flushSeconds: 60, sample: 1, now: Date.now(), rejected: 0 }), { status: 200 }));
const hang = (init: RequestInit | undefined) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
const telPosts = () => f.fetchCalls.filter((c) => c.url === '/api/telemetry');

function sentEvents(): Array<{ n: string; k?: number; tr?: unknown[] }> {
  const out: Array<{ n: string; k?: number; tr?: unknown[] }> = [];
  for (const c of telPosts()) {
    const body = c.init?.body;
    const text = typeof body === 'string' ? body : gunzipSync(Buffer.from(body as ArrayBuffer)).toString('utf8');
    out.push(...(JSON.parse(text) as { ev: typeof out }).ev);
  }
  for (const b of f.beacons) out.push(...(JSON.parse(b.body) as { ev: typeof out }).ev);
  return out;
}

async function start(opts: Parameters<typeof fakeBrowser>[0] = {}): Promise<void> {
  f = fakeBrowser(opts);
  f.respond = (url) => (url === '/api/telemetry' ? ok() : Promise.resolve(new Response('{}', { status: 200 })));
  batches = new MemoryBatchStore();
  store = fakeStore({ connection: 'live' });
  handle = startTelemetry(fakeHost(f, store, () => ({ name: 'all' }), batches));
  await vi.advanceTimersByTimeAsync(50);
  expect(handle.running()).toBe(true);
}

const hide = async () => {
  f.doc.visibilityState = 'hidden';
  f.doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(10);
};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 9, 3, 0, 0) });
  // Plain JSON bodies: Node's gzip finishes on the real event loop, outside the fake clock.
  vi.stubGlobal('CompressionStream', undefined);
});
afterEach(() => {
  handle?.stop();
  handle = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the collector and the app', () => {
  it('a telemetry send in flight is aborted the moment the app starts a request; its batch is kept, not counted as a try', async () => {
    await start();
    f.respond = (url, init) => (url === '/api/telemetry' ? hang(init) : Promise.resolve(new Response('{}', { status: 200 })));
    await vi.advanceTimersByTimeAsync(31_000);
    const [post] = telPosts();
    expect(post).toBeDefined();
    expect(post?.init?.signal?.aborted).toBe(false);
    await f.win.fetch('/api/sync?since=1');
    await vi.advanceTimersByTimeAsync(10);
    expect(post?.init?.signal?.aborted).toBe(true);
    expect([...batches.map.values()]).toEqual([expect.objectContaining({ tries: 0 })]);
  });

  it('back in front: nothing is sent in the resume itself; the send waits for the sync that follows', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(telPosts()).toHaveLength(1);
    f.respond = (url) => (url === '/api/telemetry' ? ok() : Promise.resolve(new Response('{}', { status: 200 })));
    await hide();
    await vi.advanceTimersByTimeAsync(60_000);
    f.doc.visibilityState = 'visible';
    f.doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(telPosts()).toHaveLength(1);
    store.set({ syncing: true });
    store.set({ syncing: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(telPosts()).toHaveLength(2);
  });

  it('visibilitychange and pagehide listen in the bubble phase (after the store’s own hide work)', async () => {
    const seen: Array<[string, unknown]> = [];
    f = fakeBrowser();
    for (const target of [f.doc, f.win] as EventTarget[]) {
      const add = target.addEventListener.bind(target);
      target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: AddEventListenerOptions) => {
        if (type === 'visibilitychange' || type === 'pagehide') seen.push([type, o?.capture]);
        add(type, fn, o);
      }) as typeof target.addEventListener;
    }
    f.respond = () => ok();
    handle = startTelemetry(fakeHost(f, fakeStore({ connection: 'live' }), () => ({ name: 'all' }), new MemoryBatchStore()));
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toEqual([
      ['visibilitychange', false],
      ['pagehide', false],
    ]);
  });

  it('hidden with nothing of the app in flight: one beacon, and no copy kept', async () => {
    await start();
    await hide();
    expect(f.beacons).toHaveLength(1);
    expect(batches.map.size).toBe(0);
  });

  it('hidden while an app request is in flight: no beacon; the batch waits in IndexedDB', async () => {
    await start();
    f.respond = (url, init) => (url === '/api/telemetry' ? ok() : hang(init));
    void f.win.fetch('/api/requests/0f0f0f0f-0000-4000-8000-000000000044/messages', { method: 'POST' });
    await hide();
    expect(f.beacons).toHaveLength(0);
    expect(batches.map.size).toBe(1);
  });

  it('an iPhone before Safari 16.4 (no CompressionStream): no beacon it would refuse; the batch waits in IndexedDB', async () => {
    await start({ noCompressionStream: true });
    await hide();
    expect(f.beacons).toHaveLength(0);
    expect(batches.map.size).toBe(1);
  });

  it('a slow api pattern: one slow event (with its trail) per minute, k counting the slow ones it stands for', async () => {
    await start();
    f.respond = (url) =>
      url === '/api/telemetry' ? ok() : new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('{}', { status: 200 })), 4_000));
    for (const at of [0, 10_000, 20_000]) {
      await vi.advanceTimersByTimeAsync(at === 0 ? 0 : 10_000);
      void f.win.fetch('/api/sync?since=1');
    }
    await vi.advanceTimersByTimeAsync(46_000);
    void f.win.fetch('/api/sync?since=1');
    await vi.advanceTimersByTimeAsync(4_100);
    await hide();
    const slow = sentEvents().filter((e) => e.n === 'slow');
    expect(slow.map((e) => e.k)).toEqual([1, 3]);
    expect(slow.every((e) => Array.isArray(e.tr))).toBe(true);
  });
});

// The pass-through fetch observer (lib/client/telemetry/net.ts, design §4.3): the app gets THE SAME promise its own
// fetch returned, resolutions and rejections pass through untouched, a throwing recorder changes nothing, telemetry and
// non-API paths are ignored, timeout versus abort by elapsed time, stop() restores fetch only when it is still ours.
import { describe, expect, it, vi } from 'vitest';
import { apiEntry, observeFetch, statusOf, type NetEnd, type NetStart } from '@/lib/client/telemetry/net';

function setup(answer: (url: string) => Promise<Response>) {
  const native = vi.fn((input: RequestInfo | URL) => answer(String(input)));
  const target = { fetch: native as unknown as typeof fetch };
  const starts: NetStart[] = [];
  const ends: NetEnd[] = [];
  let now = 1_000;
  const faults = { n: 0 };
  const obs = observeFetch(target, {
    now: () => now,
    origin: 'https://lp.test',
    start: (r) => starts.push(r),
    end: (r) => ends.push(r),
    fault: () => (faults.n += 1),
  });
  return { target, native, obs, starts, ends, faults, tick: (ms: number) => (now += ms) };
}

describe('fetch observer', () => {
  it('returns the identical promise the page’s fetch returned, and records start and end', async () => {
    const res = new Response('{}', { status: 200 });
    let promise: Promise<Response> | null = null;
    const t = setup(() => (promise = Promise.resolve(res)));
    const got = t.target.fetch('/api/sync?since=x');
    expect(got).toBe(promise);
    expect(await got).toBe(res);
    await Promise.resolve();
    expect(t.starts).toEqual([expect.objectContaining({ pattern: '/api/sync:delta', method: 'get' })]);
    expect(t.ends).toEqual([expect.objectContaining({ st: '2xx' })]);
    expect(t.obs.inflight()).toBe(0);
  });

  it('a rejection passes through untouched (same error object) and is recorded as net', async () => {
    const error = new TypeError('Load failed');
    const t = setup(() => Promise.reject(error));
    await expect(t.target.fetch('/api/requests', { method: 'POST' })).rejects.toBe(error);
    await Promise.resolve();
    expect(t.ends).toEqual([expect.objectContaining({ pattern: '/api/requests', method: 'post', st: 'net' })]);
  });

  it('timeout versus abort from the elapsed time', async () => {
    const abort = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    let reject: (e: unknown) => void = () => undefined;
    const t = setup(() => new Promise((_, r) => (reject = r)));
    const p1 = t.target.fetch('/api/sync').catch(() => undefined);
    t.tick(11_900);
    reject(abort());
    await p1;
    const p2 = t.target.fetch('/api/sync').catch(() => undefined);
    t.tick(2_000);
    reject(abort());
    await p2;
    await Promise.resolve();
    expect(t.ends.map((e) => e.st)).toEqual(['timeout', 'abort']);
  });

  it('a recorder that throws never reaches the app', async () => {
    const res = new Response('{}');
    const native = vi.fn(() => Promise.resolve(res));
    const target = { fetch: native as unknown as typeof fetch };
    let faults = 0;
    observeFetch(target, {
      now: () => 0,
      origin: 'https://lp.test',
      start: () => {
        throw new Error('boom');
      },
      end: () => {
        throw new Error('boom');
      },
      fault: () => (faults += 1),
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    expect(await target.fetch('/api/stats')).toBe(res);
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(faults).toBeGreaterThan(0);
  });

  it('/api/telemetry, other paths and other origins are not watched; Request objects are read by url and method only', async () => {
    const t = setup(() => Promise.resolve(new Response(null, { status: 204 })));
    await t.target.fetch('/api/telemetry', { method: 'POST' });
    await t.target.fetch('/_next/static/chunks/x.js');
    await t.target.fetch('https://elsewhere.test/api/sync');
    await t.target.fetch(new URL('https://lp.test/api/requests/0f0f0f0f-0000-4000-8000-000000000044/status'), { method: 'POST' });
    await Promise.resolve();
    expect(t.starts.map((s) => `${s.method} ${s.pattern}`)).toEqual(['post /api/requests/:id/status']);
    expect(t.native).toHaveBeenCalledTimes(4);
  });

  it('stop() restores the page’s fetch, but never someone else’s', () => {
    const t = setup(() => Promise.resolve(new Response('{}')));
    expect(t.target.fetch).not.toBe(t.native);
    t.obs.stop();
    expect(t.target.fetch).toBe(t.native);
    const t2 = setup(() => Promise.resolve(new Response('{}')));
    const other = vi.fn() as unknown as typeof fetch;
    t2.target.fetch = other;
    t2.obs.stop();
    expect(t2.target.fetch).toBe(other);
  });

  it('status classes as lib/client/http.ts reads them', () => {
    expect(statusOf({ status: 201 })).toBe('2xx');
    expect(statusOf({ status: 200, redirected: true })).toBe('net');
    expect(statusOf({ status: 511 })).toBe('net');
    expect(statusOf({ status: 401 })).toBe('401');
    expect(statusOf({ status: 422 })).toBe('4xx');
    expect(statusOf({ status: 503 })).toBe('5xx');
  });

  it('resource entries: API paths only, status where the engine has it', () => {
    expect(apiEntry({ name: 'https://lp.test/api/sync?since=x', startTime: 1, duration: 2 }, 'https://lp.test')).toEqual({ pattern: '/api/sync:delta', st: 'unk' });
    expect(apiEntry({ name: 'https://lp.test/api/stats', startTime: 1, duration: 2, responseStatus: 200 }, 'https://lp.test')).toEqual({ pattern: '/api/stats', st: '2xx' });
    expect(apiEntry({ name: 'https://lp.test/api/telemetry', startTime: 1, duration: 2 }, 'https://lp.test')).toBeNull();
    expect(apiEntry({ name: 'https://lp.test/icons/x.png', startTime: 1, duration: 2 }, 'https://lp.test')).toBeNull();
  });
});

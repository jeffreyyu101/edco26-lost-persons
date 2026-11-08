// (network fix 1c, 2026-11-08) The deploy check (lib/client/sw-client.ts: a `GET /` to compare the script set) never
// competes with the sync a resume starts: it goes out 8 s after the page shows, only if the page is still visible,
// at most once per 5 minutes, and the 10-minute interval (which a locked phone runs on unlock) waits the same.
// A fake document / service worker; synthetic URLs only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HTML = '<script src="/_next/static/chunks/app-a.js"></script>';

async function setup() {
  let visibility: 'visible' | 'hidden' = 'visible';
  const listeners = new Set<() => void>();
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibility;
    },
    scripts: [{ src: 'https://lp.test/_next/static/chunks/app-a.js' }],
    addEventListener: (_type: string, h: () => void) => listeners.add(h),
    removeEventListener: (_type: string, h: () => void) => listeners.delete(h),
    querySelectorAll: () => [],
  });
  vi.stubGlobal('window', { location: { origin: 'https://lp.test', reload: vi.fn() } });
  const register = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { serviceWorker: { register, addEventListener: vi.fn(), removeEventListener: vi.fn(), controller: null } });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(HTML, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  const { startServiceWorker } = await import('@/lib/client/sw-client');
  const controller = startServiceWorker({ onUpdateReady: vi.fn(), onOfflineReady: vi.fn() });
  const set = (v: 'visible' | 'hidden') => {
    visibility = v;
    for (const l of [...listeners]) l();
  };
  const checks = () => fetch.mock.calls.filter(([url]) => url === '/').length;
  return { controller, set, checks, fetch };
}

const step = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-08T03:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the deploy check after a resume (fix 1c)', () => {
  it('sends nothing at visible t=0; one GET / 8 s later while still visible', async () => {
    const { set, checks, fetch, controller } = await setup();
    expect(controller).not.toBeNull();
    set('hidden');
    await step(6 * 60_000);
    set('visible');
    await step(0);
    expect(checks()).toBe(0);
    await step(7_900);
    expect(checks()).toBe(0);
    await step(200);
    expect(checks()).toBe(1);
    // The same HTML with or without an Accept header: none is sent.
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).has('accept')).toBe(false);
  });

  it('a glance shorter than 8 s sends nothing', async () => {
    const { set, checks } = await setup();
    set('hidden');
    await step(6 * 60_000);
    set('visible');
    await step(5_000);
    set('hidden');
    await step(60_000);
    expect(checks()).toBe(0);
  });

  it('at most one per 5 minutes across resumes', async () => {
    const { set, checks } = await setup();
    set('hidden');
    await step(6 * 60_000);
    set('visible');
    await step(10_000);
    expect(checks()).toBe(1);
    set('hidden');
    await step(60_000);
    set('visible');
    await step(10_000);
    expect(checks()).toBe(1);
  });

  it('the 10-minute interval is deferred too', async () => {
    const { checks } = await setup();
    await step(10 * 60_000);
    expect(checks()).toBe(0);
    await step(8_000);
    expect(checks()).toBe(1);
  });

  it('stop() drops a pending check', async () => {
    const { set, checks, controller } = await setup();
    set('hidden');
    await step(6 * 60_000);
    set('visible');
    controller?.stop();
    await step(30_000);
    expect(checks()).toBe(0);
  });
});

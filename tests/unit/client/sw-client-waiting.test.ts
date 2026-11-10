// (Cut-over fix A3) lib/client/sw-client.ts checkWaiting: a waiting worker is "Update ready" only when it is another
// build than the page runs. The same script URL as the controller (a second install of the same worker), or a worker
// of this page's own build (the page came from the network under an older worker: a sign-in on a phone that held the
// old build) takes over quietly: skip-waiting, no reload, no toast. A fake document / service worker; synthetic URLs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OURS = 'https://lp.test/_next/static/chunks/app-a.js';

async function setup(opts: { controller: string; waiting: string | ((ownBuild: string) => string) }) {
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    scripts: [{ src: OURS }],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: () => [],
  });
  const reload = vi.fn();
  vi.stubGlobal('window', { location: { origin: 'https://lp.test', reload } });
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  const { startServiceWorker, buildIdFrom } = await import('@/lib/client/sw-client');
  const own = buildIdFrom([OURS]);
  const waitingUrl = typeof opts.waiting === 'function' ? opts.waiting(own) : opts.waiting;
  const toWaiting: unknown[] = [];
  const waiting = { scriptURL: `https://lp.test${waitingUrl}`, postMessage: (m: unknown) => toWaiting.push(m) };
  const registration = { waiting, installing: null, addEventListener: vi.fn() };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      register: vi.fn(async () => registration),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      controller: { scriptURL: `https://lp.test${opts.controller}`, postMessage: vi.fn() },
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  const onUpdateReady = vi.fn();
  startServiceWorker({ onUpdateReady, onOfflineReady: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  return { onUpdateReady, toWaiting, reload, own };
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-12T15:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('a waiting worker', () => {
  it('with the same script URL as the controller takes over quietly (as before)', async () => {
    const { onUpdateReady, toWaiting, reload } = await setup({ controller: '/sw.js?v=old1', waiting: '/sw.js?v=old1' });
    expect(toWaiting).toEqual([{ type: 'skip-waiting' }]);
    expect(onUpdateReady).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("of this page's own build, under an older controller, takes over quietly: no toast, no reload", async () => {
    const { onUpdateReady, toWaiting, reload } = await setup({ controller: '/sw.js?v=25chuyc', waiting: (own) => `/sw.js?v=${own}` });
    expect(toWaiting).toEqual([{ type: 'skip-waiting' }]);
    expect(onUpdateReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('of any other build is "Update ready", and waits for the tap', async () => {
    const { onUpdateReady, toWaiting, own } = await setup({ controller: '/sw.js?v=25chuyc', waiting: '/sw.js?v=newer9' });
    expect(own).not.toBe('newer9');
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    expect(toWaiting).toEqual([]);
  });
});

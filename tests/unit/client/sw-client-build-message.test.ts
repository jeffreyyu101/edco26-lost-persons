// (network fix 2 follow-up, 2026-11-08) A page served from the stored `/` runs the stored build. When the worker's
// background refresh finds another build, it posts lp-build with that build's scripts (and answers the page's own
// lp-build ask): lib/client/sw-client.ts registers that build's worker at once, with no GET / of its own, instead of
// waiting minutes for the deploy check. A fake document / service worker; synthetic URLs only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OURS = 'https://lp.test/_next/static/chunks/app-a.js';
const THEIRS = '/_next/static/chunks/app-b.js';

async function setup() {
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    scripts: [{ src: OURS }],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: () => [],
  });
  vi.stubGlobal('window', { location: { origin: 'https://lp.test', reload: vi.fn() } });
  const register = vi.fn(async (_url: string) => undefined);
  const listeners = new Set<(event: { data: unknown }) => void>();
  const posted: unknown[] = [];
  vi.stubGlobal('navigator', {
    serviceWorker: {
      register,
      addEventListener: (type: string, h: (event: { data: unknown }) => void) => {
        if (type === 'message') listeners.add(h);
      },
      removeEventListener: (type: string, h: (event: { data: unknown }) => void) => {
        if (type === 'message') listeners.delete(h);
      },
      controller: { postMessage: (m: unknown) => posted.push(m) },
    },
  });
  const fetch = vi.fn(async () => new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  const { startServiceWorker, buildIdFrom } = await import('@/lib/client/sw-client');
  const controller = startServiceWorker({ onUpdateReady: vi.fn(), onOfflineReady: vi.fn() });
  const post = (data: unknown) => {
    for (const l of [...listeners]) l({ data });
  };
  const registered = () => register.mock.calls.map(([url]) => url);
  return { controller, post, posted, registered, fetch, buildIdFrom };
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-08T03:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('another build found by the worker (fix 2 follow-up)', () => {
  it('asks the worker once at start, and registers the build it names at once, with no GET /', async () => {
    const { post, posted, registered, fetch, buildIdFrom } = await setup();
    expect(posted).toEqual([{ type: 'lp-build' }]);
    expect(registered()).toHaveLength(1);
    post({ type: 'lp-build', scripts: [THEIRS, '/_next/static/chunks/framework.js'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(registered()).toEqual([registered()[0], `/sw.js?v=${buildIdFrom([THEIRS, '/_next/static/chunks/framework.js'])}`]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores its own build, other messages, malformed ones, and anything after stop()', async () => {
    const { controller, post, registered } = await setup();
    post({ type: 'lp-build', scripts: [OURS] });
    post({ type: 'lp-push', scripts: [THEIRS] });
    post({ type: 'lp-build', scripts: 'nope' });
    post({ type: 'lp-build', scripts: [42] });
    post(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(registered()).toHaveLength(1);
    controller?.stop();
    post({ type: 'lp-build', scripts: [THEIRS] });
    await vi.advanceTimersByTimeAsync(0);
    expect(registered()).toHaveLength(1);
  });
});

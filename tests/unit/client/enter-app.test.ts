// (Cut-over fix A2) A successful sign-in enters the app from the network: lib/client/enter-app.ts deletes the stored
// `/` from every `lp-` cache (the old build's worker serves it before the network), bounded, and never fails the
// sign-in. A lead with no event open goes to the Events list even for next=/ (the old app's 401 redirect).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DROP_SHELL_TIMEOUT_MS, afterSignInPath, dropStoredShell, enterApp, type CachesLike } from '@/lib/client/enter-app';

function fakeCaches(names: string[], entries: string[] = ['/', '/signin', '/_next/static/chunks/a.js']) {
  const stores = new Map(names.map((n) => [n, new Set(entries)]));
  const caches: CachesLike = {
    keys: async () => [...stores.keys()],
    open: async (name) => ({ delete: async (request: string) => stores.get(name)?.delete(request) ?? false }),
  };
  return { caches, stores };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('dropStoredShell', () => {
  it('deletes only `/`, and only from lp- caches', async () => {
    const { caches, stores } = fakeCaches(['lp-25chuyc', 'lp-new1', 'lp-meta-other', 'other-cache']);
    await dropStoredShell(caches);
    for (const name of ['lp-25chuyc', 'lp-new1', 'lp-meta-other']) expect([...(stores.get(name) ?? [])]).toEqual(['/signin', '/_next/static/chunks/a.js']);
    expect([...(stores.get('other-cache') ?? [])]).toEqual(['/', '/signin', '/_next/static/chunks/a.js']);
  });

  it('a browser with no Cache API (or one that refuses it) resolves at once', async () => {
    await expect(dropStoredShell(null)).resolves.toBeUndefined();
    vi.stubGlobal('caches', undefined);
    await expect(dropStoredShell()).resolves.toBeUndefined();
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      await expect(dropStoredShell()).resolves.toBeUndefined();
    } finally {
      delete (globalThis as { caches?: unknown }).caches;
    }
  });

  it('a rejecting keys(), open() or delete() never rejects', async () => {
    const reject = () => Promise.reject(new Error('quota'));
    await expect(dropStoredShell({ keys: reject, open: reject })).resolves.toBeUndefined();
    await expect(dropStoredShell({ keys: async () => ['lp-a'], open: reject })).resolves.toBeUndefined();
    await expect(dropStoredShell({ keys: async () => ['lp-a'], open: async () => ({ delete: reject }) })).resolves.toBeUndefined();
    await expect(dropStoredShell({ keys: () => { throw new Error('sync'); }, open: reject })).resolves.toBeUndefined(); // prettier-ignore
  });

  it('a hang gives up after the timeout (about 1.5 s)', async () => {
    vi.useFakeTimers();
    expect(DROP_SHELL_TIMEOUT_MS).toBe(1_500);
    let done = false;
    const p = dropStoredShell({ keys: () => new Promise(() => undefined), open: () => new Promise(() => undefined) }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(DROP_SHELL_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});

describe('enterApp', () => {
  it('drops the stored page first, then opens the path', async () => {
    const { caches, stores } = fakeCaches(['lp-x']);
    const order: string[] = [];
    vi.stubGlobal('caches', {
      keys: caches.keys,
      open: async (name: string) => {
        const c = await caches.open(name);
        return { delete: async (r: string) => (order.push(`delete ${r}`), c.delete(r)) };
      },
    });
    vi.stubGlobal('window', { location: { replace: (url: string) => order.push(`replace ${url}`) } });
    await enterApp('/events');
    expect(order).toEqual(['delete /', 'replace /events']);
    expect(stores.get('lp-x')?.has('/')).toBe(false);
  });

  it('a hang still opens the app, after the timeout', async () => {
    vi.useFakeTimers();
    const replace = vi.fn();
    vi.stubGlobal('caches', { keys: () => new Promise(() => undefined), open: () => new Promise(() => undefined) });
    vi.stubGlobal('window', { location: { replace } });
    const p = enterApp('/');
    await vi.advanceTimersByTimeAsync(DROP_SHELL_TIMEOUT_MS);
    await p;
    expect(replace).toHaveBeenCalledWith('/');
  });
});

describe('afterSignInPath', () => {
  const staff = { role: 'staff', eventId: '10ca1000-0000-4000-8000-000000000001' };
  const leadIn = { role: 'lead', eventId: '10ca1000-0000-4000-8000-000000000001' };
  const leadOut = { role: 'lead', eventId: null };

  it('a lead with no event open goes to the Events list, also for next=/ (and /?r=…)', () => {
    expect(afterSignInPath(null, leadOut)).toBe('/events');
    expect(afterSignInPath('/', leadOut)).toBe('/events');
    expect(afterSignInPath('/?r=5eed0000-0000-4000-8000-000000000001', leadOut)).toBe('/events');
    expect(afterSignInPath('/health', leadOut)).toBe('/health');
    expect(afterSignInPath('/events/new', leadOut)).toBe('/events/new');
  });

  it('staff, and a lead with an event open, go to next or the app', () => {
    expect(afterSignInPath(null, staff)).toBe('/');
    expect(afterSignInPath('/?r=abc', staff)).toBe('/?r=abc');
    expect(afterSignInPath('/', leadIn)).toBe('/');
    expect(afterSignInPath(null, null)).toBe('/');
    // An unsafe next is ignored, as before.
    expect(afterSignInPath('https://evil.example/', staff)).toBe('/');
    expect(afterSignInPath('//evil.example', leadOut)).toBe('/events');
  });
});

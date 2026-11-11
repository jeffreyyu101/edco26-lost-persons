// (Cut-over fix A2) A successful sign-in enters the app from the network: lib/client/enter-app.ts deletes the stored
// `/` of the pre-events build (no lp-shell marker) from every `lp-` cache (the old build's worker serves it before the
// network), bounded, and never fails the sign-in; this build's own stored page is kept. A lead with no event open goes to the Events list even for next=/ (the old app's 401 redirect).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DROP_SHELL_TIMEOUT_MS, SHELL_MARKER, afterSignInPath, dropStoredShell, enterApp, type CachesLike } from '@/lib/client/enter-app';

const OLD_SHELL = '<!DOCTYPE html><html><head><script src="/_next/static/chunks/old.js"></script></head><body></body></html>';
const NEW_SHELL = '<!DOCTYPE html><html lang="en"><head><meta name="lp-shell" content="events"/></head><body></body></html>';

/** Caches holding `entries`; the stored `/` is `shell` (null: unreadable, its text() rejects). */
function fakeCaches(names: string[], entries: string[] = ['/', '/signin', '/_next/static/chunks/a.js'], shell: string | null | Record<string, string | null> = OLD_SHELL) {
  const stores = new Map(names.map((n) => [n, new Set(entries)]));
  const shellOf = (name: string) => (shell !== null && typeof shell === 'object' ? (shell[name] ?? null) : shell);
  const caches: CachesLike = {
    keys: async () => [...stores.keys()],
    open: async (name) => ({
      match: async (request: string) => {
        if (!stores.get(name)?.has(request)) return undefined;
        const text = shellOf(name);
        return { text: async () => (text === null ? Promise.reject(new TypeError('body used')) : text) };
      },
      delete: async (request: string) => stores.get(name)?.delete(request) ?? false,
    }),
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

  it("keeps a stored `/` of this build (it carries the lp-shell marker): no instant or offline open is lost", async () => {
    const { caches, stores } = fakeCaches(['lp-new1'], undefined, NEW_SHELL);
    await dropStoredShell(caches);
    expect(stores.get('lp-new1')?.has('/')).toBe(true);
  });

  it('with an old-build cache and a marked one at once, only the old one loses `/`', async () => {
    const { caches, stores } = fakeCaches(['lp-25chuyc', 'lp-new1'], undefined, { 'lp-25chuyc': OLD_SHELL, 'lp-new1': NEW_SHELL });
    await dropStoredShell(caches);
    expect(stores.get('lp-25chuyc')?.has('/')).toBe(false);
    expect(stores.get('lp-new1')?.has('/')).toBe(true);
    expect(stores.get('lp-25chuyc')?.has('/signin')).toBe(true);
  });

  it('a stored `/` that cannot be read (text() rejects, or match() rejects) counts as old and goes', async () => {
    const { caches, stores } = fakeCaches(['lp-a'], undefined, null);
    await dropStoredShell(caches);
    expect(stores.get('lp-a')?.has('/')).toBe(false);
    const deleted: string[] = [];
    await dropStoredShell({
      keys: async () => ['lp-b'],
      open: async () => ({ match: () => Promise.reject(new Error('quota')), delete: async (r: string) => (deleted.push(r), true) }),
    });
    expect(deleted).toEqual(['/']);
  });

  it('the app layout renders the marker the check looks for', () => {
    const layout = readFileSync(join(__dirname, '..', '..', '..', 'app', 'layout.tsx'), 'utf8');
    expect(layout).toContain(`<meta ${SHELL_MARKER} content="events" />`);
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
    await expect(dropStoredShell({ keys: async () => ['lp-a'], open: async () => ({ match: reject, delete: reject }) })).resolves.toBeUndefined();
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
        return { match: c.match, delete: async (r: string) => (order.push(`delete ${r}`), c.delete(r)) };
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

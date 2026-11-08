// The page side of a notification click (v2.5 A52, lib/client/system-notify.ts): public/sw.js posts
// {type: 'lp-open', url}; the app page opens that view in place (pushState, no reload) and answers {ok}.
// Anything else is ignored. A click no page opened (an iPhone Home Screen app the tap launched or resumed at
// `/`) is asked for with {type: 'lp-take-open'} when the page starts and each time it comes back into view.
// Stubbed window and service worker container; synthetic ids only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_OPEN_MS,
  askPendingOpen,
  listenForNotificationOpens,
  openFromNotification,
  watchPendingOpens,
  type PendingOpen,
  type PendingOpenHost,
} from '@/lib/client/system-notify';
import { takeThreadJump, threadJumpWaiting } from '@/lib/client/thread-jump';

const ID = '0f0f0f0f-0000-4000-8000-000000000012';

function fakeContainer() {
  let listener: ((event: Event) => void) | null = null;
  return {
    addEventListener: (_type: string, fn: (event: Event) => void) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = null;
    },
    /** Posts a message from the worker; resolves the page's reply (undefined when there is none). */
    post(data: unknown): unknown {
      let reply: unknown;
      listener?.({ data, ports: [{ postMessage: (m: unknown) => (reply = m) }] } as unknown as Event);
      return reply;
    },
    listening: () => listener !== null,
  };
}

describe('listenForNotificationOpens', () => {
  it('opens the URL the worker names and answers ok', () => {
    const container = fakeContainer();
    const open = vi.fn(() => true);
    listenForNotificationOpens(container, open);
    expect(container.post({ type: 'lp-open', url: `/?r=${ID}` })).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith(`/?r=${ID}`);
  });

  it('answers not ok when the page cannot open it, so the worker navigates the window instead', () => {
    const container = fakeContainer();
    listenForNotificationOpens(container, () => false);
    expect(container.post({ type: 'lp-open', url: '/signin' })).toEqual({ ok: false });
    const throwing = fakeContainer();
    listenForNotificationOpens(throwing, () => {
      throw new Error('boom');
    });
    expect(throwing.post({ type: 'lp-open', url: '/' })).toEqual({ ok: false });
  });

  it('ignores every other message, and stops when removed', () => {
    const container = fakeContainer();
    const open = vi.fn(() => true);
    const stop = listenForNotificationOpens(container, open);
    expect(container.post({ type: 'precache', urls: [] })).toBeUndefined();
    expect(container.post({ type: 'lp-open', url: 42 })).toBeUndefined();
    expect(container.post(null)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    stop();
    expect(container.listening()).toBe(false);
  });
});

describe('openFromNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWindow() {
    const pushState = vi.fn();
    vi.stubGlobal('window', { location: { origin: 'https://lp.test', pathname: '/', search: '?view=pending' }, history: { state: { lpDepth: 2 }, pushState, replaceState: vi.fn() } });
    return pushState;
  }

  it('pushes the request’s profile as an in-app view (Back returns to where the page was)', () => {
    const pushState = stubWindow();
    expect(openFromNotification(`/?r=${ID}`)).toBe(true);
    expect(pushState).toHaveBeenCalledWith({ lpDepth: 3 }, '', `/?r=${ID}`);
    expect(openFromNotification('/')).toBe(true);
    expect(pushState).toHaveBeenLastCalledWith({ lpDepth: 3 }, '', '/');
  });

  it('already showing that view: nothing pushed (Back still leaves it), and the worker hears ok', () => {
    const pushState = stubWindow();
    expect(openFromNotification('/?view=pending')).toBe(true);
    expect(pushState).not.toHaveBeenCalled();
  });

  it('refuses another path or origin (the worker navigates or opens a window instead)', () => {
    const pushState = stubWindow();
    expect(openFromNotification('/signin')).toBe(false);
    expect(openFromNotification(`https://evil.example/?r=${ID}`)).toBe(false);
    expect(pushState).not.toHaveBeenCalled();
  });
});

const ORIGIN = 'https://lp.test';
const THREAD = `/?r=${ID}&to=thread`;
const MUTATION = '0f0f0f0f-0000-4000-8000-0000000000aa';

/** Lets a MessageChannel round trip and the promise chains after it finish. */
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setImmediate(r));
};

/** The active worker as public/sw.js answers lp-take-open: the pending click, taken once. */
function takingWorker(initial: PendingOpen | null, onAsk?: () => void) {
  let pending = initial;
  let asks = 0;
  return {
    asks: () => asks,
    set: (open: PendingOpen | null) => {
      pending = open;
    },
    pending: () => pending,
    postMessage: (message: unknown, transfer?: unknown[]) => {
      if ((message as { type?: string }).type !== 'lp-take-open') return;
      asks += 1;
      onAsk?.();
      const open = pending;
      pending = null;
      (transfer?.[0] as MessagePort | undefined)?.postMessage({ open });
    },
  };
}

function pendingHost(opts: { open?: PendingOpen | null; location?: string; visible?: boolean; loaded?: { url: string; at: number } | null; onAsk?: () => void } = {}) {
  const worker = takingWorker(opts.open ?? null, opts.onAsk);
  let visible = opts.visible ?? true;
  const state = { location: opts.location ?? '/' };
  const back = new Set<() => void>();
  const opened: string[] = [];
  const host: PendingOpenHost = {
    worker: () => Promise.resolve(worker),
    visible: () => visible,
    location: () => state.location,
    // The tap launched the app at its start URL, a moment after the click.
    loaded: () => (opts.loaded === undefined ? { url: `${ORIGIN}/`, at: Date.now() } : opts.loaded),
    now: () => Date.now(),
    onVisible: (fn) => {
      back.add(fn);
      return () => back.delete(fn);
    },
    open: (url) => {
      opened.push(url);
      return true;
    },
  };
  return {
    host,
    worker,
    opened,
    state,
    hide: () => {
      visible = false;
    },
    /** The page comes back into view (visibilitychange). */
    show: async () => {
      visible = true;
      for (const fn of [...back]) fn();
      await settle();
    },
  };
}

describe('askPendingOpen (lp-take-open)', () => {
  it("takes the worker's answer; no worker, no answer in time (an older build) or a garbled one is null", async () => {
    const at = Date.now();
    expect(await askPendingOpen(takingWorker({ url: THREAD, at }))).toEqual({ url: THREAD, at });
    expect(await askPendingOpen(takingWorker(null))).toBeNull();
    expect(await askPendingOpen(null)).toBeNull();
    expect(await askPendingOpen({ postMessage: () => undefined }, 20)).toBeNull();
    const garbled = { postMessage: (_m: unknown, t?: unknown[]) => (t?.[0] as MessagePort).postMessage({ open: { url: 7, at: 'x' } }) };
    expect(await askPendingOpen(garbled)).toBeNull();
    const throwing = {
      postMessage: () => {
        throw new Error('redundant');
      },
    };
    expect(await askPendingOpen(throwing)).toBeNull();
  });
});

describe('watchPendingOpens (a click the page missed)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the worker on start and opens the request at its thread', async () => {
    const pushState = vi.fn();
    vi.stubGlobal('window', { location: { origin: ORIGIN, pathname: '/', search: '' }, history: { state: null, pushState, replaceState: vi.fn() } });
    const p = pendingHost({ open: { url: THREAD, at: Date.now() - 3_000 } });
    const stop = watchPendingOpens({ ...p.host, open: openFromNotification });
    await settle();
    expect(p.worker.asks()).toBe(1);
    expect(pushState).toHaveBeenCalledWith({ lpDepth: 1 }, '', `/?r=${ID}`);
    // Its Messages come into view once the request shows.
    expect(threadJumpWaiting(ID)).toBe(true);
    expect(takeThreadJump(ID)).toBe(true);
    stop();
  });

  it('asks again each time the page comes back into view, and opens a click it missed while away', async () => {
    const p = pendingHost();
    watchPendingOpens(p.host);
    await settle();
    expect(p.worker.asks()).toBe(1);
    expect(p.opened).toEqual([]);
    p.hide();
    p.worker.set({ url: THREAD, at: Date.now() });
    await p.show();
    expect(p.worker.asks()).toBe(2);
    expect(p.opened).toEqual([THREAD]);
    // Taken once: the next time in view there is nothing left.
    await p.show();
    expect(p.worker.asks()).toBe(3);
    expect(p.opened).toEqual([THREAD]);
  });

  it('a page out of view does not ask: the click stays with the worker for the page in view', async () => {
    const p = pendingHost({ open: { url: THREAD, at: Date.now() }, visible: false });
    watchPendingOpens(p.host);
    await settle();
    expect(p.worker.asks()).toBe(0);
    expect(p.worker.pending()?.url).toBe(THREAD);
  });

  it('never over the request form, an edit or the needs-attention editor: it does not even ask', async () => {
    for (const location of ['/?new=1', `/?r=${ID}&edit=person`, `/?outbox=${MUTATION}`]) {
      const p = pendingHost({ open: { url: THREAD, at: Date.now() }, location });
      watchPendingOpens(p.host);
      await settle();
      await p.show();
      expect(p.worker.asks(), location).toBe(0);
      expect(p.opened, location).toEqual([]);
      expect(p.worker.pending()?.url, location).toBe(THREAD);
    }
    // The form opened while the worker answered: nothing opens over it.
    const late = pendingHost({ open: { url: THREAD, at: Date.now() }, onAsk: () => (late.state.location = '/?new=1') });
    watchPendingOpens(late.host);
    await settle();
    expect(late.worker.asks()).toBe(1);
    expect(late.opened).toEqual([]);
  });

  it('a stale click, or none, opens nothing', async () => {
    const stale = pendingHost({ open: { url: THREAD, at: Date.now() - PENDING_OPEN_MS - 1_000 } });
    watchPendingOpens(stale.host);
    await settle();
    expect(stale.worker.asks()).toBe(1);
    expect(stale.opened).toEqual([]);
    const none = pendingHost();
    watchPendingOpens(none.host);
    await settle();
    expect(none.opened).toEqual([]);
  });

  it('a page the click itself loaded at that address (navigate, openWindow) does not open it again; a later click does', async () => {
    const loadedAt = Date.now();
    const p = pendingHost({ open: { url: THREAD, at: loadedAt - 1_000 }, loaded: { url: `${ORIGIN}${THREAD}`, at: loadedAt } });
    watchPendingOpens(p.host);
    await settle();
    expect(p.worker.asks()).toBe(1);
    expect(p.opened).toEqual([]);
    p.worker.set({ url: THREAD, at: loadedAt + 5_000 });
    await p.show();
    expect(p.opened).toEqual([THREAD]);
  });
});

describe('startNotify (the store loads it after start): the browser asks for a missed click', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('asks the controller on start and on visibilitychange, and opens the request at its thread', async () => {
    const handlers = new Map<string, Array<() => void>>();
    const target = (name: string) => ({
      addEventListener: (type: string, fn: () => void) => handlers.set(`${name}:${type}`, [...(handlers.get(`${name}:${type}`) ?? []), fn]),
      removeEventListener: () => undefined,
    });
    const controller = takingWorker({ url: THREAD, at: Date.now() - 2_000 });
    const pushState = vi.fn();
    const doc = { ...target('document'), visibilityState: 'visible', hasFocus: () => true };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {
      ...target('window'),
      location: { origin: ORIGIN, pathname: '/', search: '' },
      history: { state: null, pushState, replaceState: vi.fn() },
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: true,
      serviceWorker: { ...target('sw'), controller, ready: new Promise(() => undefined) },
    });
    vi.resetModules();
    const notify = await import('@/lib/client/system-notify');
    const jump = await import('@/lib/client/thread-jump');
    notify.startNotify();
    await settle();
    expect(handlers.get('sw:message')?.length).toBe(1);
    expect(controller.asks()).toBe(1);
    expect(pushState).toHaveBeenCalledWith({ lpDepth: 1 }, '', `/?r=${ID}`);
    expect(jump.takeThreadJump(ID)).toBe(true);

    // Back from the background with a click it missed meanwhile.
    controller.set({ url: THREAD, at: Date.now() });
    doc.visibilityState = 'hidden';
    for (const fn of handlers.get('document:visibilitychange') ?? []) fn();
    await settle();
    expect(controller.asks()).toBe(1);
    doc.visibilityState = 'visible';
    for (const fn of handlers.get('document:visibilitychange') ?? []) fn();
    await settle();
    expect(controller.asks()).toBe(2);
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(jump.takeThreadJump(ID)).toBe(true);
    // Installed once for the page's lifetime.
    notify.startNotify();
    await settle();
    expect(handlers.get('sw:message')?.length).toBe(1);
    expect(controller.asks()).toBe(2);
  });
});

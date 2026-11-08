// The page side of a notification click (v2.5 A52, lib/client/system-notify.ts): public/sw.js posts
// {type: 'lp-open', url}; the app page opens that view in place (pushState, no reload) and answers {ok}.
// Anything else is ignored. A click no page opened (an iPhone Home Screen app the tap launched or resumed at
// `/`) is asked for with {type: 'lp-take-open'} when the page starts and each time it comes back into view.
// Stubbed window and service worker container; synthetic ids only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_BACK_MS,
  PENDING_OPEN_MS,
  PENDING_RETRY_MS,
  PENDING_SIGNIN_MS,
  askPendingOpen,
  listenForNotificationOpens,
  openFromNotification,
  watchPendingOpens,
  type PendingOpen,
  type PendingOpenHost,
} from '@/lib/client/system-notify';
import { signInNext } from '@/lib/client/nav';
import { SIGNED_IN_AT_KEY, markSignedIn, takeSignedInAt } from '@/lib/client/signed-in-at';
import { requestThreadJump, takeThreadJump, threadJumpWaiting, withThread } from '@/lib/client/thread-jump';

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
const OTHER = '0f0f0f0f-0000-4000-8000-000000000034';

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

function pendingHost(
  opts: {
    open?: PendingOpen | null;
    location?: string;
    visible?: boolean;
    loaded?: { url: string; at: number } | null;
    signedInAt?: number | null;
    onAsk?: () => void;
  } = {},
) {
  const worker = takingWorker(opts.open ?? null, opts.onAsk);
  let visible = opts.visible ?? true;
  let typing = false;
  const state = { location: opts.location ?? '/' };
  const back = new Set<() => void>();
  const opened: string[] = [];
  // The page's clock and timers: `advance` moves them on.
  const start = Date.now();
  let clock = start;
  const timers: Array<{ at: number; fn: () => void; done: boolean }> = [];
  const host: PendingOpenHost = {
    worker: () => Promise.resolve(worker),
    visible: () => visible,
    location: () => state.location,
    typing: () => typing,
    // The tap launched the app at its start URL, a moment after the click.
    loaded: () => (opts.loaded === undefined ? { url: `${ORIGIN}/`, at: start } : opts.loaded),
    signedInAt: () => opts.signedInAt ?? null,
    now: () => clock,
    onVisible: (fn) => {
      back.add(fn);
      return () => back.delete(fn);
    },
    later: (fn, ms) => {
      const timer = { at: clock + ms, fn, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
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
    now: () => clock,
    setTyping: (on: boolean) => {
      typing = on;
    },
    /** Asks still to come. */
    scheduled: () => timers.filter((t) => !t.done).length,
    hide: () => {
      visible = false;
    },
    /** In view again, before any event says so. */
    reveal: () => {
      visible = true;
    },
    /** The page comes back into view (visibilitychange, focus, pageshow). */
    show: async () => {
      visible = true;
      for (const fn of [...back]) fn();
      await settle();
    },
    /** Moves the page's clock on by `ms`, running the asks that come due. */
    advance: async (ms: number) => {
      const until = clock + ms;
      for (;;) {
        const due = timers.filter((t) => !t.done && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock = due.at;
        due.done = true;
        due.fn();
        await settle();
      }
      clock = until;
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
  it('asks again over the next 8 s until something opens: a click kept only after the first ask still opens', async () => {
    const p = pendingHost();
    watchPendingOpens(p.host);
    await settle();
    expect(p.worker.asks()).toBe(1);
    expect(p.scheduled()).toBe(PENDING_RETRY_MS.length - 1);
    // The worker iOS started for the click keeps it a moment after the page first asked.
    p.worker.set({ url: THREAD, at: p.now() + 300 });
    await p.advance(1_000);
    expect(p.worker.asks()).toBe(2);
    expect(p.opened).toEqual([THREAD]);
    // Opened: no more asks this time.
    expect(p.scheduled()).toBe(0);
    await p.advance(10_000);
    expect(p.worker.asks()).toBe(2);
  });

  it('with nothing to open it asks at 0, 1, 2.5, 5 and 8 s, then stops until the page comes back', async () => {
    const p = pendingHost();
    watchPendingOpens(p.host);
    await settle();
    const asks: number[] = [p.worker.asks()];
    for (const step of [1_000, 1_500, 2_500, 3_000, 30_000]) {
      await p.advance(step);
      asks.push(p.worker.asks());
    }
    expect(asks).toEqual([1, 2, 3, 4, 5, 5]);
    await p.show();
    expect(p.worker.asks()).toBe(6);
    expect(p.scheduled()).toBe(PENDING_RETRY_MS.length - 1);
  });

  it('coming back while asks still run starts them over, never twice as many', async () => {
    const p = pendingHost();
    watchPendingOpens(p.host);
    await settle();
    await p.advance(500);
    await p.show();
    expect(p.worker.asks()).toBe(2);
    expect(p.scheduled()).toBe(PENDING_RETRY_MS.length - 1);
  });

  it('out of view or in a form between two asks: that ask is skipped and the click stays with the worker', async () => {
    const p = pendingHost();
    watchPendingOpens(p.host);
    await settle();
    p.worker.set({ url: THREAD, at: p.now() });
    p.hide();
    await p.advance(1_000);
    expect(p.worker.asks()).toBe(1);
    // In view again (no event yet), now in the request form.
    p.state.location = '/?new=1';
    p.reveal();
    await p.advance(1_500);
    expect(p.worker.asks()).toBe(1);
    expect(p.worker.pending()?.url).toBe(THREAD);
  });

  it('a click tapped while the page was away opens when it comes back, up to 15 s before', async () => {
    const p = pendingHost();
    watchPendingOpens(p.host);
    await settle();
    await p.advance(60_000);
    p.hide();
    p.worker.set({ url: THREAD, at: p.now() });
    await p.advance(PENDING_BACK_MS - 1_000);
    await p.show();
    expect(p.opened).toEqual([THREAD]);
  });

  it('an older click is dropped when the page comes back: it never moves a page in use (a message being typed)', async () => {
    const p = pendingHost({ location: `/?r=${OTHER}` });
    watchPendingOpens(p.host);
    await settle();
    await p.advance(30_000);
    // Tapped a minute before; the page that should have opened it never asked.
    p.worker.set({ url: THREAD, at: p.now() - 60_000 });
    p.hide();
    await p.advance(5_000);
    await p.show();
    expect(p.worker.asks()).toBe(6);
    expect(p.opened).toEqual([]);
    // Taken and dropped: it does not open on a later return either.
    expect(p.worker.pending()).toBeNull();
    p.hide();
    await p.show();
    expect(p.opened).toEqual([]);
  });

  it('unsent text (the message composer, a sheet field): it does not ask, and asks again once it is gone', async () => {
    const p = pendingHost({ location: `/?r=${OTHER}` });
    p.setTyping(true);
    watchPendingOpens(p.host);
    await settle();
    p.worker.set({ url: THREAD, at: p.now() });
    await p.advance(2_500);
    expect(p.worker.asks()).toBe(0);
    expect(p.worker.pending()?.url).toBe(THREAD);
    p.setTyping(false);
    await p.advance(2_500);
    expect(p.worker.asks()).toBe(1);
    expect(p.opened).toEqual([THREAD]);
  });

  it('a page that starts opens a click up to 2 minutes old; the first page after a sign-in, up to 10 minutes', async () => {
    const now = Date.now();
    const loaded = { url: `${ORIGIN}/`, at: now };
    const older = pendingHost({ open: { url: THREAD, at: now - PENDING_OPEN_MS - 30_000 }, loaded });
    watchPendingOpens(older.host);
    await settle();
    expect(older.worker.asks()).toBe(1);
    expect(older.opened).toEqual([]);

    const signedIn = pendingHost({ open: { url: THREAD, at: now - PENDING_SIGNIN_MS + 30_000 }, loaded, signedInAt: now - 2_000 });
    watchPendingOpens(signedIn.host);
    await settle();
    expect(signedIn.opened).toEqual([THREAD]);

    // A sign-in long before this page started is not the one that opened it.
    const later = pendingHost({ open: { url: THREAD, at: now - PENDING_OPEN_MS - 30_000 }, loaded, signedInAt: now - 5 * 60_000 });
    watchPendingOpens(later.host);
    await settle();
    expect(later.opened).toEqual([]);
    expect(PENDING_SIGNIN_MS).toBeGreaterThan(PENDING_OPEN_MS);
  });

  it('the remover stops every ask still to come', async () => {
    const p = pendingHost();
    const stop = watchPendingOpens(p.host);
    await settle();
    stop();
    p.worker.set({ url: THREAD, at: p.now() });
    await p.advance(10_000);
    await p.show();
    expect(p.worker.asks()).toBe(1);
    expect(p.opened).toEqual([]);
  });
});

describe('startNotify (the store loads it after start): the browser asks for a missed click', () => {
  // The asks still to come (1 to 8 s) never outlive a test.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** An iPhone Home Screen app at `/` whose controller answers lp-take-open like `controller`. */
  function iphoneApp(controller: ReturnType<typeof takingWorker>, sessionStorage?: Map<string, string>) {
    const handlers = new Map<string, Array<() => void>>();
    const target = (name: string) => ({
      addEventListener: (type: string, fn: () => void) => handlers.set(`${name}:${type}`, [...(handlers.get(`${name}:${type}`) ?? []), fn]),
      removeEventListener: () => undefined,
    });
    const pushState = vi.fn();
    const doc = { ...target('document'), visibilityState: 'visible', hasFocus: () => true };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {
      ...target('window'),
      location: { origin: ORIGIN, pathname: '/', search: '' },
      history: { state: null, pushState, replaceState: vi.fn() },
      matchMedia: () => ({ matches: false }),
      sessionStorage: sessionStorage
        ? {
            getItem: (k: string) => sessionStorage.get(k) ?? null,
            setItem: (k: string, v: string) => sessionStorage.set(k, v),
            removeItem: (k: string) => sessionStorage.delete(k),
          }
        : undefined,
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: true,
      serviceWorker: { ...target('sw'), controller, ready: new Promise(() => undefined) },
    });
    const fire = (key: string) => {
      for (const fn of handlers.get(key) ?? []) fn();
    };
    return { handlers, doc, pushState, fire };
  }

  it('asks the controller on start, on visibilitychange, focus and pageshow, and opens the request at its thread', async () => {
    const controller = takingWorker({ url: THREAD, at: Date.now() - 2_000 });
    const { handlers, doc, pushState, fire } = iphoneApp(controller);
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
    fire('document:visibilitychange');
    await settle();
    expect(controller.asks()).toBe(1);
    doc.visibilityState = 'visible';
    fire('document:visibilitychange');
    await settle();
    expect(controller.asks()).toBe(2);
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(jump.takeThreadJump(ID)).toBe(true);
    // The focus, and a page shown again from the back-forward cache, ask too.
    controller.set({ url: THREAD, at: Date.now() });
    fire('window:focus');
    await settle();
    expect(controller.asks()).toBe(3);
    expect(pushState).toHaveBeenCalledTimes(3);
    expect(jump.takeThreadJump(ID)).toBe(true);
    controller.set({ url: THREAD, at: Date.now() });
    fire('window:pageshow');
    await settle();
    expect(controller.asks()).toBe(4);
    expect(pushState).toHaveBeenCalledTimes(4);
    // Installed once for the page's lifetime.
    notify.startNotify();
    await settle();
    expect(handlers.get('sw:message')?.length).toBe(1);
    expect(controller.asks()).toBe(4);
  });

  it('the first page after a sign-in opens a click tapped minutes before; the sign-in time is read once', async () => {
    const session = new Map([['lp-signed-in-at', String(Date.now() - 1_500)]]);
    const controller = takingWorker({ url: THREAD, at: Date.now() - 6 * 60_000 });
    const { pushState } = iphoneApp(controller, session);
    vi.resetModules();
    const notify = await import('@/lib/client/system-notify');
    notify.startNotify();
    await settle();
    expect(controller.asks()).toBe(1);
    expect(pushState).toHaveBeenCalledWith({ lpDepth: 1 }, '', `/?r=${ID}`);
    expect(session.has('lp-signed-in-at')).toBe(false);
  });

  it('without a sign-in just before, a click that old is dropped', async () => {
    const controller = takingWorker({ url: THREAD, at: Date.now() - 6 * 60_000 });
    const { pushState } = iphoneApp(controller, new Map());
    vi.resetModules();
    const notify = await import('@/lib/client/system-notify');
    notify.startNotify();
    await settle();
    expect(controller.asks()).toBe(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(controller.pending()).toBeNull();
    // It asks again a few times (a click being kept just then would still open), then stops.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
    }
    expect(controller.asks()).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withThread (R2: the address a sign-in after a 401 comes back to)', () => {
  const X = '0f0f0f0f-0000-4000-8000-000000000056';
  const Y = '0f0f0f0f-0000-4000-8000-000000000078';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds to=thread while the jump to that request waits or has just landed, through nav signInNext', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-07T22:00:00Z') });
    expect(withThread(`/?r=${X}`)).toBe(`/?r=${X}`);
    requestThreadJump(X);
    expect(withThread(`/?r=${X}`)).toBe(`/?r=${X}&to=thread`);
    expect(signInNext(`/?r=${X}`)).toBe(`/?r=${X}&to=thread`);
    // Another request, an edit, a list, or an address that already asks for it: unchanged.
    expect(signInNext(`/?r=${Y}`)).toBe(`/?r=${Y}`);
    expect(signInNext(`/?r=${X}&edit=person`)).toBe(`/?r=${X}&edit=person`);
    expect(signInNext('/?view=pending')).toBe('/?view=pending');
    expect(signInNext(`/?r=${X}&to=thread`)).toBe(`/?r=${X}&to=thread`);
    // Landed (its Messages came into view): a 401 just after still comes back to the thread…
    expect(takeThreadJump(X)).toBe(true);
    expect(signInNext(`/?r=${X}`)).toBe(`/?r=${X}&to=thread`);
    // …for a minute.
    vi.setSystemTime(Date.now() + 61_000);
    expect(signInNext(`/?r=${X}`)).toBe(`/?r=${X}`);
  });

  it('a jump waits a minute for its Messages (a slow cold start), then lapses', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-07T22:10:00Z') });
    requestThreadJump(Y);
    vi.setSystemTime(Date.now() + 45_000);
    expect(threadJumpWaiting(Y)).toBe(true);
    vi.setSystemTime(Date.now() + 20_000);
    expect(threadJumpWaiting(Y)).toBe(false);
    expect(takeThreadJump(Y)).toBe(false);
  });
});

describe('signed-in-at (the sign-in screen tells the app page it opens when it signed in)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('written by the sign-in, read once by the app page; no sessionStorage is no time and no error', () => {
    const store = new Map<string, string>();
    const sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal('window', { sessionStorage });
    const before = Date.now();
    markSignedIn();
    expect(Number(store.get(SIGNED_IN_AT_KEY))).toBeGreaterThanOrEqual(before);
    expect(takeSignedInAt()).toBeGreaterThanOrEqual(before);
    expect(takeSignedInAt()).toBeNull();
    store.set(SIGNED_IN_AT_KEY, 'soon');
    expect(takeSignedInAt()).toBeNull();
    expect(store.has(SIGNED_IN_AT_KEY)).toBe(false);

    vi.stubGlobal('window', {});
    expect(() => markSignedIn()).not.toThrow();
    expect(takeSignedInAt()).toBeNull();
  });
});

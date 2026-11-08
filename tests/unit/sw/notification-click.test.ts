// public/sw.js notificationclick (v2.5 A52): a click on an alert's system notification closes it, focuses
// an open window of the app and has it open the request in place (`/?r=<id>`); a window that does not
// answer is navigated there, and with no window one opens. Fake window clients; synthetic ids only.
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeCacheStorage, FakeNetwork, ORIGIN, loadWorker, type PageClient, type Worker } from './harness';

const ID = '0f0f0f0f-0000-4000-8000-000000000012';

interface FakeWindow extends PageClient {
  focusCalls: number;
  navigated: string[];
  asked: string[];
}

/**
 * A window client. `answers`: the app page opens what it is asked and says so (true), refuses (false),
 * or never replies (null: a sign-in page or an older build). `navigable`: navigate() works (a controlled
 * window) or rejects.
 */
function win(id: string, path: string, opts: { focused?: boolean; answers?: boolean | null; navigable?: boolean } = {}): FakeWindow {
  const w: FakeWindow = {
    id,
    url: `${ORIGIN}${path}`,
    focused: opts.focused ?? false,
    focusCalls: 0,
    navigated: [],
    asked: [],
    focus: async () => {
      w.focusCalls += 1;
      w.focused = true;
      return w;
    },
    navigate: async (url: string) => {
      if (opts.navigable === false) throw new TypeError('not controlled');
      w.navigated.push(url);
      w.url = new URL(url, ORIGIN).href;
      return w;
    },
    postMessage: (message: unknown, transfer?: unknown[]) => {
      const m = message as { type?: string; url?: string };
      if (m.type === 'lp-open' && typeof m.url === 'string') w.asked.push(m.url);
      const port = transfer?.[0] as MessagePort | undefined;
      const answers = opts.answers === undefined ? true : opts.answers;
      if (port && answers !== null) port.postMessage({ ok: answers });
    },
  };
  return w;
}

let worker: Worker;
let pages: PageClient[];

beforeEach(() => {
  pages = [];
  worker = loadWorker({ version: 'n1', caches: new FakeCacheStorage(), network: new FakeNetwork(), active: 'n1', pages });
});

describe('lp-caps (a page notifies only once the active worker handles clicks)', () => {
  it('this worker says it handles notification clicks', async () => {
    expect(await worker.message({ type: 'lp-caps' })).toEqual({ notificationClick: true, push: true });
  });

  it('the answer changes nothing else: no skipWaiting, no caching', async () => {
    const caches = new FakeCacheStorage();
    const w = loadWorker({ version: 'n2', caches, network: new FakeNetwork(), active: 'n1', waiting: 'n2' });
    expect(await w.message({ type: 'lp-caps' })).toEqual({ notificationClick: true, push: true });
    expect(w.skipWaitingCalls()).toBe(0);
    expect(await caches.keys()).toEqual([]);
  });
});

describe('notificationclick', () => {
  it('closes the notification, focuses the app window and has it open the request in place', async () => {
    const app = win('tab-1', '/?view=pending');
    pages.push(app);
    const result = await worker.notificationClick({ url: `/?r=${ID}`, key: `${ID}:3` });
    expect(result.closed).toBe(true);
    expect(app.focusCalls).toBe(1);
    expect(app.asked).toEqual([`/?r=${ID}`]);
    // Opened in place: no reload, no new window.
    expect(app.navigated).toEqual([]);
    expect(worker.opened).toEqual([]);
  });

  it("(R2) a message's thread address reaches the page as it is: in place, a navigation, or a new window", async () => {
    const thread = `/?r=${ID}&to=thread`;
    const app = win('tab-1', '/');
    pages.push(app);
    await worker.notificationClick({ url: thread });
    expect(app.asked).toEqual([thread]);
    const signIn = win('tab-2', '/signin', { answers: null });
    pages.splice(0, pages.length, signIn);
    await worker.notificationClick({ url: thread });
    expect(signIn.navigated).toEqual([`${ORIGIN}${thread}`]);
    pages.splice(0, pages.length);
    await worker.notificationClick({ url: thread });
    expect(worker.opened).toEqual([`${ORIGIN}${thread}`]);
  });

  it('prefers the focused app window, then any app window, over a sign-in page', async () => {
    const signIn = win('tab-0', '/signin', { answers: null });
    const background = win('tab-1', '/');
    const front = win('tab-2', '/?dashboard=1', { focused: true });
    pages.push(signIn, background, front);
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(front.asked).toEqual([`/?r=${ID}`]);
    expect(background.asked).toEqual([]);
    expect(signIn.focusCalls).toBe(0);

    pages.splice(0, pages.length, signIn, background);
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(background.asked).toEqual([`/?r=${ID}`]);
    expect(signIn.focusCalls).toBe(0);
  });

  it('navigates a window that is not the app page (sign-in) without asking it', async () => {
    const signIn = win('tab-1', '/signin', { answers: null });
    pages.push(signIn);
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(signIn.focusCalls).toBe(1);
    expect(signIn.asked).toEqual([]);
    expect(signIn.navigated).toEqual([`${ORIGIN}/?r=${ID}`]);
    expect(worker.opened).toEqual([]);
  });

  it('navigates an app window that refuses or never answers (an older build)', async () => {
    const refuses = win('tab-1', '/', { answers: false });
    pages.push(refuses);
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(refuses.asked).toEqual([`/?r=${ID}`]);
    expect(refuses.navigated).toEqual([`${ORIGIN}/?r=${ID}`]);

    const silent = win('tab-2', '/', { answers: null });
    pages.splice(0, pages.length, silent);
    const started = Date.now();
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(silent.navigated).toEqual([`${ORIGIN}/?r=${ID}`]);
    expect(worker.opened).toEqual([]);
  });

  it('opens a new window when none is open, or when the open one cannot be navigated, at an absolute URL', async () => {
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(worker.opened).toEqual([`${ORIGIN}/?r=${ID}`]);

    const stuck = win('tab-1', '/signin', { navigable: false });
    pages.push(stuck);
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(stuck.focusCalls).toBe(1);
    expect(worker.opened).toEqual([`${ORIGIN}/?r=${ID}`, `${ORIGIN}/?r=${ID}`]);
  });

  it('opens `/` for a combined notification, and never leaves the app origin', async () => {
    await worker.notificationClick({ url: '/', key: null });
    await worker.notificationClick(null);
    await worker.notificationClick({ url: 'https://evil.example/?r=1' });
    await worker.notificationClick({ url: 42 });
    expect(worker.opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`, `${ORIGIN}/`, `${ORIGIN}/`]);
  });

  it('ignores windows of other origins and clients with no URL (the precache tabs)', async () => {
    pages.push({ id: 'worker-tab' }, { id: 'x', url: 'https://other.example/' });
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(worker.opened).toEqual([`${ORIGIN}/?r=${ID}`]);
  });
});

describe('a click no page opened yet (lp-take-open: the iPhone Home Screen app launched or resumed at `/`)', () => {
  const THREAD = `/?r=${ID}&to=thread`;
  const META = 'lp:meta';
  const KEY = '/__lp/pending-open';
  let caches: FakeCacheStorage;
  let tabs: PageClient[];
  let w: Worker;

  beforeEach(() => {
    caches = new FakeCacheStorage();
    tabs = [];
    w = loadWorker({ version: 'n1', caches, network: new FakeNetwork(), active: 'n1', pages: tabs });
  });

  const stored = async (): Promise<{ url: string; at: number } | null> => {
    const text = (await caches.get(META)?.text(KEY)) ?? null;
    return text ? (JSON.parse(text) as { url: string; at: number }) : null;
  };
  const take = () => w.message({ type: 'lp-take-open' });

  it('a click keeps its target before the hand-off, outside the version caches', async () => {
    const app = win('tab-1', '/');
    const post = app.postMessage!;
    let keptAtHandOff = false;
    app.postMessage = (message, transfer) => {
      keptAtHandOff = caches.get(META)?.has(KEY) === true;
      post(message, transfer);
    };
    tabs.push(app);
    await w.notificationClick({ url: THREAD });
    expect(app.asked).toEqual([THREAD]);
    expect(keptAtHandOff).toBe(true);
    // Not an `lp-` version cache: an update's activation never retires it.
    expect(caches.versions()).toEqual([]);
  });

  it('a page that opens it (lp-open {ok: true}) clears it: nothing is left to take', async () => {
    tabs.push(win('tab-1', '/?view=pending'));
    await w.notificationClick({ url: THREAD });
    expect(await stored()).toBeNull();
    expect(await take()).toEqual({ open: null });
  });

  it('no window (openWindow), a refusing page or one that never answers: it stays to be taken', async () => {
    const before = Date.now();
    await w.notificationClick({ url: THREAD });
    expect(w.opened).toEqual([`${ORIGIN}${THREAD}`]);
    const kept = await stored();
    expect(kept?.url).toBe(THREAD);
    expect(kept?.at).toBeGreaterThanOrEqual(before);
    expect(kept?.at).toBeLessThanOrEqual(Date.now());

    const refuses = win('tab-1', '/', { answers: false });
    tabs.push(refuses);
    await w.notificationClick({ url: `/?r=${ID}` });
    expect(refuses.navigated).toEqual([`${ORIGIN}/?r=${ID}`]);
    expect((await stored())?.url).toBe(`/?r=${ID}`);

    // A frozen page (or one whose listener is not in yet): asked, no answer, navigated, and still kept.
    const frozen = win('tab-2', '/', { answers: null });
    tabs.splice(0, tabs.length, frozen);
    await w.notificationClick({ url: THREAD });
    expect(frozen.asked).toEqual([THREAD]);
    expect(frozen.navigated).toEqual([`${ORIGIN}${THREAD}`]);
    expect((await stored())?.url).toBe(THREAD);
  });

  it('lp-take-open answers it once, then null', async () => {
    expect(await take()).toEqual({ open: null });
    await w.notificationClick({ url: THREAD });
    const first = (await take()) as { open: { url: string; at: number } | null };
    expect(first.open?.url).toBe(THREAD);
    expect(typeof first.open?.at).toBe('number');
    expect(await take()).toEqual({ open: null });
    expect(await stored()).toBeNull();
  });

  it('a newer click replaces it', async () => {
    await w.notificationClick({ url: `/?r=${ID}` });
    await w.notificationClick({ url: THREAD });
    expect(((await take()) as { open: { url: string } | null }).open?.url).toBe(THREAD);
    expect(await take()).toEqual({ open: null });
  });

  it('expires after 2 minutes: an expired one answers null and is dropped', async () => {
    await w.notificationClick({ url: THREAD });
    w.advanceClock(2 * 60_000 - 1_000);
    expect(((await take()) as { open: { url: string } | null }).open?.url).toBe(THREAD);

    await w.notificationClick({ url: THREAD });
    w.advanceClock(2 * 60_000 + 1_000);
    expect(await take()).toEqual({ open: null });
    expect(await stored()).toBeNull();
  });

  it('outlives the worker: a restarted worker still answers it', async () => {
    await w.notificationClick({ url: THREAD });
    const restarted = loadWorker({ version: 'n1', caches, network: new FakeNetwork(), active: 'n1' });
    expect(((await restarted.message({ type: 'lp-take-open' })) as { open: { url: string } | null }).open?.url).toBe(THREAD);
    expect(await take()).toEqual({ open: null });
  });

  it('something unreadable stored there answers null and is dropped', async () => {
    const meta = await caches.open(META);
    await meta.put(KEY, new Response('not json'));
    expect(await take()).toEqual({ open: null });
    expect(meta.has(KEY)).toBe(false);
    await meta.put(KEY, new Response(JSON.stringify({ url: 42, at: 'soon' })));
    expect(await take()).toEqual({ open: null });
  });
});

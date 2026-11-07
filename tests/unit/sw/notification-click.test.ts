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
    expect(signIn.navigated).toEqual([`/?r=${ID}`]);
    expect(worker.opened).toEqual([]);
  });

  it('navigates an app window that refuses or never answers (an older build)', async () => {
    const refuses = win('tab-1', '/', { answers: false });
    pages.push(refuses);
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(refuses.asked).toEqual([`/?r=${ID}`]);
    expect(refuses.navigated).toEqual([`/?r=${ID}`]);

    const silent = win('tab-2', '/', { answers: null });
    pages.splice(0, pages.length, silent);
    const started = Date.now();
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(silent.navigated).toEqual([`/?r=${ID}`]);
    expect(worker.opened).toEqual([]);
  });

  it('opens a new window when none is open, or when the open one cannot be navigated', async () => {
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(worker.opened).toEqual([`/?r=${ID}`]);

    const stuck = win('tab-1', '/signin', { navigable: false });
    pages.push(stuck);
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(stuck.focusCalls).toBe(1);
    expect(worker.opened).toEqual([`/?r=${ID}`, `/?r=${ID}`]);
  });

  it('opens `/` for a combined notification, and never leaves the app origin', async () => {
    await worker.notificationClick({ url: '/', key: null });
    await worker.notificationClick(null);
    await worker.notificationClick({ url: 'https://evil.example/?r=1' });
    await worker.notificationClick({ url: 42 });
    expect(worker.opened).toEqual(['/', '/', '/', '/']);
  });

  it('ignores windows of other origins and clients with no URL (the precache tabs)', async () => {
    pages.push({ id: 'worker-tab' }, { id: 'x', url: 'https://other.example/' });
    await worker.notificationClick({ url: `/?r=${ID}` });
    expect(worker.opened).toEqual([`/?r=${ID}`]);
  });
});

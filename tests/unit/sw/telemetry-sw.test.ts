// public/sw.js telemetry (design §4.7): a push is logged AFTER it is shown (or not), a click after it focused / opened
// / navigated, with `via` for lp-open, take-open and nav; the log keeps 100 entries and none older than 24 h; a failed
// log write never stops a notification; lp-tel-take returns and clears it; sentAt is kept only when it is a number.
// No title, body, URL or id is logged.
import { describe, expect, it } from 'vitest';
import { FakeCacheStorage, FakeNetwork, ORIGIN, loadWorker, type PageClient } from './harness';

const ID = '0f0f0f0f-0000-4000-8000-000000000044';
const payload = (over: Record<string, unknown> = {}) => ({ v: 1, title: 'Quorra Zyxwvut', body: 'Located · Chair 9', tag: `lp-${ID}`, url: `/?r=${ID}`, kind: 'in_medical', requestId: ID, renotify: true, badge: 1, sentAt: 1_762_600_000_000, ...over });

function worker(pages: PageClient[] = [], caches = new FakeCacheStorage()) {
  return { w: loadWorker({ version: 'v1', caches, network: new FakeNetwork(), active: 'v1', pages }), caches };
}

const take = async (w: ReturnType<typeof worker>['w']) => ((await w.message({ type: 'lp-tel-take' })) as { entries: Array<Record<string, unknown>> }).entries;

describe('push log', () => {
  it('after the notification is shown: kind, arrival, sentAt, front / shown / silent; never the title, body or ids', async () => {
    // The log is written in Cache Storage: by the time it is, the notification has been shown.
    const caches = new FakeCacheStorage();
    const { w } = worker([], caches);
    let shownWhenLogged = -1;
    const meta = await caches.open('lp:meta');
    const put = meta.put.bind(meta);
    meta.put = async (input, res) => {
      if (String(typeof input === 'string' ? input : input.url).includes('/__lp/tel')) shownWhenLogged = w.shownLog.length;
      return put(input, res);
    };
    await w.push(payload());
    expect(shownWhenLogged).toBe(1);
    const entries = await take(w);
    expect(entries).toEqual([{ e: 'rx', k: 'in_medical', at: expect.any(Number), sent: 1_762_600_000_000, fr: false, sh: true, si: false }]);
    expect(JSON.stringify(entries)).not.toMatch(/Quorra|Chair|0f0f0f0f|lp-/);
    expect(await take(w)).toEqual([]);
  });

  it('a window in front takes it (fr, nothing shown); sentAt that is not a number is dropped', async () => {
    const page: PageClient = {
      id: 'p1',
      url: `${ORIGIN}/`,
      focused: true,
      visibilityState: 'visible',
      postMessage: (_m, transfer) => (transfer?.[0] as { postMessage(v: unknown): void } | undefined)?.postMessage({ front: true }),
    };
    const { w } = worker([page]);
    await w.push(payload({ sentAt: 'yesterday' }));
    expect(w.shownLog).toHaveLength(0);
    expect(await take(w)).toEqual([expect.objectContaining({ e: 'rx', fr: true, sh: false, sent: null })]);
  });

  it('a log write that fails never stops the notification', async () => {
    const caches = new FakeCacheStorage();
    const meta = await caches.open('lp:meta');
    meta.put = async () => {
      throw new Error('QuotaExceededError');
    };
    const { w } = worker([], caches);
    await w.push(payload());
    expect(w.shownLog).toHaveLength(1);
    expect(w.shownLog[0]?.title).toBe('Quorra Zyxwvut');
  });

  it('at most 100 entries, none older than 24 h', async () => {
    const { w } = worker();
    for (let i = 0; i < 105; i += 1) await w.push(payload({ kind: 'message' }));
    expect(await take(w)).toHaveLength(100);
    await w.push(payload());
    w.advanceClock(25 * 60 * 60 * 1000);
    await w.push(payload({ kind: 'new_request' }));
    expect((await take(w)).map((e) => e.k)).toEqual(['new_request']);
  });
});

describe('click log', () => {
  it('after the click opened it, with via: lp-open when a window answered, nav when the worker navigated or opened one', async () => {
    const answering: PageClient = {
      id: 'p1',
      url: `${ORIGIN}/`,
      focused: true,
      visibilityState: 'visible',
      focus: async () => answering,
      postMessage: (m, transfer) => {
        if ((m as { type?: string }).type === 'lp-open') (transfer?.[0] as { postMessage(v: unknown): void } | undefined)?.postMessage({ ok: true });
      },
    };
    const { w } = worker([answering]);
    await w.notificationClick({ url: `/?r=${ID}`, push: true, kind: 'in_medical' });
    const { w: w2 } = worker([]);
    await w2.notificationClick({ url: `/?r=${ID}`, push: false, kind: 'message' });
    expect(w2.opened).toHaveLength(1);
    expect(await take(w)).toEqual([{ e: 'click', k: 'in_medical', ps: true, at: expect.any(Number), age: null, via: 'lp-open' }]);
    expect(await take(w2)).toEqual([expect.objectContaining({ e: 'click', k: 'message', ps: false, via: 'nav' })]);
  });

  it('take-open when a page took the kept click meanwhile', async () => {
    const caches = new FakeCacheStorage();
    let w: ReturnType<typeof loadWorker> | null = null;
    const page: PageClient = {
      id: 'p1',
      url: `${ORIGIN}/`,
      focused: false,
      visibilityState: 'visible',
      focus: async () => page,
      // An app page that never answers lp-open, but takes the pending click (a Home Screen app resuming).
      postMessage: () => undefined,
      navigate: async () => {
        await w!.message({ type: 'lp-take-open' });
        return null;
      },
    };
    w = loadWorker({ version: 'v1', caches, network: new FakeNetwork(), active: 'v1', pages: [page] });
    await w.notificationClick({ url: `/?r=${ID}`, push: true, kind: 'in_medical' });
    expect((await take(w)).map((e) => e.via)).toEqual(['take-open']);
  });
});

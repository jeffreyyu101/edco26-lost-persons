// The real store's sync loop, connection state, session handling and purity (spec §7 Sync / Session,
// A7, A37, A38), against the in-memory fake API with fake-indexeddb and fake timers. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openKv } from '@/lib/client/persist';
import { createAppStore, type StoreEnv } from '@/lib/client/store-core';
import { STATUS } from '@/lib/domain';
import { advance, fakeEnv, settle, useStoreTimers, type EnvOptions } from './helpers/env';
import { FakeServer, STAFF, apiError, makeRow } from './helpers/fake-server';

const TZ = 'America/New_York';
const stops: Array<() => void> = [];

function boot(server: FakeServer, opts: EnvOptions = {}, tweak?: (env: StoreEnv) => void) {
  const fe = fakeEnv(server, opts);
  tweak?.(fe.env);
  const store = createAppStore({ eventTimezone: TZ, env: () => fe.env });
  const stop = store.start?.() ?? (() => {});
  stops.push(stop);
  return { store, fe, stop, s: () => store.getState() };
}

/** Let boot (IndexedDB) finish and the first poll run. */
async function ready() {
  await settle();
  await advance(0);
  await advance(50);
}

const syncs = (server: FakeServer) => server.requests('GET', '/api/sync');

beforeEach(() => {
  useStoreTimers();
  // No poll jitter: every visible poll is exactly 6 s after the previous one.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await settle(10);
});

describe('construction and start (A38)', () => {
  it('builds without touching the environment; start() begins, stop() undoes everything', async () => {
    const server = new FakeServer([makeRow(1)]);
    const fe = fakeEnv(server);
    const factory = vi.fn(() => fe.env);
    const timers = vi.getTimerCount();
    const store = createAppStore({ eventTimezone: TZ, env: factory });
    expect(factory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timers);
    expect(store.getServerState?.()).toBe(store.getServerState?.());
    expect(store.getServerState?.()).toMatchObject({ connection: 'live', outbox: [], hydrated: false });
    const stop = store.start?.() ?? (() => {});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fe.listenerCount()).toBeGreaterThan(0);
    await ready();
    expect(store.getState().confirmed.size).toBe(1);
    stop();
    expect(fe.listenerCount()).toBe(0);
    const before = server.log.length;
    await advance(120_000);
    expect(server.log.length).toBe(before);
    // StrictMode: start again after stop.
    stops.push(store.start?.() ?? (() => {}));
    await ready();
    expect(server.log.length).toBeGreaterThan(before);
  });
});

describe('sync loop', () => {
  it('checks the session, does a full fetch, then sends the cursor back verbatim and URL-encoded', async () => {
    const server = new FakeServer([makeRow(1), makeRow(2), makeRow(3)]);
    const { s } = boot(server);
    await ready();
    expect(server.log[0]?.path).toBe('/api/session');
    expect(syncs(server)[0]?.query.get('since')).toBeNull();
    expect(s()).toMatchObject({ hydrated: true, hasData: true, connection: 'live', session: { status: 'active', staff: STAFF.dana.staff } });
    expect(s().confirmed.size).toBe(3);
    const cursor = s().lastSyncAt as string;
    expect(cursor).toMatch(/\.\d{6}\+00:00$/);

    server.change(makeRow(2).id, { status: STATUS.inMedical });
    await advance(7_000);
    const delta = syncs(server)[1];
    expect(delta?.raw).toContain(`since=${encodeURIComponent(cursor)}`);
    expect(delta?.raw).toContain('%2B00%3A00');
    expect(delta?.query.get('since')).toBe(cursor);
    expect(s().confirmed.get(makeRow(2).id)?.status).toBe(STATUS.inMedical);
    expect(s().connection).toBe('live');
  });

  it('keeps row identity when the overlap re-delivers unchanged rows (no re-render)', async () => {
    const server = new FakeServer([makeRow(1), makeRow(2)]);
    const { s } = boot(server);
    await ready();
    const before = s().confirmed;
    await advance(7_000);
    expect(syncs(server)).toHaveLength(2);
    expect(s().confirmed).toBe(before);
  });

  it('pages with the same since and advances the cursor only after the last page (A7)', async () => {
    const server = new FakeServer([1, 2, 3, 4, 5].map((n) => makeRow(n)));
    server.pageSize = 2;
    server.overlap = 0;
    const { s } = boot(server);
    await ready();
    const full = syncs(server);
    expect(full).toHaveLength(3);
    expect(full.map((r) => r.query.get('since'))).toEqual([null, null, null]);
    expect(full[1]?.query.get('afterAt')).toMatch(/\+00:00$/);
    expect(full[1]?.query.get('afterId')).toBeTruthy();
    expect(s().confirmed.size).toBe(5);
    const cursor = s().lastSyncAt;

    // Next delta: 3 changed rows → 2 pages; the second page fails → cursor stays.
    for (const n of [1, 2, 3]) server.change(makeRow(n).id, { clothing: `c${n}` });
    let calls = 0;
    server.override = (req) => {
      if (req.path === '/api/sync' && req.query.get('afterAt') && (calls += 1) === 1) return apiError(503, 'unavailable', 'Try again');
      return undefined;
    };
    await advance(7_000);
    expect(s().lastSyncAt).toBe(cursor);
    expect(s().confirmed.get(makeRow(1).id)?.clothing).toBe('c1'); // first page applied
    await advance(7_000);
    const last = syncs(server).slice(-2);
    expect(last.every((r) => r.query.get('since') === cursor)).toBe(true);
    expect(s().lastSyncAt).not.toBe(cursor);
    expect(s().confirmed.get(makeRow(3).id)?.clothing).toBe('c3');
  });

  it('reconciles every 10th poll and fetches rows whose version differs', async () => {
    const server = new FakeServer([makeRow(1), makeRow(2)]);
    server.overlap = 0;
    const { s } = boot(server);
    await ready();
    // A change the delta never delivers (version bumped without moving updated_at past the cursor).
    const stored = server.rows.get(makeRow(2).id);
    if (stored) stored.row = { ...stored.row, rowVersion: 7, status: STATUS.notInMedical };
    for (let i = 0; i < 9; i += 1) await advance(7_000);
    const reconcile = syncs(server).filter((r) => r.query.get('reconcile') === '1');
    expect(reconcile).toHaveLength(1);
    expect(syncs(server).some((r) => r.query.get('ids') === makeRow(2).id)).toBe(true);
    expect(s().confirmed.get(makeRow(2).id)).toMatchObject({ rowVersion: 7, status: STATUS.notInMedical });
  });

  it('does a full fetch again when the cursor is older than 6 h (no successful poll for that long)', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { s } = boot(server);
    await ready();
    server.override = () => 'network';
    await advance(6 * 3600_000 + 60_000);
    server.override = null;
    const before = syncs(server).length;
    await advance(61_000);
    const recovered = syncs(server)[before];
    expect(recovered?.query.get('since')).toBeNull();
    expect(s().confirmed.size).toBe(1);
  });

  it('polls every 60 s when hidden and at once (coalesced) on focus / pageshow / visible', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { fe } = boot(server);
    await ready();
    fe.setVisible(false);
    await advance(7_000); // the poll scheduled while visible
    const n = syncs(server).length;
    await advance(30_000);
    expect(syncs(server)).toHaveLength(n);
    await advance(31_000);
    expect(syncs(server)).toHaveLength(n + 1);
    fe.setVisible(true);
    fe.fire('window', 'focus');
    fe.fire('window', 'pageshow');
    fe.fire('document', 'visibilitychange');
    await advance(100);
    expect(syncs(server)).toHaveLength(n + 2);
  });

  it('never runs two polls at once; a tap during a poll runs one more right after', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { store } = boot(server);
    await ready();
    let release: (() => void) | null = null;
    server.override = (req) =>
      req.path === '/api/sync' && !release
        ? new Promise<undefined>((r) => {
            release = () => r(undefined);
          })
        : undefined;
    await advance(7_000);
    const n = syncs(server).length;
    store.actions.syncNow();
    store.actions.syncNow();
    await advance(100);
    expect(syncs(server)).toHaveLength(n);
    expect(store.getState().syncing).toBe(true);
    (release as unknown as () => void)();
    await advance(100);
    expect(syncs(server)).toHaveLength(n + 1);
  });
});

describe('connection state', () => {
  it('2 network failures → offline (with 6 s, 12 s backoff); success → live', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { s } = boot(server);
    await ready();
    server.override = (req) => (req.path === '/api/sync' ? 'network' : undefined);
    await advance(7_000);
    expect(s().connection).toBe('live');
    const n = syncs(server).length;
    await advance(6_000);
    expect(syncs(server)).toHaveLength(n + 1);
    expect(s().connection).toBe('offline');
    await advance(10_000);
    expect(syncs(server)).toHaveLength(n + 1);
    server.override = null;
    await advance(1_000);
    expect(s().connection).toBe('live');
  });

  it('a 12 s timeout counts as a network failure', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { s } = boot(server);
    await ready();
    server.override = (req) => (req.path === '/api/sync' ? 'hang' : undefined);
    await advance(7_000 + 12_000);
    await advance(6_000 + 12_000);
    expect(s().connection).toBe('offline');
  });

  it('3 consecutive 5xx → error; a 400 never moves it', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { s } = boot(server);
    await ready();
    server.override = (req) => (req.path === '/api/sync' ? apiError(400, 'bad_request', 'Bad') : undefined);
    await advance(7_000);
    await advance(6_000);
    await advance(12_000);
    expect(s().connection).toBe('live');
    server.override = (req) => (req.path === '/api/sync' ? apiError(503, 'unavailable', 'Try again') : undefined);
    await advance(24_000);
    await advance(60_000);
    expect(s().connection).toBe('live');
    await advance(60_000);
    expect(s().connection).toBe('error');
    server.override = null;
    await advance(60_000);
    expect(s().connection).toBe('live');
  });

  it('navigator offline → offline at once and no request; the online event syncs immediately', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { fe, s } = boot(server);
    await ready();
    fe.setOnline(false);
    fe.fire('window', 'offline');
    expect(s().connection).toBe('offline');
    const n = server.log.length;
    await advance(7_000);
    expect(server.log.length).toBe(n);
    fe.setOnline(true);
    fe.fire('window', 'online');
    await advance(100);
    expect(server.log.length).toBeGreaterThan(n);
    expect(s().connection).toBe('live');
  });
});

describe('session', () => {
  it('a 401 keeps the cache, stops polling and goes to sign-in step 2 with next=', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { fe, s } = boot(server, { path: '/?r=7e570000-0000-4000-8000-000000000001' });
    await ready();
    await advance(3_500); // the cache write
    server.session = null;
    await advance(7_000);
    expect(s().session.status).toBe('expired');
    await advance(1_000);
    expect(fe.redirects).toEqual([`/signin?next=${encodeURIComponent('/?r=7e570000-0000-4000-8000-000000000001')}`]);
    const n = server.log.length;
    await advance(60_000);
    expect(server.log.length).toBe(n);
    const kv = openKv(fe.dbName);
    const keys = (await kv?.keys()) ?? [];
    expect(keys.some((k) => k.endsWith(':rows'))).toBe(true);
  });

  it('does not loop between / and /signin when the API keeps refusing a cookie the proxy accepts', async () => {
    const server = new FakeServer([makeRow(1)]);
    server.session = null;
    const { fe, s } = boot(server);
    fe.session.setItem('lp-401-at', String(Date.now() - 5_000));
    await ready();
    await advance(1_000);
    expect(fe.redirects).toEqual([]);
    expect(s().toasts.map((t) => t.title)).toContain('Session ended');
  });

  it('offline at load: GET /api/session failing is not a 401; the cached list shows', async () => {
    const server = new FakeServer([makeRow(1), makeRow(2)]);
    const first = boot(server);
    await ready();
    await advance(3_500);
    first.stop();
    const second = boot(server, { dbName: first.fe.dbName });
    second.fe.setOnline(false);
    // The env reports offline before start in a real reload; emulate by failing the network too.
    server.override = () => 'network';
    await ready();
    expect(second.s().session).toMatchObject({ status: 'unknown', staffName: 'Dana Kim', staff: STAFF.dana.staff });
    expect(second.s().hasData).toBe(true);
    expect(second.s().confirmed.size).toBe(2);
    expect(second.fe.redirects).toEqual([]);
  });

  it('writes the first rows at once, so an offline reload right after load still has the list', async () => {
    const server = new FakeServer([makeRow(1), makeRow(2), makeRow(3)]);
    const first = boot(server);
    await ready();
    first.stop();
    server.override = () => 'network';
    const second = boot(server, { dbName: first.fe.dbName });
    await ready();
    expect(second.s().confirmed.size).toBe(3);
  });

  it('saves the cache when the page is hidden (iOS may kill it without pagehide)', async () => {
    const server = new FakeServer([makeRow(1)]);
    const first = boot(server);
    await ready();
    server.put(makeRow(2));
    await advance(6_000); // a change: the next write waits for the 3 s throttle
    first.fe.setVisible(false);
    first.fe.fire('document', 'visibilitychange');
    await settle();
    const rows = await openKv(first.fe.dbName)?.get<unknown[]>(`cache:edco26:${'dana kim · gc/hx - dispatch'}:rows`);
    expect(rows).toHaveLength(2);
  });

  it('switches to the right staff cache when someone else signs in on this phone', async () => {
    const server = new FakeServer([makeRow(1)]);
    const first = boot(server);
    await ready();
    await advance(3_500);
    first.stop();
    server.session = { ...STAFF.sam, expiresAt: '2026-11-07T15:00:00.000000+00:00' };
    server.put(makeRow(2));
    const second = boot(server, { dbName: first.fe.dbName });
    await ready();
    expect(second.s().session.staff).toBe(STAFF.sam.staff);
    // Sam's cache was empty: a full fetch, not Dana's cursor.
    expect(syncs(server).at(-1)?.query.get('since')).toBeNull();
    expect(second.s().confirmed.size).toBe(2);
  });
});

describe('detail and stats', () => {
  it('fetchDetail applies the newer row and maps failures to reasons', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { store, s } = boot(server);
    await ready();
    server.change(makeRow(1).id, { clothing: 'Green' });
    const detail = await store.actions.fetchDetail(makeRow(1).id);
    expect(detail.photos).toEqual([]);
    expect(s().confirmed.get(makeRow(1).id)?.clothing).toBe('Green');
    await expect(store.actions.fetchDetail('7e570000-0000-4000-8000-000000000099')).rejects.toMatchObject({ reason: 'not_found' });
    server.override = () => 'network';
    await expect(store.actions.fetchDetail(makeRow(1).id)).rejects.toMatchObject({ reason: 'failed' });
    server.override = null;
    const stats = await store.actions.fetchStats();
    expect(stats.open).toEqual({ waiting: 0, inMedical: 0 });
  });
});

describe('prefs', () => {
  it('setPref updates state.prefs', async () => {
    const server = new FakeServer([]);
    const { store, s } = boot(server);
    await ready();
    store.actions.setPref('bell', true);
    expect(s().prefs.bell).toBe(true);
  });
});

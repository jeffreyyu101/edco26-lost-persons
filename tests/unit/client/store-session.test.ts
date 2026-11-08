// Logout boundary (A14) including a sign-out the server never confirmed, alerts through the store
// (baseline, someone else's change, own mutations, bell, bursts, a sync that fails half-way) and drafts
// (A20). Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { openKv, K } from '@/lib/client/persist';
import { COPY, type StoreEnv } from '@/lib/client/store-core';
import { LOGOUT_PENDING_KEY, announceSignIn } from '@/lib/client/session-signals';
import type { AlertEvent } from '@/lib/client/store-contract';
import { STATUS } from '@/lib/domain';
import { MemoryStorage, advance, settle } from './helpers/env';
import { boot, finish, gate, installStoreHooks, photo, ready, values } from './helpers/boot';
import { FakeServer, STAFF, apiError, makeRow } from './helpers/fake-server';

installStoreHooks();

const CMID = (n: number) => `d0d00000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('sign out (A14)', () => {
  it('is refused while unsent outbox items exist, unless discarded explicitly', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, s, fe } = boot(server);
    await ready();
    fe.setOnline(false);
    await finish(a.create({ values: values(), clientMutationId: CMID(1), photos: [], photoTiming: 'today' }));
    expect(await finish(a.signOut())).toEqual({ ok: false, reason: 'outbox', count: 1 });
    expect(s().session.status).toBe('active');
    expect(fe.redirects).toEqual([]);
    fe.setOnline(true);
    expect(await finish(a.signOut({ discardOutbox: true }))).toEqual({ ok: true });
    expect(s().outbox).toHaveLength(0);
    expect((await openKv(fe.dbName)?.keys()) ?? []).toEqual([]);
  });

  it('clears memory, IndexedDB, the draft and the cookie in this tab and every other tab', async () => {
    const server = new FakeServer([makeRow(1), makeRow(2)]);
    const one = boot(server);
    await ready();
    const two = boot(server, { dbName: one.fe.dbName, channelName: `${one.fe.dbName}-channel` });
    await ready();
    one.a.draft.save({ clientMutationId: CMID(2), values: values(), photos: [photo('e0000000-0000-4000-8000-000000000001')], photoTiming: 'today', updatedAt: 1 });
    await settle();
    await advance(3_500);
    expect(two.s().confirmed.size).toBe(2);
    const keysBefore = (await openKv(one.fe.dbName)?.keys()) ?? [];
    expect(keysBefore.some((k) => k.endsWith(':rows'))).toBe(true);
    expect(keysBefore).toContain(K.draft);

    const res = await finish(one.a.signOut());
    expect(res).toEqual({ ok: true });
    expect(server.requests('DELETE', '/api/session')).toHaveLength(1);
    expect(one.s()).toMatchObject({ session: { status: 'signed_out' }, hasData: false });
    expect(one.s().confirmed.size).toBe(0);
    expect(one.s().generation).toBe(1);
    expect(one.fe.redirects).toEqual(['/signin']);
    await settle(200);
    expect(two.s().confirmed.size).toBe(0);
    expect(two.s().generation).toBe(1);
    expect(two.fe.redirects).toEqual(['/signin']);
    const keysAfter = (await openKv(one.fe.dbName)?.keys()) ?? [];
    expect(keysAfter).toEqual([]);
    const n = server.log.length;
    await advance(60_000);
    expect(server.log.length).toBe(n);
  });

  it('regression: never claims success when the server did not clear the cookie; retries, keeps everything, says so', async () => {
    const server = new FakeServer([makeRow(1), makeRow(2)]);
    const one = boot(server);
    await ready();
    const two = boot(server, { dbName: one.fe.dbName, channelName: `${one.fe.dbName}-channel` });
    await ready();
    await advance(3_500); // the cache write
    server.override = (req) => (req.path === '/api/session' && req.method === 'DELETE' ? apiError(503, 'unavailable', 'Try again') : undefined);
    const res = await finish(one.a.signOut(), 5_000);
    expect(res).toEqual({ ok: false, reason: 'failed', message: COPY.signOutFailed });
    expect(server.requests('DELETE', '/api/session')).toHaveLength(3); // retried (1 s, 2 s)
    expect(server.session).not.toBeNull(); // the cookie still works…
    expect(one.fe.redirects).toEqual([]); // …so /signin is not opened (it would bounce straight back)
    expect(one.s()).toMatchObject({ session: { status: 'active', staff: STAFF.dana.staff }, generation: 0, hasData: true });
    expect(one.s().confirmed.size).toBe(2);
    expect(one.fe.local.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(((await openKv(one.fe.dbName)?.keys()) ?? []).some((k) => k.endsWith(':rows'))).toBe(true);
    await settle(200);
    expect(two.s().confirmed.size).toBe(2); // other tabs were never told to sign out
    expect(two.fe.redirects).toEqual([]);
    // The session simply goes on: polling resumes.
    const n = server.requests('GET', '/api/sync').length;
    await advance(7_000);
    expect(server.requests('GET', '/api/sync').length).toBeGreaterThan(n);
  });

  it("F6 follow-up: a confirmed sign-out forgets the bell (the staff member's server switch); a failed one keeps it", async () => {
    // The page's localStorage (lib/client/prefs.ts reads window.localStorage).
    const local = new MemoryStorage();
    vi.stubGlobal('window', { localStorage: local, addEventListener() {}, removeEventListener() {} });
    let stop = () => {};
    try {
      const server = new FakeServer([makeRow(1)]);
      const booted = boot(server);
      const { a, s } = booted;
      stop = booted.stop;
      await ready();
      // ActivityHost copied the server's switch (Medical's team default, say), and the server had answered.
      a.setPref('bellIntroSeen', true);
      a.setPref('bell', true);
      local.setItem('lp-bell-server', '1');
      server.override = (req) => (req.path === '/api/session' && req.method === 'DELETE' ? apiError(503, 'unavailable', 'Try again') : undefined);
      expect(await finish(a.signOut(), 5_000)).toMatchObject({ ok: false });
      expect(s().prefs).toMatchObject({ bell: true, bellIntroSeen: true });
      expect(local.getItem('lp-bell')).toBe('1');
      server.override = null;
      expect(await finish(a.signOut(), 5_000)).toEqual({ ok: true });
      // The next staff member on this phone starts from their own switch, not this one.
      expect(s().prefs).toMatchObject({ bell: false, bellIntroSeen: false });
      expect(['lp-bell', 'lp-bell-intro-seen', 'lp-bell-server'].map((k) => local.getItem(k))).toEqual([null, null, null]);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });

  it('regression: a DELETE lost to the network is retried, and only a confirmed one signs out', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, s, fe } = boot(server);
    await ready();
    let drops = 1;
    server.override = (req) => (req.path === '/api/session' && req.method === 'DELETE' && drops-- > 0 ? 'network' : undefined);
    const res = await finish(a.signOut(), 2_000);
    expect(res).toEqual({ ok: true });
    expect(server.requests('DELETE', '/api/session')).toHaveLength(2);
    expect(server.session).toBeNull();
    expect(s()).toMatchObject({ session: { status: 'signed_out' }, generation: 1 });
    expect(fe.redirects).toEqual(['/signin']);
    expect(fe.local.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('regression: offline, sign-out is refused at once (no cookie can be cleared) and nothing is lost', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, s, fe } = boot(server);
    await ready();
    fe.setOnline(false);
    server.override = () => 'network';
    const res = await finish(a.signOut());
    expect(res).toEqual({ ok: false, reason: 'failed', message: COPY.signOutFailed });
    expect(fe.redirects).toEqual([]);
    expect(s().session.status).toBe('active');
    expect(s().confirmed.size).toBe(1);
  });

  it('nothing is synced or sent while the sign-out is pending; a double tap sends one DELETE', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const { a, s } = boot(server);
    await ready();
    const g = gate();
    server.override = (req) => (req.path === '/api/session' && req.method === 'DELETE' ? g.wait() : undefined);
    const first = a.signOut();
    const second = a.signOut();
    await settle(20);
    const n = server.log.length;
    const write = await finish(a.setStatus(row.id, STATUS.inMedical, 'answer'));
    expect(write).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect((await finish(a.create({ values: values(), clientMutationId: CMID(9), photos: [], photoTiming: 'today' }))).outcome).toBe('not_saved');
    await advance(30_000);
    expect(server.log.length).toBe(n); // no poll, no write, no create while pending
    server.override = null;
    g.open();
    expect(await finish(first)).toEqual({ ok: true });
    expect(await finish(second)).toEqual({ ok: true });
    expect(server.requests('DELETE', '/api/session')).toHaveLength(1);
    expect(s().session.status).toBe('signed_out');
  });

  it('a 401 on DELETE means the server already refuses the cookie: signed out', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, fe } = boot(server);
    await ready();
    server.session = null; // the cookie expired meanwhile
    server.override = (req) => (req.path === '/api/session' && req.method === 'DELETE' ? apiError(401, 'unauthorized', 'Sign in again') : undefined);
    expect(await finish(a.signOut())).toEqual({ ok: true });
    expect(fe.redirects).toEqual(['/signin']);
  });

  it('regression: an HTML 401 to the DELETE (a portal, not our API) is not taken as signed out', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, s, fe } = boot(server);
    await ready();
    server.override = (req) =>
      req.path === '/api/session' && req.method === 'DELETE' ? new Response('<html>Log in to Wi-Fi</html>', { status: 401, headers: { 'content-type': 'text/html' } }) : undefined;
    const res = await finish(a.signOut(), 5_000);
    expect(res).toEqual({ ok: false, reason: 'failed', message: COPY.signOutFailed });
    expect(server.requests('DELETE', '/api/session')).toHaveLength(3); // unknown outcome: retried
    expect(fe.redirects).toEqual([]);
    expect(s().session.status).toBe('active');
  });

  it('regression: a page loaded while a sign-out is pending finishes it before it trusts the cookie', async () => {
    const server = new FakeServer([makeRow(1)]);
    const first = boot(server);
    await ready();
    await advance(3_500);
    first.stop();
    // The app was killed mid sign-out (the marker survives); the cookie still works.
    const local = new MemoryStorage();
    local.setItem(LOGOUT_PENDING_KEY, JSON.stringify({ at: Date.now(), discard: false }));
    const before = server.log.length;
    const second = boot(server, { dbName: first.fe.dbName, local });
    const statuses: string[] = [];
    second.store.subscribe(() => statuses.push(second.s().session.status));
    await ready();
    await advance(100);
    // Nothing before the DELETE; the only GET /api/session is the check that the cookie is gone (401).
    expect(server.log.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(['DELETE /api/session', 'GET /api/session']);
    expect(statuses).not.toContain('active');
    expect(second.s().session.status).toBe('signed_out');
    expect(second.fe.redirects).toEqual(['/signin']);
    expect(local.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(((await openKv(first.fe.dbName)?.keys()) ?? []).some((k) => k.startsWith('cache:'))).toBe(false);
  });

  it('a pending sign-out that still cannot finish at load says so and leaves the session as it is', async () => {
    const server = new FakeServer([makeRow(1)]);
    const local = new MemoryStorage();
    local.setItem(LOGOUT_PENDING_KEY, JSON.stringify({ at: Date.now(), discard: false }));
    server.override = (req) => (req.path === '/api/session' && req.method === 'DELETE' ? apiError(503, 'unavailable', 'Try again') : undefined);
    const { s, fe } = boot(server, { local });
    await ready();
    await advance(3_100);
    await advance(100);
    expect(server.requests('DELETE', '/api/session')).toHaveLength(3);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.signOutFailed);
    expect(fe.redirects).toEqual([]);
    expect(s().session.status).toBe('active');
    expect(local.getItem(LOGOUT_PENDING_KEY)).toBeNull();
  });

  it('a successful sign-in removes a pending sign-out and tells open tabs (announceSignIn)', async () => {
    const local = new MemoryStorage();
    local.setItem(LOGOUT_PENDING_KEY, JSON.stringify({ at: 1, discard: true }));
    const heard: unknown[] = [];
    const listener = new BroadcastChannel('lp');
    listener.onmessage = (e: MessageEvent) => heard.push(e.data);
    vi.stubGlobal('window', { localStorage: local });
    try {
      announceSignIn();
    } finally {
      vi.unstubAllGlobals();
    }
    await settle(20);
    listener.close();
    expect(local.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    expect(heard).toEqual([{ type: 'signin' }]);
  });

  it('ignores responses from before the sign-out (generation)', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, s } = boot(server);
    await ready();
    const g = gate();
    server.override = (req) => (req.path === '/api/sync' ? g.wait() : undefined);
    server.put(makeRow(9));
    await advance(7_000);
    const out = a.signOut();
    await settle(50);
    server.override = null;
    g.open();
    await finish(out);
    await settle(50);
    expect(s().confirmed.size).toBe(0);
  });
});

/**
 * The server re-issues the cookie on an authenticated answer once it is over 1 h old (sliding session).
 * This fetch answers at once (the server side is done, with that re-issued cookie) but the answer is slow
 * to reach the phone: the cookie is stored only when the answer arrives, never when it was aborted.
 */
function slowAnswers(server: FakeServer, match: (method: string, path: string) => boolean, late: ReturnType<typeof gate>): StoreEnv['fetch'] {
  return async (input, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = new URL(input, 'https://lp.test').pathname;
    if (!match(method, path)) return server.fetch(input, init);
    const reissued = server.session;
    const res = await server.fetch(input, init);
    await new Promise<void>((resolve, reject) => {
      const signal = init.signal;
      const aborted = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      void late.wait().then(() => resolve());
    });
    if (reissued) server.session = reissued; // the browser stores the re-issued cookie
    return res;
  };
}

describe('sign out vs answers still on their way (regression: a re-issued cookie must not survive it)', () => {
  it('aborts this tab’s requests before the DELETE, so a late answer cannot bring the cookie back', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const late = gate();
    const { a, s, fe } = boot(server, {}, (env) => {
      env.fetch = slowAnswers(server, (method, path) => method === 'POST' && path.endsWith('/status'), late);
    });
    await ready();
    const write = a.setStatus(row.id, STATUS.inMedical, 'answer');
    await settle(20);
    expect(server.requests('POST', `/api/requests/${row.id}/status`)).toHaveLength(1);
    expect(await finish(a.signOut())).toEqual({ ok: true });
    expect(server.session).toBeNull();
    late.open(); // the write's answer arrives now, after the sign-out
    await settle(50);
    expect(server.session).toBeNull(); // its re-issued cookie never landed: /signin stays on /signin
    expect(await finish(write)).toMatchObject({ ok: false });
    expect(s().session.status).toBe('signed_out');
    expect(fe.redirects).toEqual(['/signin']);
  });

  it('an answer that lands right after the DELETE is caught by the check, and the cookie is cleared again', async () => {
    const server = new FakeServer([makeRow(1)]);
    let landed = false;
    const { a, fe } = boot(server, {}, (env) => {
      const inner = env.fetch;
      env.fetch = async (input, init = {}) => {
        const res = await inner(input, init);
        if ((init.method ?? 'GET') === 'DELETE' && !landed) {
          landed = true;
          // An answer this tab could not abort (another tab's) re-issued the cookie after the clear.
          server.session = { ...STAFF.dana, expiresAt: '2026-11-07T15:00:00.000000+00:00' };
        }
        return res;
      };
    });
    await ready();
    expect(await finish(a.signOut(), 2_000)).toEqual({ ok: true });
    expect(server.requests('DELETE', '/api/session')).toHaveLength(2);
    expect(server.session).toBeNull();
    expect(fe.redirects).toEqual(['/signin']);
  });

  it('fetchStats and fetchDetail send nothing while the sign-out is pending', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const { a } = boot(server);
    await ready();
    const g = gate();
    server.override = (req) => (req.path === '/api/session' && req.method === 'DELETE' ? g.wait() : undefined);
    const out = a.signOut();
    await settle(20);
    const n = server.log.length;
    await expect(finish(a.fetchStats())).rejects.toMatchObject({ reason: 'failed' });
    await expect(finish(a.fetchDetail(row.id))).rejects.toMatchObject({ reason: 'failed' });
    expect(server.log.length).toBe(n);
    server.override = null;
    g.open();
    expect(await finish(out)).toEqual({ ok: true });
  });

  it('other tabs abort what they have on its way and send nothing until the sign-out ended', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const one = boot(server);
    await ready();
    const late = gate();
    const two = boot(server, { dbName: one.fe.dbName, channelName: `${one.fe.dbName}-channel` }, (env) => {
      env.fetch = slowAnswers(server, (method, path) => method === 'POST' && path.endsWith('/status'), late);
    });
    await ready();
    const write = two.a.setStatus(row.id, STATUS.inMedical, 'answer');
    await settle(20);
    // The DELETE is slow, and fails in the end.
    const del = gate();
    server.override = async (req) => {
      if (req.path !== '/api/session' || req.method !== 'DELETE') return undefined;
      await del.wait();
      return apiError(503, 'unavailable', 'Try again');
    };
    const out = one.a.signOut();
    await settle(200);
    expect(await finish(write)).toMatchObject({ ok: false }); // aborted when tab two heard the sign-out
    const n = server.log.length;
    await advance(30_000); // nothing from either tab while it is pending
    expect(server.log.length).toBe(n);
    late.open();
    del.open();
    expect(await finish(out, 5_000)).toMatchObject({ ok: false, reason: 'failed' });
    await settle(200);
    // It failed: tab two goes on as before.
    const syncs = server.requests('GET', '/api/sync').length;
    await advance(7_000);
    expect(server.requests('GET', '/api/sync').length).toBeGreaterThan(syncs);
    expect(two.fe.redirects).toEqual([]);
    expect(two.s().session.status).toBe('active');
  });

  it('another tab’s late answer is aborted when the sign-out succeeds too', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const one = boot(server);
    await ready();
    const late = gate();
    const two = boot(server, { dbName: one.fe.dbName, channelName: `${one.fe.dbName}-channel` }, (env) => {
      env.fetch = slowAnswers(server, (method, path) => method === 'POST' && path.endsWith('/status'), late);
    });
    await ready();
    const write = two.a.setStatus(row.id, STATUS.inMedical, 'answer');
    await settle(20);
    expect(await finish(one.a.signOut())).toEqual({ ok: true });
    await settle(200);
    late.open();
    await settle(50);
    expect(await finish(write)).toMatchObject({ ok: false });
    expect(server.session).toBeNull();
    expect(two.fe.redirects).toEqual(['/signin']);
  });

  it('a page loaded while a sign-out is pending holds everything from start(), before boot has loaded', async () => {
    const server = new FakeServer([makeRow(1)]);
    const first = boot(server);
    await ready();
    first.fe.setOnline(false);
    await finish(first.a.create({ values: values(), clientMutationId: CMID(5), photos: [], photoTiming: 'today' }));
    first.stop();
    // "Discard & sign out" was tapped, then the app was killed: the queued request must never be sent.
    const local = new MemoryStorage();
    local.setItem(LOGOUT_PENDING_KEY, JSON.stringify({ at: Date.now(), discard: true }));
    const before = server.log.length;
    const second = boot(server, { dbName: first.fe.dbName, local });
    const statuses: string[] = [];
    second.store.subscribe(() => statuses.push(second.s().session.status));
    // The page comes to the front at once: these fire before boot has read IndexedDB.
    second.fe.fire('document', 'visibilitychange');
    second.fe.fire('window', 'pageshow');
    second.fe.fire('window', 'focus');
    second.fe.fire('window', 'online');
    await ready();
    await advance(100);
    expect(server.log.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(['DELETE /api/session', 'GET /api/session']);
    expect(statuses).not.toContain('active');
    expect(second.s().session.status).toBe('signed_out');
    expect(((await openKv(first.fe.dbName)?.keys()) ?? []).some((k) => k.startsWith('outbox:'))).toBe(false);
  });
});

describe('alerts through the store', () => {
  it('the first sync is the baseline; then my request answered by someone else alerts once (toast + listeners)', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    // Already answered before load: the baseline must not alert it.
    server.change(mine.id, { status: STATUS.notInMedical });
    const { store, s } = boot(server);
    const heard: AlertEvent[] = [];
    store.actions.subscribeAlerts((e) => heard.push(e));
    await ready();
    expect(heard).toEqual([]);
    expect(s().toasts).toEqual([]);
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(heard.map((e) => e.title)).toEqual(['LP-1004 · Sofia Lopez located']);
    const toast = s().toasts.find((t) => t.title === 'LP-1004 · Sofia Lopez located');
    expect(toast).toMatchObject({ subtitle: 'Friend can head over', tone: 'green', durationMs: null, action: { label: 'View' } });
    await advance(6_000); // the overlap re-delivers the row: no second alert
    expect(heard).toHaveLength(1);
  });

  it('never alerts this phone’s own mutations', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { store, s } = boot(server);
    const listener = vi.fn();
    store.actions.subscribeAlerts(listener);
    await ready();
    await finish(store.actions.setStatus(mine.id, STATUS.inMedical, 'answer'));
    await advance(6_000);
    expect(listener).not.toHaveBeenCalled();
    expect(s().toasts.some((t) => t.title.includes(' located'))).toBe(false);
  });

  it('new requests by others alert only with the bell on; more than 2 combine', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { store, s } = boot(server);
    const heard: AlertEvent[] = [];
    store.actions.subscribeAlerts((e) => heard.push(e));
    await ready();
    server.put(makeRow(20, { firstName: 'T.', lastName: 'R.', caseNumber: 1013 }));
    await advance(6_000);
    expect(heard).toEqual([]);
    store.actions.setPref('bell', true);
    server.put(makeRow(21, { caseNumber: 1014 }));
    await advance(6_000);
    expect(heard.map((e) => e.title)).toEqual(['New request · LP-1014']);
    server.put(makeRow(22));
    server.put(makeRow(23));
    server.put(makeRow(24));
    await advance(6_000);
    expect(heard.at(-1)).toEqual({ kind: 'combined', title: '3 updates', count: 3 });
    expect(s().toasts.map((t) => t.title)).toContain('3 updates');
  });
});

describe('alerts of a sync that fails half-way (regression)', () => {
  it('an alert on an applied page is shown even though a later request of that sync timed out, and only once', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine, makeRow(5)]);
    server.overlap = 0;
    const { store, s } = boot(server);
    const heard: AlertEvent[] = [];
    store.actions.subscribeAlerts((e) => heard.push(e));
    await ready();
    server.pageSize = 1;
    server.change(mine.id, { status: STATUS.inMedical }); // page 1
    server.change(makeRow(5).id, { clothing: 'Blue' }); // page 2
    let hung = false;
    server.override = (req) => {
      if (req.path === '/api/sync' && req.query.get('afterAt') && !hung) {
        hung = true;
        return 'hang';
      }
      return undefined;
    };
    await advance(6_000);
    expect(s().confirmed.get(mine.id)?.status).toBe(STATUS.inMedical); // page 1 is applied at once
    await advance(12_000); // page 2 times out
    expect(hung).toBe(true);
    expect(heard.map((e) => e.title)).toEqual(['LP-1004 · Sofia Lopez located']);
    expect(s().toasts.filter((t) => t.title === 'LP-1004 · Sofia Lopez located')).toHaveLength(1);
    await advance(6_000); // the retry completes the sync: no second alert
    await advance(6_000);
    expect(s().confirmed.get(makeRow(5).id)?.clothing).toBe('Blue');
    expect(heard).toHaveLength(1);
  });

  it('a 5xx on the reconcile fetch does not lose the alert of an earlier page either', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { store } = boot(server);
    const heard: AlertEvent[] = [];
    store.actions.subscribeAlerts((e) => heard.push(e));
    await ready();
    for (let i = 0; i < 8; i += 1) await advance(6_000); // polls 2–9; the next one reconciles
    server.change(mine.id, { status: STATUS.notInMedical });
    // A row the delta never delivers makes the reconcile fetch ids; that fetch fails.
    server.put(makeRow(6));
    const other = server.rows.get(makeRow(6).id);
    if (other) other.seq = -1;
    server.override = (req) => (req.path === '/api/sync' && req.query.get('ids') ? apiError(503, 'unavailable', 'Try again') : undefined);
    await advance(6_000);
    expect(server.requests('GET', '/api/sync').some((r) => r.query.get('ids'))).toBe(true);
    expect(heard.map((e) => e.title)).toEqual(['LP-1004 · Sofia Lopez — not located']);
  });

  it('an out-of-date alert held back by a page that then times out never closes the newer toast', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine, makeRow(5)]);
    server.overlap = 0;
    const { a, s } = boot(server);
    await ready();
    server.pageSize = 1;
    server.change(mine.id, { status: STATUS.notInMedical }); // page 1
    server.change(makeRow(5).id, { clothing: 'Blue' }); // page 2
    let hung = false;
    server.override = (req) => {
      if (req.path === '/api/sync' && req.query.get('afterAt') && !hung) {
        hung = true;
        return 'hang';
      }
      return undefined;
    };
    await advance(6_000);
    expect(hung).toBe(true);
    expect(s().confirmed.get(mine.id)?.status).toBe(STATUS.notInMedical); // applied; its alert held back
    server.change(mine.id, { status: STATUS.inMedical }); // the answer is corrected
    await finish(a.fetchDetail(mine.id)); // the open profile refetches: shown at once
    const IN_MED = 'LP-1004 · Sofia Lopez located';
    expect(s().toasts.map((t) => t.title)).toEqual([IN_MED]);
    await advance(12_000); // page 2 times out: the held "not located" is out of date
    expect(s().toasts.map((t) => t.title)).toEqual([IN_MED]);
    await advance(30_000); // sticky, and nothing re-raises it
    expect(s().toasts.map((t) => t.title)).toEqual([IN_MED]);
  });

  it('the first sync after load is still the baseline when it fails half-way', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff, status: STATUS.inMedical });
    const server = new FakeServer([mine, makeRow(5)]);
    server.pageSize = 1;
    let failed = false;
    server.override = (req) => {
      if (req.path === '/api/sync' && req.query.get('afterAt') && !failed) {
        failed = true;
        return apiError(503, 'unavailable', 'Try again');
      }
      return undefined;
    };
    const { store, s } = boot(server);
    const heard: AlertEvent[] = [];
    store.actions.subscribeAlerts((e) => heard.push(e));
    await ready();
    await advance(6_000);
    await advance(6_000);
    expect(failed).toBe(true);
    expect(s().confirmed.size).toBe(2);
    expect(heard).toEqual([]);
  });
});

describe('alert toasts follow the request (regression: stale "is in medical")', () => {
  const IN_MED = 'LP-1004 · Sofia Lopez located';
  const titles = (s: () => { toasts: readonly { title: string }[] }) => s().toasts.map((t) => t.title);

  it('a changed answer replaces the sticky In medical toast, and nothing stale is left after it closes', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s } = boot(server);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(titles(s)).toEqual([IN_MED]);
    await advance(7_000); // past the liaison's Undo window: the green toast is still up (sticky)
    expect(titles(s)).toEqual([IN_MED]);
    server.change(mine.id, { status: STATUS.notInMedical }); // Change answer
    await advance(6_000);
    expect(titles(s)).toEqual(['LP-1004 · Sofia Lopez — not located']);
    await advance(14_000);
    expect(titles(s)).toEqual([]);
    expect(s().confirmed.get(mine.id)?.status).toBe(STATUS.notInMedical);
  });

  it('an Undo after the phone already polled replaces it with "waiting for check"', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s } = boot(server);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(titles(s)).toEqual([IN_MED]);
    server.change(mine.id, { status: STATUS.waiting }); // the liaison's Undo
    await advance(6_000);
    expect(titles(s)).toEqual(['LP-1004 · Sofia Lopez — waiting for check']);
  });

  it('closes when the row leaves In medical without an alert (my own tap, or me on another phone)', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const other = makeRow(5, { firstName: 'Ana', lastName: 'Diaz', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine, other]);
    const { a, s } = boot(server);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    server.change(other.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(titles(s)).toEqual([IN_MED, 'LP-1005 · Ana Diaz located']);
    // This phone taps Reunited: the alert for that request closes, the other one stays.
    await finish(a.setStatus(mine.id, STATUS.reunited, 'reunite'));
    expect(titles(s)).toEqual(['LP-1005 · Ana Diaz located']);
    // The same staff changes the other on another phone: no alert (not "someone else"), the toast closes.
    server.change(other.id, { status: STATUS.notInMedical }, STAFF.dana.staff);
    await advance(6_000);
    expect(titles(s)).toEqual([]);
  });
});

describe('drafts (A20)', () => {
  it('saves debounced, flushes at once when a photo is added, survives a reload, clears after send', async () => {
    const server = new FakeServer([]);
    const first = boot(server);
    await ready();
    const d = { clientMutationId: CMID(3), values: values({ name: 'K.M.' }), photos: [] as ReturnType<typeof photo>[], photoTiming: 'today' as const, updatedAt: 1 };
    first.a.draft.save(d);
    await settle();
    expect(await openKv(first.fe.dbName)?.get(K.draft)).toBeUndefined();
    await advance(300);
    expect(await openKv(first.fe.dbName)?.get(K.draft)).toMatchObject({ clientMutationId: CMID(3) });
    first.a.draft.save({ ...d, photos: [photo('e0000000-0000-4000-8000-000000000003')], updatedAt: 2 });
    await settle(80);
    const stored = await openKv(first.fe.dbName)?.get<{ photos: unknown[] }>(K.draft);
    expect(stored?.photos).toHaveLength(1);
    first.a.draft.save({ ...d, values: values({ name: 'K.M.', clothing: 'Pink hat' }), photos: [photo('e0000000-0000-4000-8000-000000000003')], updatedAt: 3 });
    first.fe.fire('window', 'pagehide');
    await settle(80);
    first.stop();
    const second = boot(server, { dbName: first.fe.dbName });
    await ready();
    const loaded = await finish(second.a.draft.load());
    expect(loaded?.values.clothing).toBe('Pink hat');
    expect(loaded?.photos[0]?.photoId).toBe('e0000000-0000-4000-8000-000000000003');
    expect(await loaded?.photos[0]?.blob.arrayBuffer()).toEqual(await photo('x').blob.arrayBuffer());
    // Sending it clears the draft.
    const res = await finish(second.a.create({ values: loaded!.values, clientMutationId: CMID(3), photos: loaded!.photos, photoTiming: 'today' }));
    expect(res.outcome).toBe('sent');
    await advance(100);
    expect(await finish(second.a.draft.load())).toBeNull();
    const keys = (await openKv(first.fe.dbName)?.keys()) ?? [];
    expect(keys.some((k) => k.startsWith('blob:'))).toBe(false);
  });

  it('refuses the update reload while a draft or an outbox job exists', async () => {
    const server = new FakeServer([]);
    const { a, s } = boot(server);
    await ready();
    a.draft.save({ clientMutationId: CMID(4), values: values(), photos: [], photoTiming: 'today', updatedAt: 1 });
    expect(await finish(a.applyUpdate())).toBe(false);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.finishDraft);
    await finish(a.draft.clear());
    expect(await finish(a.applyUpdate())).toBe(false); // no service worker in tests: nothing to activate
  });
});

// (network fix 1b, 2026-11-08) One session check per resume: the overdue poll timer runs before visibilitychange and
// starts a check; the event then re-asked while that check was in flight, and confirmSession looped into a second
// serial GET /api/session (a third of warm resumes in the field). A check sent under 2 s ago is not asked again;
// a sign-in in another tab, a bfcache return and a check sent before the hide still re-check.
describe('one session check per resume (fix 1b)', () => {
  const sessionGets = (server: FakeServer) => server.requests('GET', '/api/session').length;
  /** GET /api/session answers after `ms` of fake time. */
  const slowSession = (server: FakeServer, ms: number) => {
    server.override = async (req) => {
      if (req.path === '/api/session') await new Promise((r) => setTimeout(r, ms));
      return undefined;
    };
  };

  it('timer-first resume (poll timer far overdue, then visibilitychange): exactly one GET /api/session', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { fe } = boot(server);
    await ready();
    fe.setVisible(false);
    fe.fire('document', 'visibilitychange');
    vi.setSystemTime(Date.now() + 10 * 60_000); // locked for 10 minutes: no timer ran
    slowSession(server, 800);
    const before = sessionGets(server);
    await advance(6_000); // the overdue poll timer fires first and starts the check
    expect(sessionGets(server)).toBe(before + 1);
    fe.setVisible(true);
    fe.fire('document', 'visibilitychange'); // the page hears it is visible while that check is in flight
    await advance(3_000);
    expect(sessionGets(server)).toBe(before + 1);
  });

  it('a cold load hearing visibilitychange during its check: one GET /api/session', async () => {
    const server = new FakeServer([makeRow(1)]);
    slowSession(server, 800);
    const { fe, s } = boot(server);
    await settle();
    await advance(100);
    fe.fire('document', 'visibilitychange');
    await advance(3_000);
    expect(sessionGets(server)).toBe(1);
    expect(s().session.status).toBe('active');
  });

  it('a sign-in announced by another tab during an in-flight check still re-checks', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { fe } = boot(server);
    await ready();
    fe.setVisible(false);
    fe.fire('document', 'visibilitychange');
    slowSession(server, 800);
    const before = sessionGets(server);
    fe.setVisible(true);
    fe.fire('document', 'visibilitychange');
    await advance(100);
    expect(sessionGets(server)).toBe(before + 1);
    const other = new BroadcastChannel(`${fe.dbName}-channel:lp`);
    other.postMessage({ type: 'signin' });
    other.close();
    await settle(20);
    await advance(3_000);
    expect(sessionGets(server)).toBe(before + 2);
  });

  it('a check sent before the hide (over 2 s old at resume) still re-checks', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { fe } = boot(server);
    await ready();
    fe.setVisible(false);
    fe.fire('document', 'visibilitychange');
    slowSession(server, 4_000);
    const before = sessionGets(server);
    fe.setVisible(true);
    fe.fire('document', 'visibilitychange'); // check 1 goes out
    await advance(500);
    fe.setVisible(false);
    fe.fire('document', 'visibilitychange');
    await advance(2_500);
    fe.setVisible(true);
    fe.fire('document', 'visibilitychange'); // check 1 is 3 s old: who is signed in may have changed since
    await advance(10_000);
    expect(sessionGets(server)).toBe(before + 2);
  });
});

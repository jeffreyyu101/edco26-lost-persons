// Which staff a tab acts as (regression): the cookie is shared by every tab of the phone, so a tab that
// was suspended while someone else signed in must confirm GET /api/session before it syncs on, writes or
// sends queued requests, and switch its per-staff cache, "My requests" and outbox prompt to that staff.
// Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { K } from '@/lib/client/persist';
import { mineRows } from '@/lib/client/selectors';
import { COPY } from '@/lib/client/store-core';
import type { AlertEvent } from '@/lib/client/store-contract';
import { STATUS, canonStaff } from '@/lib/domain';
import { advance, settle } from './helpers/env';
import { boot, finish, gate, installStoreHooks, ready, values } from './helpers/boot';
import { FakeServer, STAFF, apiError, makeRow } from './helpers/fake-server';

installStoreHooks();

const CMID = (n: number) => `1d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SAM = { ...STAFF.sam, expiresAt: '2026-11-07T15:00:00.000000+00:00' };
const creates = (server: FakeServer) => server.requests('POST', '/api/requests').filter((r) => r.path === '/api/requests');

type Booted = ReturnType<typeof boot>;

/** The tab is hidden (suspended); meanwhile Dana's session ended and Sam signed in in another tab. */
function suspendWhileSamSignsIn(tab: Booted, server: FakeServer) {
  tab.fe.setVisible(false);
  tab.fe.fire('document', 'visibilitychange');
  server.session = SAM;
}

function resume(tab: Booted) {
  tab.fe.setVisible(true);
  tab.fe.fire('document', 'visibilitychange');
}

describe('a resumed tab confirms who is signed in (regression)', () => {
  it('checks GET /api/session before syncing on and takes the staff the cookie now belongs to', async () => {
    const danas = makeRow(1, { createdBy: STAFF.dana.staff });
    const sams = makeRow(2, { createdBy: STAFF.sam.staff });
    const server = new FakeServer([danas, sams]);
    const tab = boot(server);
    await ready();
    const mine = () => mineRows([...tab.s().confirmed.values()], tab.s().myIds, tab.s().session.staff).map((r) => r.id);
    expect(mine()).toEqual([danas.id]);
    suspendWhileSamSignsIn(tab, server);
    const before = server.log.length;
    resume(tab);
    await advance(100);
    await advance(100);
    const after = server.log.slice(before);
    expect(after[0]).toMatchObject({ method: 'GET', path: '/api/session' });
    expect(tab.s().session).toMatchObject({ status: 'active', staffName: 'Sam Lee', staff: STAFF.sam.staff });
    // The per-staff cache starts clean for Sam (a full fetch), and My requests follow him.
    // (lab) The first page went out with the check and was dropped (stale); the sync applied is Sam's full fetch.
    expect(after.some((r) => r.path === '/api/sync' && r.query.get('since') === null)).toBe(true);
    expect(tab.s().confirmed.size).toBe(2);
    expect(mine()).toEqual([sams.id]);
  });

  it('a sign-in announced by another tab makes this tab re-check at once', async () => {
    const server = new FakeServer([makeRow(1)]);
    const tab = boot(server);
    await ready();
    server.session = SAM;
    const other = new BroadcastChannel(`${tab.fe.dbName}-channel:lp`);
    other.postMessage({ type: 'signin' });
    other.close();
    await settle(20);
    await advance(100);
    expect(tab.s().session.staff).toBe(STAFF.sam.staff);
  });

  it('a queued request saved by Dana is not sent under Sam without asking', async () => {
    const server = new FakeServer([]);
    const tab = boot(server);
    await ready();
    tab.fe.setOnline(false);
    await finish(tab.a.create({ values: values(), clientMutationId: CMID(1), photos: [], photoTiming: 'today' }));
    suspendWhileSamSignsIn(tab, server);
    resume(tab);
    tab.fe.setOnline(true);
    tab.fe.fire('window', 'online');
    await advance(100);
    await advance(6_000);
    expect(creates(server)).toHaveLength(0);
    expect(tab.s().outboxPrompt).toEqual({ count: 1, savedBy: 'Dana Kim', sendAs: 'Sam Lee' });
    await finish(tab.a.outbox.answerPrompt(true));
    await advance(100);
    expect([...server.rows.values()].find((x) => x.row.clientMutationId === CMID(1))?.row.createdBy).toBe(STAFF.sam.staff);
  });

  it('an outbox retry long after the last check confirms the session first (timers can run before visibilitychange)', async () => {
    const server = new FakeServer([]);
    const tab = boot(server);
    await ready();
    server.override = (req) => (req.path === '/api/requests' ? apiError(503, 'unavailable', 'Try again') : undefined);
    const res = await finish(tab.a.create({ values: values(), clientMutationId: CMID(2), photos: [], photoTiming: 'today' }));
    expect(res.outcome).toBe('queued');
    await advance(5_000); // retry 1 fails (next in 15 s)
    await advance(15_000); // retry 2 fails (next in 60 s)
    expect(creates(server)).toHaveLength(3);
    server.override = null;
    server.session = SAM; // no visibility event reached this tab
    await advance(65_000);
    expect(server.requests('GET', '/api/session').length).toBeGreaterThan(1);
    expect(creates(server)).toHaveLength(3);
    expect(tab.s().outboxPrompt).toEqual({ count: 1, savedBy: 'Dana Kim', sendAs: 'Sam Lee' });
  });

  it('a write right after resume waits for the check and is not sent when the staff changed', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const tab = boot(server);
    await ready();
    suspendWhileSamSignsIn(tab, server);
    resume(tab);
    const res = await finish(tab.a.setStatus(row.id, STATUS.inMedical, 'answer'));
    expect(res).toMatchObject({ ok: false, reason: 'failed', message: COPY.sessionChanged });
    expect(server.requests('POST', `/api/requests/${row.id}/status`)).toHaveLength(0);
    expect(server.row(row.id).status).toBe(STATUS.waiting);
    expect(tab.s().session.staff).toBe(STAFF.sam.staff);
    expect(tab.s().toasts.map((t) => t.title)).toContain(COPY.sessionChanged);
  });

  it('the same staff after resume: one check, then the write goes through', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const tab = boot(server);
    await ready();
    tab.fe.setVisible(false);
    tab.fe.fire('document', 'visibilitychange');
    resume(tab);
    const before = server.log.length;
    const res = await finish(tab.a.setStatus(row.id, STATUS.inMedical, 'answer'));
    expect(res).toMatchObject({ ok: true, changed: true });
    const after = server.log.slice(before).map((r) => `${r.method} ${r.path}`);
    expect(after.slice(0, 2)).toEqual(['GET /api/session', `POST /api/requests/${row.id}/status`]);
  });

  it('a tab stopped by a 401 starts again once a sign-in elsewhere makes the session valid', async () => {
    const server = new FakeServer([makeRow(1)]);
    const tab = boot(server);
    tab.fe.session.setItem('lp-401-at', String(Date.now())); // the redirect-loop guard: this tab stays
    await ready();
    server.session = null;
    await advance(7_000);
    expect(tab.s().session.status).toBe('expired');
    expect(tab.s().toasts.map((t) => t.title)).toContain(COPY.sessionEnded);
    const n = server.requests('GET', '/api/sync').length;
    await advance(30_000);
    expect(server.requests('GET', '/api/sync')).toHaveLength(n);
    server.session = SAM;
    const other = new BroadcastChannel(`${tab.fe.dbName}-channel:lp`);
    other.postMessage({ type: 'signin' });
    other.close();
    await settle(20);
    await advance(100);
    expect(tab.s().session).toMatchObject({ status: 'active', staff: STAFF.sam.staff });
    expect(tab.s().toasts.map((t) => t.title)).not.toContain(COPY.sessionEnded);
    await advance(7_000);
    expect(server.requests('GET', '/api/sync').length).toBeGreaterThan(n);
  });
});

/** Sam signed in in another tab of this phone (the 'signin' announcement). */
function samSignsInElsewhere(tab: Booted, server: FakeServer) {
  server.session = SAM;
  const other = new BroadcastChannel(`${tab.fe.dbName}-channel:lp`);
  other.postMessage({ type: 'signin' });
  other.close();
}

describe('switching to the new staff is one step (regression: nothing in between)', () => {
  it('while the new staff’s cache is still loading, queued jobs and a new create wait, then get the prompt', async () => {
    const server = new FakeServer([]);
    const slowCache = gate();
    const samCursor = K.cursor(canonStaff(STAFF.sam.staff) ?? '');
    const tab = boot(server, {}, (env) => {
      const open = env.openKv;
      env.openKv = () => {
        const kv = open();
        if (!kv) return kv;
        // IndexedDB is slow to read Sam's cache.
        return {
          ...kv,
          get: async <T,>(key: string) => {
            if (key === samCursor) await slowCache.wait();
            return kv.get<T>(key);
          },
        };
      };
    });
    await ready();
    server.override = (req) => (req.path === '/api/requests' ? apiError(503, 'unavailable', 'Try again') : undefined);
    expect((await finish(tab.a.create({ values: values(), clientMutationId: CMID(3), photos: [], photoTiming: 'today' }))).outcome).toBe('queued');
    server.override = null;
    samSignsInElsewhere(tab, server);
    await settle(20);
    await advance(100); // GET /api/session answered Sam; his cache is still loading
    expect(server.requests('GET', '/api/session').length).toBeGreaterThan(1);
    expect(tab.s().session.staff).toBe(STAFF.dana.staff);
    // Meanwhile: back online, a create from the form (the screen still shows Dana), the retry timer.
    tab.fe.fire('window', 'online');
    const second = tab.a.create({ values: values(), clientMutationId: CMID(4), photos: [], photoTiming: 'today' });
    tab.a.syncNow();
    await advance(20_000);
    expect(creates(server)).toHaveLength(1); // only Dana's first, failed attempt
    slowCache.open();
    await settle();
    await advance(100);
    expect((await finish(second)).outcome).toBe('queued');
    expect(tab.s().session.staff).toBe(STAFF.sam.staff);
    expect(tab.s().outboxPrompt).toEqual({ count: 2, savedBy: 'Dana Kim', sendAs: 'Sam Lee' });
    await advance(70_000);
    expect(creates(server)).toHaveLength(1);
  });

  it('a sync begun for the previous staff applies nothing once the data switched: the new staff gets a full fetch', async () => {
    const rows = [makeRow(1), makeRow(2), makeRow(3)];
    const server = new FakeServer(rows);
    server.overlap = 0;
    const tab = boot(server);
    await ready();
    expect(tab.s().confirmed.size).toBe(3);
    server.change(rows[2]!.id, { clothing: 'Blue' });
    const hold = gate();
    server.override = (req) => (req.path === '/api/sync' ? hold.wait() : undefined);
    await advance(6_000); // Dana's delta sync is on its way
    expect(server.requests('GET', '/api/sync').at(-1)?.query.get('since')).not.toBeNull();
    suspendWhileSamSignsIn(tab, server);
    resume(tab);
    // A write confirms the session first: it is Sam's now, so the data switches to him.
    const res = await finish(tab.a.setStatus(rows[0]!.id, STATUS.inMedical, 'answer'));
    expect(res).toMatchObject({ ok: false, message: COPY.sessionChanged });
    expect(tab.s().session.staff).toBe(STAFF.sam.staff);
    const switchedAt = server.log.length;
    server.override = null;
    hold.open(); // Dana's delta arrives only now
    await settle();
    await advance(100);
    const next = server.log.slice(switchedAt).find((r) => r.path === '/api/sync');
    expect(next?.query.get('since')).toBeNull(); // a full fetch for Sam, not Dana's cursor
    expect(tab.s().confirmed.size).toBe(3);
    await advance(6_000);
    expect(tab.s().confirmed.size).toBe(3);
  });

  it('a poll timer that fires long overdue (phone locked) confirms the session before it syncs on', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const tab = boot(server);
    const heard: AlertEvent[] = [];
    tab.store.actions.subscribeAlerts((e) => heard.push(e));
    await ready();
    // Locked for 10 minutes: no timer ran, Sam signed in in another tab, and Dana's request was answered.
    server.session = SAM;
    server.change(mine.id, { status: STATUS.inMedical });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const before = server.log.length;
    await advance(7_000); // the overdue poll timer runs before any visibilitychange
    expect(server.log[before]).toMatchObject({ method: 'GET', path: '/api/session' });
    expect(tab.s().session.staff).toBe(STAFF.sam.staff);
    expect(heard).toEqual([]); // Dana's alert is not raised for Sam
  });
});

// (network fix 1a, 2026-11-08) Open / resume → fresh data in one round trip: GET /api/session goes out WITH the first
// sync page instead of before it, and nothing of that page is applied until the check confirms the session.
describe('the resume / cold-load session check runs alongside the first sync (fix 1a)', () => {
  /** Every request answers after `ms` of fake time; `seen` records [path, started, answered]. */
  function slow(server: FakeServer, ms: (path: string) => number) {
    const seen: Array<{ path: string; at: number; answered: number | null }> = [];
    server.override = async (req) => {
      const rec = { path: req.path, at: Date.now(), answered: null as number | null };
      seen.push(rec);
      await new Promise((r) => setTimeout(r, ms(req.path)));
      rec.answered = Date.now();
      return undefined;
    };
    return seen;
  }

  it('on resume, GET /api/session and GET /api/sync both start before either answers', async () => {
    const server = new FakeServer([makeRow(1)]);
    const tab = boot(server);
    await ready();
    tab.fe.setVisible(false);
    tab.fe.fire('document', 'visibilitychange');
    const seen = slow(server, () => 1_000);
    resume(tab);
    await advance(100);
    const session = seen.find((r) => r.path === '/api/session');
    const sync = seen.find((r) => r.path === '/api/sync');
    expect(session).toBeDefined();
    expect(sync).toBeDefined();
    expect(session?.answered).toBeNull();
    expect(sync?.answered).toBeNull();
    expect(Math.abs((sync?.at ?? 0) - (session?.at ?? 0))).toBeLessThan(50);
  });

  it('a cold load sends both at once too', async () => {
    const server = new FakeServer([makeRow(1)]);
    const seen = slow(server, () => 1_000);
    boot(server);
    await ready();
    await advance(100);
    const session = seen.find((r) => r.path === '/api/session');
    const sync = seen.find((r) => r.path === '/api/sync');
    expect(session?.answered).toBeNull();
    expect(sync?.answered).toBeNull();
    expect(server.requests('GET', '/api/session')).toHaveLength(1);
  });

  it('nothing of the page is applied until the session answers ok', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const tab = boot(server);
    await ready();
    tab.fe.setVisible(false);
    tab.fe.fire('document', 'visibilitychange');
    server.change(row.id, { status: STATUS.inMedical });
    slow(server, (path) => (path === '/api/session' ? 2_000 : 100));
    resume(tab);
    await advance(1_000); // the page has answered, the check has not
    expect(tab.s().confirmed.get(row.id)?.status).toBe(STATUS.waiting);
    expect(tab.s().syncing).toBe(true); // one sync, from poll start to its end, covers the check too
    await advance(1_200);
    expect(tab.s().confirmed.get(row.id)?.status).toBe(STATUS.inMedical);
    expect(tab.s().syncing).toBe(false);
  });

  it('another staff on the cookie: the page is dropped, the store resets and their full fetch starts at once', async () => {
    const danas = makeRow(1, { createdBy: STAFF.dana.staff });
    const sams = makeRow(2, { createdBy: STAFF.sam.staff });
    const server = new FakeServer([danas, sams]);
    const tab = boot(server);
    await ready();
    const mine = () => mineRows([...tab.s().confirmed.values()], tab.s().myIds, tab.s().session.staff).map((r) => r.id);
    suspendWhileSamSignsIn(tab, server);
    const seen = slow(server, (path) => (path === '/api/session' ? 1_000 : 200));
    resume(tab);
    await advance(1_050); // the check answered Sam at 1 000 ms (his cache loads from IndexedDB in real time)
    await advance(10); // the poll that dropped Dana's page schedules Sam's at 0 ms
    expect(tab.s().session.staff).toBe(STAFF.sam.staff);
    const syncs = seen.filter((r) => r.path === '/api/sync');
    expect(syncs).toHaveLength(2);
    // The second is Sam's full fetch, sent the moment the check answered (no backoff, no poll interval).
    expect(syncs[1]!.at - (seen.find((r) => r.path === '/api/session')?.answered ?? 0)).toBeLessThan(50);
    expect(server.log.filter((r) => r.path === '/api/sync').at(-1)?.query.get('since')).toBeNull();
    await advance(300);
    expect(mine()).toEqual([sams.id]);
  });

  it('a 401 from the check runs the expired flow and applies nothing', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const tab = boot(server);
    await ready();
    tab.fe.setVisible(false);
    tab.fe.fire('document', 'visibilitychange');
    server.change(row.id, { status: STATUS.inMedical });
    server.session = null;
    resume(tab);
    await advance(100);
    expect(tab.s().session.status).toBe('expired');
    expect(tab.s().confirmed.get(row.id)?.status).toBe(STATUS.waiting);
    await advance(1_000);
    expect(tab.fe.redirects.at(-1)).toMatch(/^\/signin\?next=/);
  });

  it('the check fails on the network: nothing is applied and the poll backs off', async () => {
    const row = makeRow(1);
    const server = new FakeServer([row]);
    const tab = boot(server);
    await ready();
    tab.fe.setVisible(false);
    tab.fe.fire('document', 'visibilitychange');
    server.change(row.id, { status: STATUS.inMedical });
    server.override = (req) => (req.path === '/api/session' ? 'network' : undefined);
    resume(tab);
    await advance(100);
    expect(tab.s().confirmed.get(row.id)?.status).toBe(STATUS.waiting);
    const syncs = server.requests('GET', '/api/sync').length;
    await advance(5_000); // backoff 6 s: no poll yet
    expect(server.requests('GET', '/api/sync')).toHaveLength(syncs);
    server.override = null;
    await advance(1_100);
    expect(tab.s().confirmed.get(row.id)?.status).toBe(STATUS.inMedical);
  });
});

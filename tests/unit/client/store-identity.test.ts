// Which staff a tab acts as (regression): the cookie is shared by every tab of the phone, so a tab that
// was suspended while someone else signed in must confirm GET /api/session before it syncs on, writes or
// sends queued requests, and switch its per-staff cache, "My requests" and outbox prompt to that staff.
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { mineRows } from '@/lib/client/selectors';
import { COPY } from '@/lib/client/store-core';
import { STATUS } from '@/lib/domain';
import { advance, settle } from './helpers/env';
import { boot, finish, installStoreHooks, ready, values } from './helpers/boot';
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
    const after = server.log.slice(before);
    expect(after[0]).toMatchObject({ method: 'GET', path: '/api/session' });
    expect(tab.s().session).toMatchObject({ status: 'active', staffName: 'Sam Lee', staff: STAFF.sam.staff });
    // The per-staff cache starts clean for Sam (a full fetch), and My requests follow him.
    expect(after.find((r) => r.path === '/api/sync')?.query.get('since')).toBeNull();
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

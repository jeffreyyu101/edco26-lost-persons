// The durable outbox (spec §7 Outbox, A6, A13): every create is a job persisted in IndexedDB before it is
// sent; offline / lie-fi queueing; flush after a reload; needs-attention and resend with the same
// mutationId; photos (checkpoints, definitive rejection, retry); dedupe against confirmed rows; 401 pause;
// the operator prompt; (events) the legacy edc_pending_queue is no longer imported; no IndexedDB → nothing kept in memory.
import { STUB_EVENT } from '@/lib/client/stub-data';
import { describe, expect, it } from 'vitest';
import { openKv, K } from '@/lib/client/persist';
import { COPY } from '@/lib/client/store-core';
import { visibleOutbox } from '@/lib/client/selectors';
import { LEGACY_QUEUE_KEY } from '@/lib/client/constants';
import { toCreateBody } from '@/lib/client/form-values';
import { advance, settle } from './helpers/env';
import { boot, finish, gate, installStoreHooks, photo, ready, values } from './helpers/boot';
import { FakeServer, STAFF, apiError, makeRow, testId } from './helpers/fake-server';

installStoreHooks();

const CMID = (n: number) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const creates = (server: FakeServer) => server.requests('POST', '/api/requests').filter((r) => r.path === '/api/requests');
const photoPosts = (server: FakeServer) => server.requests('POST', '/api/requests/').filter((r) => r.path.endsWith('/photos'));
const rowsWith = (server: FakeServer, cmid: string) => [...server.rows.values()].filter((x) => x.row.clientMutationId === cmid);

async function idbKeys(dbName: string): Promise<string[]> {
  return (await openKv(dbName)?.keys()) ?? [];
}

describe('create online', () => {
  it('persists the job before sending, then "sent", uploads photos and removes the job', async () => {
    const server = new FakeServer([]);
    const { a, s, fe } = boot(server);
    await ready();
    const g = gate();
    server.override = (req) => (req.path === '/api/requests' ? g.wait() : undefined);
    const p = a.create({ values: values(), clientMutationId: CMID(1), photos: [photo('p0000000-0000-4000-8000-000000000001'), photo('p0000000-0000-4000-8000-000000000002')], photoTiming: 'older' });
    await settle(80);
    const keys = await idbKeys(fe.dbName);
    expect(keys).toContain(K.job(CMID(1)));
    expect(keys.filter((k) => k.startsWith('blob:'))).toHaveLength(2);
    expect(creates(server)).toHaveLength(1);
    g.open();
    server.override = null;
    const res = await finish(p);
    expect(res.outcome).toBe('sent');
    const id = res.outcome === 'sent' ? res.request.id : '';
    expect(s().toasts.map((t) => t.title)).toContain(`${res.outcome === 'sent' ? 'LP-2001' : ''} saved`);
    expect(s().myIds.has(id)).toBe(true);
    await advance(100);
    expect(photoPosts(server)).toHaveLength(2);
    expect(photoPosts(server).map((r) => r.form?.get('timing'))).toEqual(['older', 'older']);
    expect(server.row(id).photoCount).toBe(2);
    expect(s().outbox).toHaveLength(0);
    const after = await idbKeys(fe.dbName);
    expect(after.some((k) => k.startsWith('outbox:') || k.startsWith('blob:'))).toBe(false);
    expect(creates(server)[0]?.body).toEqual(toCreateBody(values(), CMID(1)));
  });

  it('a second create with the same id after it was confirmed does not send again', async () => {
    const server = new FakeServer([]);
    const { a } = boot(server);
    await ready();
    await finish(a.create({ values: values(), clientMutationId: CMID(2), photos: [], photoTiming: 'today' }));
    const again = await finish(a.create({ values: values(), clientMutationId: CMID(2), photos: [], photoTiming: 'today' }));
    expect(again.outcome).toBe('sent');
    expect(creates(server)).toHaveLength(1);
  });
});

describe('queued creates', () => {
  it('offline: saved on this phone first, shown as waiting, flushed once back online (exactly one row)', async () => {
    const server = new FakeServer([]);
    const { a, s, fe } = boot(server);
    await ready();
    fe.setOnline(false);
    fe.fire('window', 'offline');
    const res = await finish(a.create({ values: values(), clientMutationId: CMID(3), photos: [photo('p0000000-0000-4000-8000-000000000003')], photoTiming: 'today' }));
    expect(res).toEqual({ outcome: 'queued', mutationId: CMID(3) });
    expect(creates(server)).toHaveLength(0);
    expect(s().toasts.find((t) => t.title === COPY.savedHere)?.subtitle).toBe(COPY.sendsLater);
    expect(visibleOutbox(s().outbox, s().confirmed).map((j) => j.mutationId)).toEqual([CMID(3)]);
    expect(await idbKeys(fe.dbName)).toContain(K.job(CMID(3)));
    fe.setOnline(true);
    fe.fire('window', 'online');
    await advance(100);
    await advance(100);
    expect(rowsWith(server, CMID(3))).toHaveLength(1);
    expect(photoPosts(server)).toHaveLength(1);
    expect(s().outbox).toHaveLength(0);
    expect(s().toasts.map((t) => t.title)).toContain('LP-2001 saved');
  });

  it('lie-fi: a create that hangs queues after 10 s and is retried with the same mutationId', async () => {
    const server = new FakeServer([]);
    const { a, s } = boot(server);
    await ready();
    let hung = false;
    server.override = (req) => {
      if (req.path === '/api/requests' && !hung) {
        hung = true;
        return 'hang';
      }
      return undefined;
    };
    const res = await finish(a.create({ values: values(), clientMutationId: CMID(4), photos: [], photoTiming: 'today' }), 10_000);
    expect(res.outcome).toBe('queued');
    expect(s().outbox[0]).toMatchObject({ attempts: 1, state: 'pending', lastError: { code: 'timeout' } });
    await advance(5_000);
    await advance(100);
    expect(creates(server).map((r) => (r.body as { clientMutationId: string }).clientMutationId)).toEqual([CMID(4), CMID(4)]);
    expect(rowsWith(server, CMID(4))).toHaveLength(1);
    expect(s().outbox).toHaveLength(0);
  });

  it('backs off 5 s, 15 s, 60 s, then every 2 min while the server is down', async () => {
    const server = new FakeServer([]);
    const { a, fe } = boot(server);
    await ready();
    fe.setOnline(false);
    await finish(a.create({ values: values(), clientMutationId: CMID(5), photos: [], photoTiming: 'today' }));
    server.override = (req) => (req.path === '/api/requests' ? apiError(503, 'unavailable', 'Try again') : undefined);
    fe.setOnline(true);
    fe.fire('window', 'online');
    await advance(50);
    const times = () => creates(server).length;
    expect(times()).toBe(1);
    await advance(4_900);
    expect(times()).toBe(1);
    await advance(200);
    expect(times()).toBe(2);
    await advance(15_000);
    expect(times()).toBe(3);
    await advance(60_000);
    expect(times()).toBe(4);
    await advance(120_000);
    expect(times()).toBe(5);
  });

  it('survives a reload: a new store on the same database sends the queued job', async () => {
    const server = new FakeServer([]);
    const first = boot(server);
    await ready();
    first.fe.setOnline(false);
    await finish(first.a.create({ values: values(), clientMutationId: CMID(6), photos: [photo('p0000000-0000-4000-8000-000000000006')], photoTiming: 'older' }));
    first.stop();
    await settle();
    const second = boot(server, { dbName: first.fe.dbName });
    await ready();
    await advance(100);
    expect(rowsWith(server, CMID(6))).toHaveLength(1);
    expect(photoPosts(server)[0]?.form?.get('timing')).toBe('older');
    expect(second.s().outbox).toHaveLength(0);
  });
});

describe('needs attention', () => {
  it('a definitive 4xx keeps the job with the field; it never blocks the queue; update + resend reuses the id', async () => {
    const server = new FakeServer([]);
    const { a, s, fe } = boot(server);
    await ready();
    fe.setOnline(false);
    await finish(a.create({ values: values({ reportingLocation: 'Other', otherLocation: 'x' }), clientMutationId: CMID(7), photos: [], photoTiming: 'today' }));
    await advance(10);
    await finish(a.create({ values: values(), clientMutationId: CMID(8), photos: [], photoTiming: 'today' }));
    server.override = (req) =>
      req.path === '/api/requests' && (req.body as { clientMutationId: string }).clientMutationId === CMID(7)
        ? apiError(422, 'invalid', 'Say where (Other post)', { field: 'otherLocation' })
        : undefined;
    fe.setOnline(true);
    fe.fire('window', 'online');
    await advance(100);
    const stuck = s().outbox.find((j) => j.mutationId === CMID(7));
    expect(stuck).toMatchObject({ state: 'needs_attention', lastError: { code: 'invalid', status: 422, field: 'otherLocation', message: 'Say where (Other post)' } });
    expect(rowsWith(server, CMID(8))).toHaveLength(1);
    expect(s().toasts.map((t) => t.title)).toContain(COPY.needsAttention);
    // The editor fixes it and resends with the same mutationId.
    server.override = null;
    await finish(a.outbox.update(CMID(7), toCreateBody(values({ reportingLocation: 'Other', otherLocation: 'Gate 2' }), CMID(7))));
    a.outbox.resend(CMID(7));
    await advance(100);
    expect(rowsWith(server, CMID(7))).toHaveLength(1);
    expect(rowsWith(server, CMID(7))[0]?.row.otherLocation).toBe('Gate 2');
    expect(s().outbox).toHaveLength(0);
  });

  it('create() reports needs_attention directly when online', async () => {
    const server = new FakeServer([]);
    const { a, s } = boot(server);
    await ready();
    server.override = (req) => (req.path === '/api/requests' ? apiError(422, 'invalid', 'Too long', { field: 'clothing' }) : undefined);
    const res = await finish(a.create({ values: values(), clientMutationId: CMID(9), photos: [], photoTiming: 'today' }));
    expect(res).toEqual({ outcome: 'needs_attention', mutationId: CMID(9), message: 'Too long' });
    expect(s().outbox[0]?.lastError?.field).toBe('clothing');
  });

  it('discard removes the job and its photo bytes', async () => {
    const server = new FakeServer([]);
    const { a, s, fe } = boot(server);
    await ready();
    fe.setOnline(false);
    await finish(a.create({ values: values(), clientMutationId: CMID(10), photos: [photo('p0000000-0000-4000-8000-000000000010')], photoTiming: 'today' }));
    await finish(a.outbox.discard(CMID(10)));
    expect(s().outbox).toHaveLength(0);
    const keys = await idbKeys(fe.dbName);
    expect(keys.some((k) => k.startsWith('outbox:') || k.startsWith('blob:'))).toBe(false);
  });
});

describe('photos', () => {
  it('a definitive photo rejection finishes the job with a toast; the request stays', async () => {
    const server = new FakeServer([]);
    const { a, s } = boot(server);
    await ready();
    server.override = (req) => (req.path.endsWith('/photos') ? apiError(422, 'photo_limit', 'Three photos at most') : undefined);
    const res = await finish(a.create({ values: values(), clientMutationId: CMID(11), photos: [photo('p0000000-0000-4000-8000-000000000011')], photoTiming: 'today' }));
    expect(res.outcome).toBe('sent');
    await advance(100);
    expect(s().outbox).toHaveLength(0);
    expect(s().toasts.map((t) => t.title)).toContain('LP-2001 · photo not added');
    expect(rowsWith(server, CMID(11))).toHaveLength(1);
  });

  it('an uncertain photo failure keeps the job (checkpointed serverId), offers Retry, and resends the same photoId', async () => {
    const server = new FakeServer([]);
    const { a, s, fe } = boot(server);
    await ready();
    let fails = 1;
    server.override = (req) => (req.path.endsWith('/photos') && fails-- > 0 ? 'network' : undefined);
    await finish(a.create({ values: values(), clientMutationId: CMID(12), photos: [photo('p0000000-0000-4000-8000-000000000012')], photoTiming: 'today' }));
    await advance(100);
    const job = s().outbox[0];
    expect(job?.serverId).toBeTruthy();
    expect(job?.photos[0]?.acked).toBe(false);
    const stored = await openKv(fe.dbName)?.get<{ serverId: string | null }>(K.job(CMID(12)));
    expect(stored?.serverId).toBe(job?.serverId);
    const retry = s().toasts.find((t) => t.action?.label === 'Retry');
    expect(retry?.title).toBe('LP-2001 · photo not sent yet');
    retry?.action?.run();
    await advance(100);
    expect(photoPosts(server).map((r) => r.form?.get('photoId'))).toEqual(['p0000000-0000-4000-8000-000000000012', 'p0000000-0000-4000-8000-000000000012']);
    expect(creates(server)).toHaveLength(1);
    expect(s().outbox).toHaveLength(0);
  });
});

describe('dedupe and pause', () => {
  it('A6: a job whose request is already confirmed is hidden and only its photos are sent', async () => {
    // The create reached the server but the answer was lost.
    const server = new FakeServer([]);
    const { a, s, fe } = boot(server);
    await ready();
    fe.setOnline(false);
    await finish(a.create({ values: values(), clientMutationId: CMID(13), photos: [photo('p0000000-0000-4000-8000-000000000013')], photoTiming: 'today' }));
    server.put(makeRow(13, { clientMutationId: CMID(13), createdBy: STAFF.dana.staff }));
    // Back online: the worker's create attempt fails (backoff 5 s) while the sync brings the row.
    server.override = (req) => (req.path === '/api/requests' ? 'network' : undefined);
    fe.setOnline(true);
    fe.fire('window', 'online');
    await advance(100);
    expect(creates(server)).toHaveLength(1);
    expect(s().confirmed.has(testId(13))).toBe(true);
    expect(visibleOutbox(s().outbox, s().confirmed)).toEqual([]);
    server.override = null;
    await advance(5_000);
    await advance(100);
    expect(creates(server)).toHaveLength(1); // no second create: it continued against the confirmed row
    expect(photoPosts(server).at(-1)?.path).toBe(`/api/requests/${testId(13)}/photos`);
    expect(s().outbox).toHaveLength(0);
  });

  it('a 401 pauses the outbox and keeps the job; nothing is lost', async () => {
    const server = new FakeServer([]);
    const { a, s, fe } = boot(server);
    await ready();
    server.session = null;
    const res = await finish(a.create({ values: values(), clientMutationId: CMID(14), photos: [], photoTiming: 'today' }));
    expect(res.outcome).toBe('queued');
    expect(s().session.status).toBe('expired');
    await advance(1_000);
    expect(fe.redirects[0]).toMatch(/^\/signin\?next=/);
    await advance(300_000);
    expect(creates(server)).toHaveLength(1);
    expect(await idbKeys(fe.dbName)).toContain(K.job(CMID(14)));
  });
});

describe('operator prompt (A13)', () => {
  async function queuedByDana() {
    const server = new FakeServer([]);
    const first = boot(server);
    await ready();
    first.fe.setOnline(false);
    await finish(first.a.create({ values: values(), clientMutationId: CMID(15), photos: [], photoTiming: 'today' }));
    await finish(first.a.create({ values: values(), clientMutationId: CMID(16), photos: [], photoTiming: 'today' }));
    first.stop();
    await settle();
    server.session = { ...STAFF.sam, role: 'staff', eventId: STUB_EVENT.id, event: STUB_EVENT, expiresAt: '2026-11-07T15:00:00.000000+00:00' };
    const second = boot(server, { dbName: first.fe.dbName });
    await ready();
    await advance(100);
    return { server, second };
  }

  it('asks "Send 2 requests saved by Dana Kim?" and sends nothing until answered; Send sends as Sam', async () => {
    const { server, second } = await queuedByDana();
    expect(second.s().outboxPrompt).toEqual({ count: 2, savedBy: 'Dana Kim', sendAs: 'Sam Lee' });
    expect(creates(server)).toHaveLength(0);
    await finish(second.a.outbox.answerPrompt(true));
    await advance(100);
    expect(second.s().outboxPrompt).toBeNull();
    expect(rowsWith(server, CMID(15))).toHaveLength(1);
    expect(rowsWith(server, CMID(16))[0]?.row.createdBy).toBe(STAFF.sam.staff);
    expect(second.s().outbox).toHaveLength(0);
  });

  it('Discard removes them', async () => {
    const { server, second } = await queuedByDana();
    await finish(second.a.outbox.answerPrompt(false));
    await advance(100);
    expect(second.s().outbox).toHaveLength(0);
    expect(second.s().outboxPrompt).toBeNull();
    expect(creates(server)).toHaveLength(0);
  });
});

describe('legacy queue (events: no longer imported)', () => {
  it("leaves Jeffrey's edc_pending_queue as it is: it predates events, so it belongs to no event and is never imported or sent", async () => {
    const server = new FakeServer([]);
    const legacy = [{ client_mutation_id: CMID(17), first_name: 'Lena', last_name: 'O.', age: 18, gender: 'Female', reporting_location: 'FA 3 – Kinetic', clothing: 'Pink hat' }];
    const { s, fe } = boot(server, {}, (env) => {
      env.localStorage()?.setItem(LEGACY_QUEUE_KEY, JSON.stringify(legacy));
    });
    await ready();
    await advance(100);
    expect(fe.local.getItem(LEGACY_QUEUE_KEY)).toBe(JSON.stringify(legacy));
    expect(rowsWith(server, CMID(17))).toHaveLength(0);
    expect(creates(server)).toHaveLength(0);
    expect(s().outbox).toHaveLength(0);
  });
});

describe('no IndexedDB', () => {
  it('offline save is disabled: not_saved, never kept in memory only', async () => {
    const server = new FakeServer([]);
    const { a, s, fe } = boot(server, {}, (env) => {
      env.openKv = () => null;
    });
    await ready();
    expect(s().durableStorage).toBe(false);
    fe.setOnline(false);
    const res = await finish(a.create({ values: values(), clientMutationId: CMID(18), photos: [], photoTiming: 'today' }));
    expect(res.outcome).toBe('not_saved');
    expect(s().outbox).toHaveLength(0);
    fe.setOnline(true);
    const sent = await finish(a.create({ values: values(), clientMutationId: CMID(18), photos: [], photoTiming: 'today' }));
    expect(sent.outcome).toBe('sent');
  });
});

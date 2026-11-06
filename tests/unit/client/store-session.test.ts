// Logout boundary (A14), alerts through the store (baseline, someone else's change, own mutations, bell,
// bursts) and drafts (A20). Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import { openKv, K } from '@/lib/client/persist';
import { COPY } from '@/lib/client/store-core';
import type { AlertEvent } from '@/lib/client/store-contract';
import { STATUS } from '@/lib/domain';
import { advance, settle } from './helpers/env';
import { boot, finish, gate, installStoreHooks, photo, ready, values } from './helpers/boot';
import { FakeServer, STAFF, makeRow } from './helpers/fake-server';

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
    expect(heard.map((e) => e.title)).toEqual(['LP-1004 · S.L. is in medical']);
    const toast = s().toasts.find((t) => t.title === 'LP-1004 · S.L. is in medical');
    expect(toast).toMatchObject({ subtitle: 'Bring the friend to Main Med', tone: 'green', durationMs: null, action: { label: 'View' } });
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
    expect(s().toasts.some((t) => t.title.includes('is in medical'))).toBe(false);
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

// (Events, phase 2) The real store across events: the config from GET /api/session (and again when sync's ?ev= says
// it moved), one browser profile used for two events (no cached row, queued create, queued message or draft crosses),
// practice → live dropping the event's cache and practice creates, and the Ended flow (a 410 event_ended from a poll,
// a write or the session check signs out, drops the event's data silently and opens /signin?ended=1).
import { describe, expect, it } from 'vitest';
import type { EventConfig, SessionInfo } from '@/lib/api-types';
import { interpretSignInResponse } from '@/components/signin/logic';
import { DROP_KEY, ENDED_KEY, ENDED_PATH, endedAtSignIn } from '@/lib/client/ended';
import { K, openKv } from '@/lib/client/persist';
import { STUB_EVENT } from '@/lib/client/stub-data';
import { advance, settle } from './helpers/env';
import { boot, finish, installStoreHooks, ready, values } from './helpers/boot';
import { FakeServer, STAFF, apiError, makeRow, testId } from './helpers/fake-server';
import { STATUS } from '@/lib/domain';

installStoreHooks();

const A: EventConfig = { ...STUB_EVENT, id: 'a0000000-0000-4000-8000-00000000000a', slug: 'event-a', name: 'Event A', wentLiveAt: null, stage: 'practice' };
const B: EventConfig = {
  ...STUB_EVENT,
  id: 'b0000000-0000-4000-8000-00000000000b',
  slug: 'event-b',
  name: 'Event B',
  timezone: 'Europe/Berlin',
  dayStartHour: 9,
  posts: [{ id: 'north', label: 'North Gate', short: 'North' }],
  teams: [{ id: 'crew', label: 'Crew', short: 'Crew', medical: false }, { id: 'aid', label: 'First Aid', short: 'Aid', medical: true }],
  mainMedical: 'Aid Tent',
  lastSeen: ['Main stage'],
};
const sessionOf = (event: EventConfig, staff = STAFF.dana): SessionInfo => ({ ...staff, role: 'staff', eventId: event.id, event, expiresAt: '2026-11-07T15:00:00.000000+00:00' });
const CMID = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const creates = (server: FakeServer) => server.requests('POST', '/api/requests').filter((r) => r.path === '/api/requests');

describe('the event config', () => {
  it('comes from GET /api/session: role, event, its time zone', async () => {
    const server = new FakeServer([makeRow(1)]);
    server.session = sessionOf(B);
    const { s } = boot(server);
    await ready();
    expect(s().role).toBe('staff');
    expect(s().event?.id).toBe(B.id);
    expect(s().event?.posts.map((p) => p.label)).toEqual(['North Gate']);
    expect(s().eventTimezone).toBe('Europe/Berlin');
  });

  it('is read again when sync says its version moved (?ev=), not otherwise', async () => {
    const server = new FakeServer([makeRow(1)]);
    server.session = sessionOf(A);
    const { s } = boot(server);
    await ready();
    const sessionReads = () => server.requests('GET', '/api/session').length;
    const before = sessionReads();
    await advance(7_000);
    expect(server.requests('GET', '/api/sync').at(-1)?.query.get('ev')).toBe(A.updatedAt);
    expect(sessionReads()).toBe(before);
    // A lead renamed the event: its version moved.
    server.session = sessionOf({ ...A, name: 'Event A (renamed)', updatedAt: '2026-11-07T04:00:00.000000+00:00' });
    await advance(7_000);
    await settle();
    expect(sessionReads()).toBeGreaterThan(before);
    expect(s().event?.name).toBe('Event A (renamed)');
  });
});

describe('one browser profile, two events', () => {
  it("never shows event A's cached rows in B, nor sends A's queued create, message or draft there; back in A they are still A's", async () => {
    // Event A: one row cached, one create queued offline, a draft started.
    const serverA = new FakeServer([makeRow(1, { name: 'A row' })]);
    serverA.session = sessionOf(A);
    const tabA = boot(serverA);
    await ready();
    await advance(3_500);
    expect(tabA.s().confirmed.size).toBe(1);
    tabA.fe.setOnline(false);
    const queued = await finish(tabA.a.create({ values: values({ name: 'Queued in A' }), clientMutationId: CMID(1), photos: [], photoTiming: 'today' }));
    expect(queued.outcome).toBe('queued');
    tabA.a.draft.save({ clientMutationId: CMID(2), values: values({ name: 'Draft in A' }), photos: [], photoTiming: 'today', updatedAt: 1 });
    await finish(tabA.a.draft.flush());
    tabA.stop();
    await settle();

    // The same phone signs in to event B (another password): B's server has its own row.
    const serverB = new FakeServer([makeRow(2, { name: 'B row' })]);
    serverB.session = sessionOf(B);
    const tabB = boot(serverB, { dbName: tabA.fe.dbName, local: tabA.fe.local });
    await ready();
    await advance(3_500);
    expect([...tabB.s().confirmed.values()].map((r) => r.name)).toEqual(['B row']);
    expect(tabB.s().outbox).toHaveLength(0);
    expect(creates(serverB)).toHaveLength(0);
    expect(await finish(tabB.a.draft.load())).toBeNull();
    // A's data is still on the phone, under A.
    const kv = openKv(tabA.fe.dbName)!;
    expect((await kv.keys()).filter((k) => k.startsWith(`cache:${A.id}:`)).length).toBeGreaterThan(0);
    expect(await kv.get(`outbox:${CMID(1)}`)).toMatchObject({ eventId: A.id });
    tabB.stop();
    await settle();

    // Back in A (online): A's queued create goes to A, and only there.
    serverA.session = sessionOf(A);
    const tabA2 = boot(serverA, { dbName: tabA.fe.dbName, local: tabA.fe.local });
    await ready();
    await advance(6_000);
    expect(creates(serverA).map((r) => (r.body as { clientMutationId: string }).clientMutationId)).toContain(CMID(1));
    expect(creates(serverB)).toHaveLength(0);
    expect((await finish(tabA2.a.draft.load()))?.clientMutationId).toBe(CMID(2));
  });
});

describe('signing in to another event', () => {
  it("the app never flashes the previous event's cached rows while GET /api/session is on its way", async () => {
    const serverA = new FakeServer([makeRow(1, { name: 'A row' })]);
    serverA.session = sessionOf(A);
    const tabA = boot(serverA);
    await ready();
    await advance(3_500);
    tabA.stop();
    await settle();
    // The sign-in screen marks the event it opened (lib/client/signed-in-at.ts) before it opens the app.
    tabA.fe.local.setItem('lp-signin-event', B.id);
    const serverB = new FakeServer([makeRow(2, { name: 'B row' })]);
    serverB.session = sessionOf(B);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    serverB.override = async (req) => (req.path === '/api/session' ? (await held, undefined) : undefined);
    const tabB = boot(serverB, { dbName: tabA.fe.dbName, local: tabA.fe.local });
    await settle();
    await advance(50);
    expect(tabB.s().hydrated).toBe(true);
    expect([...tabB.s().confirmed.values()].map((r) => r.name)).not.toContain('A row');
    release();
    await advance(3_500);
    expect([...tabB.s().confirmed.values()].map((r) => r.name)).toEqual(['B row']);
    expect(tabB.fe.local.getItem('lp-signin-event')).toBeNull();
  });
});

describe('practice → live', () => {
  it("drops the event's cache (practice rows the delta would never remove) and its practice creates, then syncs in full", async () => {
    const server = new FakeServer([makeRow(1, { name: 'Practice row' })]);
    server.session = sessionOf(A);
    const tab = boot(server);
    await ready();
    await advance(3_500);
    expect(tab.s().confirmed.size).toBe(1);
    tab.fe.setOnline(false);
    await finish(tab.a.create({ values: values({ name: 'Practice create' }), clientMutationId: CMID(3), photos: [], photoTiming: 'today' }));
    expect(tab.s().outbox).toHaveLength(1);
    // Go live on the server: practice rows deleted, numbering restarted, the config's version and wentLiveAt move.
    server.rows.clear();
    server.put(makeRow(5, { name: 'Live row' }));
    server.session = sessionOf({ ...A, stage: 'live', wentLiveAt: '2026-11-07T05:00:00Z', updatedAt: '2026-11-07T05:00:00.000000+00:00' });
    tab.fe.setOnline(true);
    tab.fe.fire('window', 'online');
    await advance(8_000);
    await settle();
    await advance(8_000);
    expect(tab.s().event?.stage).toBe('live');
    expect([...tab.s().confirmed.values()].map((r) => r.name)).toEqual(['Live row']);
    expect(tab.s().outbox).toHaveLength(0);
    expect(creates(server)).toHaveLength(0);
    const kv = openKv(tab.fe.dbName)!;
    expect(await kv.get(`outbox:${CMID(3)}`)).toBeUndefined();
    const rows = await kv.get<Array<{ name: string }>>(K.rows(A.id, 'dana kim · gc/hx - dispatch'));
    expect((rows ?? []).map((r) => r.name)).not.toContain('Practice row');
  });
});

describe('the Ended flow (410 event_ended)', () => {
  const ENDED = { name: 'Event A', logoUrl: null, stage: 'archived' as const };

  async function endedAfter(trigger: (tab: ReturnType<typeof boot>, server: FakeServer) => Promise<void>) {
    const server = new FakeServer([makeRow(1)]);
    server.session = sessionOf(A);
    const tab = boot(server);
    await ready();
    await advance(3_500);
    // Unsent work on the phone: a queued create (offline) and a draft.
    tab.fe.setOnline(false);
    await finish(tab.a.create({ values: values(), clientMutationId: CMID(4), photos: [], photoTiming: 'today' }));
    tab.a.draft.save({ clientMutationId: CMID(5), values: values(), photos: [], photoTiming: 'today', updatedAt: 1 });
    await finish(tab.a.draft.flush());
    tab.fe.setOnline(true);
    server.ended = { ...ENDED, id: A.id };
    await trigger(tab, server);
    await advance(2_000);
    await settle();
    return { server, tab };
  }

  async function expectEnded(server: FakeServer, tab: ReturnType<typeof boot>) {
    expect(tab.fe.redirects.at(-1)).toBe(ENDED_PATH);
    // Signed out (DELETE /api/session, which still answers after the end).
    expect(server.requests('DELETE', '/api/session').length).toBeGreaterThanOrEqual(1);
    expect(server.session).toBeNull();
    expect(tab.s().session.status).toBe('signed_out');
    // The event's data left the phone; queued work failed for good, with no toast and no retry.
    const kv = openKv(tab.fe.dbName)!;
    const keys = await kv.keys();
    expect(keys.filter((k) => k.startsWith(`cache:${A.id}:`))).toEqual([]);
    expect(keys.filter((k) => k.startsWith('outbox:'))).toEqual([]);
    expect(keys).not.toContain(K.draft);
    expect(tab.s().outbox).toHaveLength(0);
    expect(tab.s().toasts).toHaveLength(0);
    const sent = creates(server).length;
    await advance(130_000);
    expect(creates(server).length).toBe(sent);
    // What the Ended screen shows.
    expect(JSON.parse(tab.fe.session.getItem(ENDED_KEY) ?? 'null')).toMatchObject({ name: 'Event A', id: A.id });
  }

  it('from a background poll', async () => {
    const { server, tab } = await endedAfter(async () => {
      await advance(7_000);
    });
    await expectEnded(server, tab);
  });

  it('from a write (a status tap)', async () => {
    const { server, tab } = await endedAfter(async (t) => {
      await finish(t.a.setStatus(testId(1), STATUS.inMedical, 'answer'));
    });
    await expectEnded(server, tab);
    expect(tab.s().toasts.map((x) => x.title)).not.toContain('Only the person who logged it can do that');
  });

  it('from the session check (a reload: GET /api/session answers 410)', async () => {
    const server = new FakeServer([makeRow(1)]);
    server.session = sessionOf(A);
    server.ended = { ...ENDED, id: A.id };
    const tab = boot(server);
    await ready();
    await advance(2_000);
    await settle();
    expect(tab.fe.redirects.at(-1)).toBe(ENDED_PATH);
    expect(server.session).toBeNull();
  });

  it('a lead reading an archived event is not signed out: the write fails with "Event archived"', async () => {
    const server = new FakeServer([makeRow(1)]);
    server.session = { ...sessionOf({ ...A, stage: 'archived' }), role: 'lead' };
    const tab = boot(server);
    await ready();
    // A lead keeps reading an archived event; only writes answer 410.
    server.override = (req) => (req.method === 'GET' ? undefined : apiError(410, 'event_ended', 'This event has ended', { event: ENDED }));
    const res = await finish(tab.a.setStatus(testId(1), STATUS.inMedical, 'answer'));
    expect(res.ok).toBe(false);
    expect(tab.s().toasts.map((t) => t.title)).toContain('Event archived');
    expect(tab.fe.redirects).not.toContain(ENDED_PATH);
    expect(server.session).not.toBeNull();
  });
});

describe('the Ended answer at sign-in (a phone whose session had expired)', () => {
  it("keeps the event's id, so the app's next start drops that event's cache and outbox", async () => {
    // Event A on this phone: a cached row and a create queued offline.
    const server = new FakeServer([makeRow(1, { name: 'A row' })]);
    server.session = sessionOf(A);
    const tab = boot(server);
    await ready();
    await advance(3_500);
    tab.fe.setOnline(false);
    await finish(tab.a.create({ values: values(), clientMutationId: CMID(6), photos: [], photoTiming: 'today' }));
    tab.stop();
    await settle();
    const kv = openKv(tab.fe.dbName)!;
    expect((await kv.keys()).filter((k) => k.startsWith(`cache:${A.id}:`)).length).toBeGreaterThan(0);
    expect(await kv.get(`outbox:${CMID(6)}`)).toMatchObject({ eventId: A.id });

    // /signin: A's password answers 410 event_ended with the event (lib/server/events.ts endedEvent); SignInFlow's
    // onEnded hands the outcome's event to endedAtSignIn.
    const outcome = interpretSignInResponse(410, { error: { code: 'event_ended', message: 'x', event: { id: A.id, name: 'Event A', logoUrl: null, stage: 'archived' } } }, null, 0);
    expect(outcome).toEqual({ kind: 'ended', event: { id: A.id, name: 'Event A', logoUrl: null, stage: 'archived' } });
    endedAtSignIn(outcome.kind === 'ended' ? outcome.event : null, { session: tab.fe.session, local: tab.fe.local });
    expect(JSON.parse(tab.fe.local.getItem(DROP_KEY) ?? '[]')).toEqual([A.id]);

    // The app's next start (signed in to event B): A's data goes first.
    const serverB = new FakeServer([makeRow(2, { name: 'B row' })]);
    serverB.session = sessionOf(B);
    boot(serverB, { dbName: tab.fe.dbName, local: tab.fe.local });
    await ready();
    await advance(3_500);
    const keys = await kv.keys();
    expect(keys.filter((k) => k.startsWith(`cache:${A.id}:`))).toEqual([]);
    expect(keys.filter((k) => k.startsWith('outbox:'))).toEqual([]);
    expect(tab.fe.local.getItem(DROP_KEY)).toBeNull();
    expect(creates(serverB)).toHaveLength(0);
  });
});

describe('the lifecycle chunk fails to load', () => {
  const lostChunk = () => Promise.reject(new Error('ChunkLoadError: Loading chunk failed'));

  it("Ended: the drop marker is written first, so the next start drops the event's cache and outbox", async () => {
    const server = new FakeServer([makeRow(1)]);
    server.session = sessionOf({ ...A, stage: 'live', wentLiveAt: '2026-11-07T05:00:00Z' });
    const tab = boot(server, { loadLifecycle: lostChunk });
    await ready();
    await advance(3_500);
    tab.fe.setOnline(false);
    await finish(tab.a.create({ values: values(), clientMutationId: CMID(7), photos: [], photoTiming: 'today' }));
    tab.fe.setOnline(true);
    server.ended = { name: 'Event A', logoUrl: null, stage: 'archived', id: A.id };
    await advance(7_000);
    await advance(2_000);
    await settle();
    expect(tab.fe.redirects.at(-1)).toBe(ENDED_PATH);
    expect(server.session).toBeNull();
    // Nothing could be dropped (no chunk), but the event is marked and nothing more is sent.
    expect(JSON.parse(tab.fe.local.getItem(DROP_KEY) ?? '[]')).toEqual([A.id]);
    const kv = openKv(tab.fe.dbName)!;
    expect(await kv.get(`outbox:${CMID(7)}`)).toBeDefined();
    tab.stop();
    await settle();

    // The next start (the chunk loads): the marked event's data goes, and the mark with it.
    const serverB = new FakeServer([makeRow(2)]);
    serverB.session = sessionOf(B);
    boot(serverB, { dbName: tab.fe.dbName, local: tab.fe.local });
    await ready();
    await advance(3_500);
    const keys = await kv.keys();
    expect(keys.filter((k) => k.startsWith(`cache:${A.id}:`))).toEqual([]);
    expect(keys.filter((k) => k.startsWith('outbox:'))).toEqual([]);
    expect(tab.fe.local.getItem(DROP_KEY)).toBeNull();
  });

  it("go-live: a create saved in practice is never sent live; the next start still drops the practice rows", async () => {
    const server = new FakeServer([makeRow(1, { name: 'Practice row' })]);
    server.session = sessionOf(A);
    const tab = boot(server, { loadLifecycle: lostChunk });
    await ready();
    await advance(3_500);
    expect([...tab.s().confirmed.values()].map((r) => r.name)).toEqual(['Practice row']);
    tab.fe.setOnline(false);
    await finish(tab.a.create({ values: values({ name: 'Practice create' }), clientMutationId: CMID(8), photos: [], photoTiming: 'today' }));
    expect(tab.s().outbox).toHaveLength(1);
    // Go live on the server.
    server.rows.clear();
    server.put(makeRow(5, { name: 'Live row' }));
    const live = { ...A, stage: 'live' as const, wentLiveAt: '2026-11-07T05:00:00Z', updatedAt: '2026-11-07T05:00:00.000000+00:00' };
    server.session = sessionOf(live);
    tab.fe.setOnline(true);
    tab.fe.fire('window', 'online');
    await advance(8_000);
    await settle();
    await advance(8_000);
    expect(tab.s().event?.stage).toBe('live');
    expect(creates(server)).toHaveLength(0);
    expect(tab.s().outbox).toHaveLength(0);
    const kv = openKv(tab.fe.dbName)!;
    expect(await kv.get(`outbox:${CMID(8)}`)).toBeUndefined();
    tab.stop();
    await settle();

    // The next start, with the chunk: the go-live check sees the go-live (the practice moment was recorded without
    // the chunk), drops the practice rows and syncs in full.
    const tab2 = boot(server, { dbName: tab.fe.dbName, local: tab.fe.local });
    await ready();
    await advance(8_000);
    await settle();
    await advance(8_000);
    expect([...tab2.s().confirmed.values()].map((r) => r.name)).toEqual(['Live row']);
    expect(creates(server)).toHaveLength(0);
  });
});

describe('a lead whose queued create meets an ended event (410 event_ended)', () => {
  it('stops retrying at once: Needs attention, one POST, no backoff loop', async () => {
    const server = new FakeServer([makeRow(1)]);
    server.session = { ...sessionOf({ ...A, stage: 'live', wentLiveAt: '2026-11-07T05:00:00Z' }), role: 'lead' };
    const tab = boot(server);
    await ready();
    await advance(3_500);
    tab.fe.setOnline(false);
    await finish(tab.a.create({ values: values(), clientMutationId: CMID(9), photos: [], photoTiming: 'today' }));
    server.override = (req) => (req.method === 'POST' && req.path === '/api/requests' ? apiError(410, 'event_ended', 'This event is now closed', { event: { id: A.id, name: 'Event A', logoUrl: null, stage: 'archived' } }) : undefined);
    tab.fe.setOnline(true);
    tab.fe.fire('window', 'online');
    await advance(8_000);
    await settle();
    expect(creates(server)).toHaveLength(1);
    expect(tab.s().outbox.find((j) => j.mutationId === CMID(9))?.state).toBe('needs_attention');
    await advance(300_000);
    expect(creates(server)).toHaveLength(1);
    // A lead is not signed out by it.
    expect(tab.fe.redirects).not.toContain(ENDED_PATH);
  });
});

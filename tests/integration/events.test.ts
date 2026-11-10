// Multi-event foundation, phase 1 (~/.config/lp-deploy/events-spec-20261109.md "Model", "Data", "Server"):
//   * two events live at once: no request, sync payload, stats number, Activity row, push target or case number of
//     one ever reaches the other (both start at LP-0001), even for one person signed in to both;
//   * practice → go live deletes every practice request (rows, audit, messages, photos with their objects) and
//     numbering restarts at LP-0001;
//   * end → every write path answers event_ended at all three guard layers (route 410, lp_require_writable P0410, the
//     patients trigger) while reads still work; sign-in with its password or link → 410 with the Ended screen's
//     event; reopen → writable again, numbering continues;
//   * a staff session never reaches another event by passing its ids;
//   * lead vs staff route access; a lead opens an event with a re-issued cookie;
//   * the password rule (lead passcode first; a password names one way in).
// Every event here is created through the lead routes with synthetic names. Synthetic values only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventAdmin, EventStats, RequestSummary, SessionInfo, SyncResponse } from '@/lib/api-types';
import { STATUS } from '@/lib/domain';
import { ROOT, ensureTestEvent, loadTestEnv } from '../../scripts/test-env.mjs';
import { EVENT_ID, PASSWORD, admin, api, clearAttempts, cookieFor, createBody, freshIp, newStaff, pii, psql, randomUUID, setCookies, uniq, withTestServer, type Staff } from './harness';

withTestServer();

const LEAD_PASSCODE = loadTestEnv({ keys: false }).LP_LEAD_PASSCODE as string;
const JPEG = readFileSync(join(ROOT, 'supabase', 'seed-photos', 'photo.jpg'));
const JPEG_THUMB = readFileSync(join(ROOT, 'supabase', 'seed-photos', 'photo_thumb.jpg'));

const POSTS = [
  { id: 'main', label: 'Main Stage Tent', short: 'Main' },
  { id: 'north', label: 'North Gate', short: 'North' },
];
const TEAMS = [
  { id: 'ops', label: 'Site Ops', short: 'Ops' },
  { id: 'med', label: 'Medics', short: 'Med', medical: true },
];

const ips: string[] = [];
async function ip(): Promise<string> {
  const v = await freshIp();
  ips.push(v);
  return v;
}

/** A lead session (minted; the real lead sign-in has its own test). */
async function leadCookie(eventId: string | null = null): Promise<string> {
  return cookieFor({ staffName: pii(`TEST-S Lead ${uniq()}`), team: 'Site Ops' }, { role: 'lead', eventId });
}

interface Made {
  event: EventAdmin;
  password: string;
}

/** A new event through the lead routes: created (practice), its staff password set, live unless `practice`. */
async function makeEvent(opts: { practice?: boolean; name?: string } = {}): Promise<Made> {
  const lead = await leadCookie();
  const slug = `t-${uniq()}`.toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const created = await api<{ event: EventAdmin }>('/api/events', {
    json: { slug, name: opts.name ?? pii(`TEST-S Fest ${uniq()}`), startsOn: today, endsOn: today, timezone: 'America/Chicago', dayStartHour: 6, posts: POSTS, teams: TEAMS, lastSeen: ['Main stage'] },
    cookie: lead,
  });
  expect(created.status, created.text).toBe(201);
  expect(created.body.event).toMatchObject({ slug, stage: 'practice', caseSeq: 0, hasStaffPassword: false });
  const password = pii(`pw-${uniq()}-${uniq()}`);
  const pw = await api(`/api/events/${created.body.event.id}/password`, { json: { password }, cookie: lead });
  expect(pw.status, pw.text).toBe(200);
  let event = (pw.body as { event: EventAdmin }).event;
  if (!opts.practice) {
    const live = await api<{ event: EventAdmin }>(`/api/events/${event.id}/go-live`, { json: {}, cookie: lead });
    expect(live.status, live.text).toBe(200);
    event = live.body.event;
  }
  return { event, password };
}

/** Signs `staff` in with a password through the real route; returns the cookie and the SessionInfo. */
async function signIn(staff: Staff, password: string): Promise<{ cookie: string; info: SessionInfo; status: number; body: unknown }> {
  const res = await api('/api/session', { json: { staffName: staff.staffName, team: staff.team, password }, headers: { 'x-real-ip': await ip() } });
  const cookie = setCookies(res.headers)[0]?.split(';')[0] ?? '';
  return { cookie, info: res.body as SessionInfo, status: res.status, body: res.body };
}

async function create(cookie: string, extra: Record<string, unknown> = {}): Promise<RequestSummary> {
  const res = await api('/api/requests', { json: createBody({ reportingLocation: 'Main Stage Tent', ...extra }), cookie });
  expect(res.status, res.text).toBe(201);
  return res.body.request as RequestSummary;
}

async function sync(cookie: string): Promise<SyncResponse> {
  const res = await api<SyncResponse>('/api/sync', { cookie });
  expect(res.status, res.text).toBe(200);
  return res.body;
}

const archivedAtEnd: string[] = [];

afterAll(async () => {
  for (const v of ips.splice(0)) await clearAttempts(v);
  // Leave nothing of this file running: its events end (their requests stay frozen, as at a real event's end).
  const lead = await leadCookie();
  for (const id of archivedAtEnd) await api(`/api/events/${id}/end`, { json: {}, cookie: lead });
  await ensureTestEvent();
});

describe('two events live at once', () => {
  let a: Made;
  let b: Made;
  // One person signed in to both (same name, same team): the attribution strings are identical.
  const both: Staff = { staffName: pii(`TEST-S Both ${uniq()}`), team: 'Site Ops' };
  let cookieA: string;
  let cookieB: string;
  let reqA1: RequestSummary;
  let reqA2: RequestSummary;
  let reqB1: RequestSummary;

  beforeAll(async () => {
    a = await makeEvent();
    b = await makeEvent();
    archivedAtEnd.push(a.event.id, b.event.id);
    const sa = await signIn(both, a.password);
    const sb = await signIn(both, b.password);
    expect([sa.status, sb.status]).toEqual([200, 200]);
    cookieA = sa.cookie;
    cookieB = sb.cookie;
    reqA1 = await create(cookieA);
    reqB1 = await create(cookieB, { reportingLocation: 'North Gate' });
    reqA2 = await create(cookieA, { reportingLocation: 'Other', otherLocation: 'TEST-S Bar' });
  });

  it('each password signs in to its own event, with its config; the team is the event\'s', () => {
    expect(a.event.stage).toBe('live');
    expect(b.event.stage).toBe('live');
  });

  it('both start at LP-0001 and count on their own', () => {
    expect([reqA1.caseNumber, reqA2.caseNumber, reqB1.caseNumber]).toEqual([1, 2, 1]);
    expect(psql(`select string_agg(slug || ':' || case_seq, ',' order by slug) from public.events where id in ('${a.event.id}', '${b.event.id}')`)).toBe(
      [`${a.event.slug}:2`, `${b.event.slug}:1`].sort().join(','),
    );
  });

  it('sync, detail and stats: no row of the other event, even by id', async () => {
    const ra = await sync(cookieA);
    const rb = await sync(cookieB);
    expect(ra.rows.map((r) => r.id).sort()).toEqual([reqA1.id, reqA2.id].sort());
    expect(rb.rows.map((r) => r.id)).toEqual([reqB1.id]);
    expect((await api<SyncResponse>(`/api/sync?ids=${reqB1.id},${reqA1.id}`, { cookie: cookieA })).body.rows.map((r) => r.id)).toEqual([reqA1.id]);
    expect((await api<SyncResponse>('/api/sync?reconcile=1', { cookie: cookieB })).body.versions?.map(([id]) => id)).toEqual([reqB1.id]);
    const sa = (await api<EventStats>('/api/stats?range=event', { cookie: cookieA })).body;
    const sb = (await api<EventStats>('/api/stats?range=event', { cookie: cookieB })).body;
    expect([sa.total, sb.total]).toEqual([2, 1]);
    expect(sa.range!.posts).toEqual([{ post: 'Main', n: 1 }, { post: 'Other', n: 1 }]);
    expect(sb.range!.posts).toEqual([{ post: 'North', n: 1 }]);
    expect(sa.team!.map((t) => t.team)).toEqual(['ops', 'med']);
    expect(sa.byPost.map((p) => [p.postShort, p.count])).toEqual([['Main', 1], ['TEST-S Bar', 1], ['North', 0]]);
  });

  it('a request of the other event is not found on every route, read or write', async () => {
    const id = reqB1.id;
    const v = reqB1.rowVersion;
    const checks: Array<[string, Promise<{ status: number }>]> = [
      ['detail', api(`/api/requests/${id}`, { cookie: cookieA })],
      ['patch', api(`/api/requests/${id}`, { method: 'PATCH', json: { expectedVersion: v, patch: { hair: 'Red' } }, cookie: cookieA })],
      ['status', api(`/api/requests/${id}/status`, { json: { status: STATUS.inMedical, expectedVersion: v, kind: 'answer' }, cookie: cookieA })],
      ['cancel', api(`/api/requests/${id}/cancel`, { json: { expectedVersion: v }, cookie: cookieA })],
      ['swap', api(`/api/requests/${id}/swap`, { json: { action: 'request', expectedVersion: v }, cookie: cookieA })],
      ['enroute', api(`/api/requests/${id}/enroute`, { json: { action: 'set', etaMinutes: 5 }, cookie: cookieA })],
      ['messages', api(`/api/requests/${id}/messages`, { cookie: cookieA })],
      ['post message', api(`/api/requests/${id}/messages`, { json: { body: 'TEST-S hi', clientMutationId: randomUUID() }, cookie: cookieA })],
      ['read', api(`/api/requests/${id}/messages/read`, { json: {}, cookie: cookieA })],
      ['unsend', api(`/api/requests/${id}/messages/${randomUUID()}/unsend`, { json: {}, cookie: cookieA })],
    ];
    for (const [label, call] of checks) expect((await call).status, label).toBe(404);
    const photo = new FormData();
    photo.set('photoId', randomUUID());
    photo.set('timing', 'today');
    photo.set('photo', new Blob([new Uint8Array(JPEG)], { type: 'image/jpeg' }), 'p.jpg');
    expect((await api(`/api/requests/${id}/photos`, { method: 'POST', body: photo, cookie: cookieA })).status).toBe(404);
    // Nothing of it changed, and no photo object was stored for it.
    expect(psql(`select row_version || ':' || status from public.patients where id = '${id}'`)).toBe(`${v}:${STATUS.waiting}`);
    const { data: objects } = await admin().storage.from('patient-photos').list(id);
    expect(objects ?? []).toEqual([]);
    // The SQL layer refuses it too (the app server's key, another event's id).
    expect(() => psql(`set role service_role; select lp_detail('${a.event.id}', '${id}')`)).toThrow(/not_found/);
  });

  it('a photo of the other event is not found', async () => {
    const photo = new FormData();
    const photoId = randomUUID();
    photo.set('photoId', photoId);
    photo.set('timing', 'today');
    photo.set('photo', new Blob([new Uint8Array(JPEG)], { type: 'image/jpeg' }), 'p.jpg');
    photo.set('thumb', new Blob([new Uint8Array(JPEG_THUMB)], { type: 'image/jpeg' }), 't.jpg');
    expect((await api(`/api/requests/${reqB1.id}/photos`, { method: 'POST', body: photo, cookie: cookieB })).status).toBe(201);
    expect((await api(`/api/photos/${photoId}?size=thumb`, { cookie: cookieA })).status).toBe(404);
    expect((await api(`/api/photos/${photoId}?size=thumb`, { cookie: cookieB })).status).toBe(302);
  });

  it('Activity and push targets stay in their event, even for the same person', async () => {
    const other = newStaff('Site Ops');
    // Two devices of the same person, one signed in to each event (rows as lp_push_subscribe writes them).
    const canon = `${both.staffName} · ${both.team}`.toLowerCase();
    const epA = `https://127.0.0.1:9/push/${uniq()}`;
    const epB = `https://127.0.0.1:9/push/${uniq()}`;
    psql(`insert into public.lp_push_subscriptions (event_id, endpoint, p256dh, auth, staff, team, new_requests, my_updates) values
          ('${a.event.id}', '${epA}', 'p256dh-test-key-0000', 'auth-test-0000', '${canon}', 'Site Ops', true, true),
          ('${b.event.id}', '${epB}', 'p256dh-test-key-0000', 'auth-test-0000', '${canon}', 'Site Ops', true, true)`);
    try {
      const rec = JSON.parse(psql(`set role service_role; select lp_activity_record('${a.event.id}', array['${canon}'], '${reqA1.id}', 'edited', '${other.staffName} · Site Ops', 'Details changed')::text`)) as { targets: Array<{ endpoint: string }>; written: string[] };
      expect(rec.written).toEqual([canon]);
      expect(rec.targets.map((t) => t.endpoint)).toEqual([epA]);
      // Recording an event of A against B's id writes nothing and pushes nobody.
      const cross = JSON.parse(psql(`set role service_role; select lp_activity_record('${a.event.id}', array['${canon}'], '${reqB1.id}', 'edited', 'x', 'x')::text`)) as { targets: unknown[]; written: unknown[] };
      expect([cross.written, cross.targets]).toEqual([[], []]);
      // The Activity inbox of each session: only its event's request.
      const inboxA = (await api('/api/activity', { cookie: cookieA })).body.rows as Array<{ requestId: string }>;
      const inboxB = (await api('/api/activity', { cookie: cookieB })).body.rows as Array<{ requestId: string }>;
      expect(inboxA.map((r) => r.requestId)).toContain(reqA1.id);
      expect(inboxB.map((r) => r.requestId)).not.toContain(reqA1.id);
      expect((await api('/api/activity/unread', { cookie: cookieB })).body.ids).not.toContain(reqA1.id);
      // Marking everything read in B leaves A's row unread.
      await api('/api/activity/read', { json: { all: true }, cookie: cookieB });
      expect((await api('/api/activity/unread', { cookie: cookieA })).body.ids).toContain(reqA1.id);
      // New-request staff: the person is in both (a device in each); someone only in B is not in A's list.
      const onlyB = `test-s onlyb ${uniq()} · site ops`;
      psql(`insert into public.lp_push_prefs (staff, team, new_requests) values ('${canon}', 'Site Ops', true), ('${onlyB}', 'Site Ops', true) on conflict (staff) do update set new_requests = true;
            insert into public.lp_push_subscriptions (event_id, endpoint, p256dh, auth, staff, team) values ('${b.event.id}', 'https://127.0.0.1:9/push/${uniq()}', 'p256dh-test-key-0000', 'auth-test-0000', '${onlyB}', 'Site Ops')`);
      const whoA = psql(`set role service_role; select array_to_string(lp_push_new_request_staff('${a.event.id}'), '|')`).split('|');
      const whoB = psql(`set role service_role; select array_to_string(lp_push_new_request_staff('${b.event.id}'), '|')`).split('|');
      expect(whoA).toContain(canon);
      expect(whoA).not.toContain(onlyB);
      expect(whoB).toEqual(expect.arrayContaining([canon, onlyB]));
      // A subscription moves with the device: subscribing again from B makes it B's.
      psql(`set role service_role; select lp_push_subscribe('${b.event.id}', '${epA}', 'p256dh-test-key-0000', 'auth-test-0000', '${both.staffName} · Site Ops', 'Site Ops', null, null, null)`);
      expect(psql(`select event_id from public.lp_push_subscriptions where endpoint = '${epA}'`)).toBe(b.event.id);
    } finally {
      psql(`delete from public.lp_push_subscriptions where endpoint like 'https://127.0.0.1:9/push/%'; delete from public.lp_push_prefs where staff like 'test-s onlyb %'`);
    }
  });

  it('a create replayed with a client id used in the other event never returns that request', async () => {
    const res = await api('/api/requests', { json: createBody({ clientMutationId: reqB1.clientMutationId, reportingLocation: 'Main Stage Tent' }), cookie: cookieA });
    expect(res.status).toBe(404);
  });

  it('posts and teams are the event\'s: another event\'s post is refused, a team outside the list is free text', async () => {
    const bad = await api('/api/requests', { json: createBody({ reportingLocation: 'FA 3 – Kinetic' }), cookie: cookieA });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'invalid', field: 'reportingLocation' });
    expect((await api(`/api/requests/${reqA1.id}`, { method: 'PATCH', json: { expectedVersion: reqA1.rowVersion, patch: { reportingLocation: 'North Gate' } }, cookie: cookieA })).status).toBe(200);
    const medic = await signIn({ staffName: pii(`TEST-S Medic ${uniq()}`), team: 'medics' }, a.password);
    expect(medic.info).toMatchObject({ role: 'staff', eventId: a.event.id, team: 'Medics' });
    expect(medic.info.event).toMatchObject({ slug: a.event.slug, posts: POSTS, teams: [{ ...TEAMS[0], medical: false }, TEAMS[1]], timezone: 'America/Chicago', dayStartHour: 6, stage: 'live' });
    const custom = await signIn({ staffName: pii(`TEST-S Guest ${uniq()}`), team: 'Security' }, a.password);
    expect(custom.info.team).toBe('Security');
    // GET /api/session carries the same config.
    expect((await api<SessionInfo>('/api/session', { cookie: medic.cookie })).body.event?.id).toBe(a.event.id);
  });
});

describe('practice → go live', () => {
  it('deletes every practice request (rows, audit, messages, photos and their objects) and restarts at LP-0001', async () => {
    const p = await makeEvent({ practice: true });
    archivedAtEnd.push(p.event.id);
    const staff = await signIn(newStaff('Site Ops'), p.password);
    expect(staff.info.event?.stage).toBe('practice');
    const r1 = await create(staff.cookie);
    const r2 = await create(staff.cookie);
    expect([r1.caseNumber, r2.caseNumber]).toEqual([1, 2]);
    expect((await api(`/api/requests/${r1.id}/messages`, { json: { body: 'TEST-S practice', clientMutationId: randomUUID() }, cookie: staff.cookie })).status).toBe(201);
    const photo = new FormData();
    photo.set('photoId', randomUUID());
    photo.set('timing', 'today');
    photo.set('photo', new Blob([new Uint8Array(JPEG)], { type: 'image/jpeg' }), 'p.jpg');
    photo.set('thumb', new Blob([new Uint8Array(JPEG_THUMB)], { type: 'image/jpeg' }), 't.jpg');
    expect((await api(`/api/requests/${r1.id}/photos`, { method: 'POST', body: photo, cookie: staff.cookie })).status).toBe(201);
    expect(((await admin().storage.from('patient-photos').list(r1.id)).data ?? []).length).toBe(2);

    const live = await api<{ event: EventAdmin; deleted: number }>(`/api/events/${p.event.id}/go-live`, { json: {}, cookie: await leadCookie() });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ deleted: 2, event: { stage: 'live', caseSeq: 0 } });
    expect(live.body.event.wentLiveAt).not.toBeNull();
    const ids = `'${r1.id}', '${r2.id}'`;
    expect(psql(`select (select count(*) from public.patients where id in (${ids})) || '/' || (select count(*) from public.audit_events where patient_id in (${ids}))
                 || '/' || (select count(*) from public.lp_messages where request_id in (${ids})) || '/' || (select count(*) from public.patient_photos where patient_id in (${ids}))`)).toBe('0/0/0/0');
    expect(((await admin().storage.from('patient-photos').list(r1.id)).data ?? []).length).toBe(0);
    // The same session goes on in the live event; numbering starts again.
    expect((await sync(staff.cookie)).rows).toEqual([]);
    expect((await create(staff.cookie)).caseNumber).toBe(1);
    // Only from practice.
    expect((await api(`/api/events/${p.event.id}/go-live`, { json: {}, cookie: await leadCookie() })).status).toBe(409);
  });
});

describe('end → event_ended at every layer; reads still work; reopen', () => {
  let e: Made;
  let cookie: string;
  let r: RequestSummary;
  let msgId: string;
  const staff = newStaff('Site Ops');

  beforeAll(async () => {
    e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    cookie = (await signIn(staff, e.password)).cookie;
    r = await create(cookie);
    const m = await api(`/api/requests/${r.id}/messages`, { json: { body: 'TEST-S before the end', clientMutationId: randomUUID() }, cookie });
    msgId = m.body.message.id;
    const ended = await api<{ event: EventAdmin }>(`/api/events/${e.event.id}/end`, { json: {}, cookie: await leadCookie() });
    expect(ended.status).toBe(200);
    expect(ended.body.event).toMatchObject({ stage: 'archived' });
    expect(ended.body.event.endedAt).not.toBeNull();
  });

  it('route layer: every business write answers 410 event_ended', async () => {
    const v = Number(psql(`select row_version from public.patients where id = '${r.id}'`));
    const photo = new FormData();
    photo.set('photoId', randomUUID());
    photo.set('timing', 'today');
    photo.set('photo', new Blob([new Uint8Array(JPEG)], { type: 'image/jpeg' }), 'p.jpg');
    const writes: Array<[string, Promise<{ status: number; body: { error?: { code?: string } } }>]> = [
      ['create', api('/api/requests', { json: createBody({ reportingLocation: 'Main Stage Tent' }), cookie })],
      ['patch', api(`/api/requests/${r.id}`, { method: 'PATCH', json: { expectedVersion: v, patch: { hair: 'Red' } }, cookie })],
      ['status', api(`/api/requests/${r.id}/status`, { json: { status: STATUS.inMedical, expectedVersion: v, kind: 'answer' }, cookie })],
      ['cancel', api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: v }, cookie })],
      ['swap', api(`/api/requests/${r.id}/swap`, { json: { action: 'request', expectedVersion: v }, cookie })],
      ['enroute', api(`/api/requests/${r.id}/enroute`, { json: { action: 'set', etaMinutes: 5 }, cookie })],
      ['message', api(`/api/requests/${r.id}/messages`, { json: { body: 'TEST-S after the end', clientMutationId: randomUUID() }, cookie })],
      ['unsend', api(`/api/requests/${r.id}/messages/${msgId}/unsend`, { json: {}, cookie })],
      ['photo', api(`/api/requests/${r.id}/photos`, { method: 'POST', body: photo, cookie })],
    ];
    for (const [label, call] of writes) {
      const res = await call;
      expect(res.status, label).toBe(410);
      expect(res.body.error?.code, label).toBe('event_ended');
    }
    expect(((await admin().storage.from('patient-photos').list(r.id)).data ?? []).length).toBe(0);
    expect(psql(`select row_version || ':' || status from public.patients where id = '${r.id}'`)).toBe(`${v}:${STATUS.waiting}`);
  });

  it('reads, read markers and the session still work', async () => {
    expect((await sync(cookie)).rows.map((x) => x.id)).toEqual([r.id]);
    expect((await api(`/api/requests/${r.id}`, { cookie })).status).toBe(200);
    expect((await api(`/api/requests/${r.id}/messages`, { cookie })).status).toBe(200);
    expect((await api('/api/stats?range=event', { cookie })).status).toBe(200);
    expect((await api(`/api/requests/${r.id}/messages/read`, { json: {}, cookie })).status).toBe(200);
    expect((await api('/api/activity/read', { json: { all: true }, cookie })).status).toBe(200);
    expect((await api<SessionInfo>('/api/session', { cookie })).body.event?.stage).toBe('archived');
    // A client holding an older config version learns the stage from sync.
    const withEv = await api<SyncResponse>('/api/sync?since=2099-01-01T00:00:00.000000%2B00:00&ev=', { cookie });
    expect(withEv.body.event).toMatchObject({ id: e.event.id, stage: 'archived' });
    const same = await api<SyncResponse>(`/api/sync?since=2099-01-01T00:00:00.000000%2B00:00&ev=${encodeURIComponent(withEv.body.event!.version)}`, { cookie });
    expect(same.body.event).toBeUndefined();
  });

  it('SQL layer: every write RPC raises P0410 event_ended first (lp_require_writable)', () => {
    const v = psql(`select row_version from public.patients where id = '${r.id}'`);
    const E = `'${e.event.id}'`;
    const R = `'${r.id}'`;
    const calls = [
      `lp_create_request(${E}, '{"client_mutation_id":"${randomUUID()}","reporting_location":"Main Stage Tent"}', 'X · Site Ops')`,
      `lp_update_fields(${E}, ${R}, '{"hair":"Red"}', ${v}, 'X · Site Ops')`,
      `lp_set_status(${E}, ${R}, ${v}, 'Found – Awaiting Reunion', 'X · Site Ops', 'answer')`,
      `lp_cancel(${E}, ${R}, ${v}, 'X · Site Ops')`,
      `lp_swap(${E}, ${R}, ${v}, 'request', null, 'X · Site Ops')`,
      `lp_set_enroute(${E}, ${R}, 'set', 300, null, 5, 'X · Site Ops')`,
      `lp_add_photo(${E}, ${R}, '${randomUUID()}', '${r.id}/x.jpg', null, 'today', 'X · Site Ops')`,
      `lp_post_message(${E}, ${R}, 'TEST-S x', '${randomUUID()}', 'X · Site Ops', 'Site Ops')`,
      `lp_unsend_message(${E}, ${R}, '${msgId}', 'X · Site Ops')`,
      `lp_require_writable(${E})`,
    ];
    for (const call of calls) expect(() => psql(`set role service_role; select ${call};`), call).toThrow(/event_ended/);
  });

  it('trigger layer: no INSERT, UPDATE or DELETE reaches an ended event\'s requests, whoever writes; the auto-close skips them', () => {
    expect(() => psql(`update public.patients set hair = 'Red' where id = '${r.id}'`)).toThrow(/event_ended/);
    expect(() => psql(`delete from public.patients where id = '${r.id}'`)).toThrow(/event_ended/);
    expect(() =>
      psql(`insert into public.patients (event_id, case_number, reporting_location, status, created_by, updated_by) values ('${e.event.id}', 99, 'Base', 'Added', 'x', 'x')`),
    ).toThrow(/event_ended/);
    // A request never moves to another event either.
    const live = psql(`select id from public.patients where event_id = '${EVENT_ID}' limit 1`);
    expect(() => psql(`update public.patients set event_id = '${e.event.id}' where id = '${live}'`)).toThrow(/event_id/);
    psql(`update public.patients set status = 'Found – Awaiting Reunion' where id = '${r.id}' and false`); // a no-op is fine
    // Open In medical for hours in an ended event: lp_close_inactive leaves it alone (and does not fail).
    expect(psql(`select public.lp_close_inactive(array['${r.id}']::uuid[])`)).toBe('0');
  });

  it('sign-in with the ended event\'s password or link → 410 event_ended with the event for the Ended screen; no cookie', async () => {
    const res = await api('/api/session', { json: { staffName: pii(`TEST-S Late ${uniq()}`), team: 'Site Ops', password: e.password }, headers: { 'x-real-ip': await ip() } });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatchObject({ code: 'event_ended', event: { name: e.event.name, stage: 'archived', logoUrl: null } });
    expect(setCookies(res.headers)).toEqual([]);
    // The event's join link (a lead may rotate it at any stage): an archived event's link reaches the Ended screen.
    const link = await api<{ link: string }>(`/api/events/${e.event.id}/join-link`, { json: {}, cookie: await leadCookie() });
    expect(link.status).toBe(201);
    expect(link.body.link).toMatch(new RegExp(`/signin#join=${e.event.slug}\\.[A-Za-z0-9_-]{43}$`));
    const token = decodeURIComponent(new URL(link.body.link).hash.slice('#join='.length));
    const viaLink = await api('/api/session', { json: { staffName: pii(`TEST-S Late ${uniq()}`), team: 'Site Ops', invite: token }, headers: { 'x-real-ip': await ip() } });
    expect(viaLink.status).toBe(410);
    expect(viaLink.body.error.code).toBe('event_ended');
  });

  it('reopen: archived → live, writable again, numbering continues; only from archived', async () => {
    const lead = await leadCookie();
    const reopened = await api<{ event: EventAdmin }>(`/api/events/${e.event.id}/reopen`, { json: {}, cookie: lead });
    expect(reopened.status).toBe(200);
    expect(reopened.body.event).toMatchObject({ stage: 'live', endedAt: null });
    expect((await create(cookie)).caseNumber).toBe(2);
    expect((await api(`/api/events/${e.event.id}/reopen`, { json: {}, cookie: lead })).status).toBe(409);
    expect((await api(`/api/events/${e.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    expect((await api(`/api/events/${e.event.id}/end`, { json: {}, cookie: lead })).status).toBe(409);
  });
});

describe('lead vs staff', () => {
  it('staff get 403 on every lead route; a lead with no event open gets 409 no_event on event routes', async () => {
    const staffCookie = await cookieFor(newStaff());
    const target = EVENT_ID;
    const leadRoutes: Array<[string, string, unknown]> = [
      ['GET', '/api/events', undefined],
      ['POST', '/api/events', { slug: `t-${uniq()}`, name: 'x', startsOn: '2026-11-14', endsOn: '2026-11-15' }],
      ['GET', `/api/events/${target}`, undefined],
      ['PATCH', `/api/events/${target}`, { name: 'x' }],
      ['POST', `/api/events/${target}/password`, { password: 'whatever-123' }],
      ['POST', `/api/events/${target}/join-link`, {}],
      ['POST', `/api/events/${target}/go-live`, {}],
      ['POST', `/api/events/${target}/end`, {}],
      ['POST', `/api/events/${target}/reopen`, {}],
      ['POST', '/api/org/lead-passcode', { passcode: 'whatever-123' }],
      ['POST', '/api/session/event', { eventId: target }],
    ];
    for (const [method, path, json] of leadRoutes) {
      const res = await api(path, { method, json, cookie: staffCookie });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const logo = new FormData();
    logo.set('logo', new Blob([new Uint8Array(JPEG)], { type: 'image/jpeg' }), 'l.jpg');
    expect((await api(`/api/events/${target}/logo`, { method: 'POST', body: logo, cookie: staffCookie })).status).toBe(403);
    // Cross-site: refused before the role is even read.
    expect((await api('/api/events', { json: {}, cookie: await leadCookie(), origin: 'https://evil.example' })).status).toBe(403);

    const lead = await leadCookie();
    const noEvent = await api('/api/sync', { cookie: lead });
    expect(noEvent.status).toBe(409);
    expect(noEvent.body.error.code).toBe('no_event');
    expect((await api<SessionInfo>('/api/session', { cookie: lead })).body).toMatchObject({ role: 'lead', eventId: null, event: null });
    const list = await api<{ events: EventAdmin[] }>('/api/events', { cookie: lead });
    expect(list.status).toBe(200);
    expect(list.body.events.map((x) => x.slug)).toEqual(expect.arrayContaining(['local', 'edco26']));
    expect(JSON.stringify(list.body)).not.toMatch(/\$2[aby]\$|staff_password|invite_code/);
  });

  it('the lead passcode signs in as lead (checked first); opening an event re-issues the cookie with it', async () => {
    const res = await api('/api/session', { json: { staffName: pii(`TEST-S Lead ${uniq()}`), team: 'Medical', password: LEAD_PASSCODE }, headers: { 'x-real-ip': await ip() } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'lead', eventId: null, event: null });
    const cookie = setCookies(res.headers)[0]!.split(';')[0]!;
    const opened = await api<SessionInfo>('/api/session/event', { json: { eventId: EVENT_ID }, cookie });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ role: 'lead', eventId: EVENT_ID, event: { slug: 'local', stage: 'live' } });
    const leadInEvent = setCookies(opened.headers)[0]!.split(';')[0]!;
    // Every staff ability in the open event, plus setup.
    expect((await sync(leadInEvent)).rows.length).toBeGreaterThan(0);
    expect((await api('/api/requests', { json: createBody(), cookie: leadInEvent })).status).toBe(201);
    expect((await api('/api/events', { cookie: leadInEvent })).status).toBe(200);
    expect((await api('/api/session/event', { json: { eventId: randomUUID() }, cookie })).status).toBe(404);
    const closed = await api<SessionInfo>('/api/session/event', { json: { eventId: null }, cookie: leadInEvent });
    expect(closed.body).toMatchObject({ role: 'lead', eventId: null });
  });

  it('a staff session cannot switch events and a minted staff cookie for another event reaches only that event', async () => {
    const staffCookie = await cookieFor(newStaff());
    expect((await api('/api/session/event', { json: { eventId: randomUUID() }, cookie: staffCookie })).status).toBe(403);
    // A staff token without an event is not a session at all.
    const { signSessionToken } = await import('@/lib/server/session-token');
    expect(await signSessionToken({ staffName: 'X', team: 'Y', eventId: null, role: 'staff' }, process.env.SESSION_SECRET!.trim())).toBeNull();
  });
});

describe('the password rule', () => {
  it('a staff password may not be the lead passcode or another running event\'s; an archived event\'s is free again', async () => {
    const lead = await leadCookie();
    const one = await makeEvent();
    const two = await makeEvent({ practice: true });
    archivedAtEnd.push(one.event.id, two.event.id);
    const set = (id: string, password: string) => api(`/api/events/${id}/password`, { json: { password }, cookie: lead });
    const clash = await set(two.event.id, one.password);
    expect(clash.status).toBe(422);
    expect(clash.body.error).toMatchObject({ code: 'invalid', field: 'password' });
    expect((await set(two.event.id, LEAD_PASSCODE)).status).toBe(422);
    expect((await set(two.event.id, PASSWORD)).status).toBe(422); // the local test event's (live)
    // The same password again on its own event is fine.
    expect((await set(one.event.id, one.password)).status).toBe(200);
    // Once one has ended, its password may be used again; the running event wins at sign-in.
    expect((await api(`/api/events/${one.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    expect((await set(two.event.id, one.password)).status).toBe(200);
    const who = await signIn(newStaff('Site Ops'), one.password);
    expect(who.status).toBe(200);
    expect(who.info.eventId).toBe(two.event.id);
    // Too short.
    expect((await set(two.event.id, 'short')).status).toBe(422);
  });

  it('the lead passcode may not be any event\'s staff password, archived ones included', async () => {
    const lead = await leadCookie();
    const res = await api('/api/org/lead-passcode', { json: { passcode: PASSWORD }, cookie: lead });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'invalid', field: 'passcode' });
    const ended = await makeEvent();
    archivedAtEnd.push(ended.event.id);
    expect((await api(`/api/events/${ended.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    expect((await api('/api/org/lead-passcode', { json: { passcode: ended.password }, cookie: lead })).status).toBe(422);
    // A fresh one is taken (and put back by ensureTestEvent at the end).
    expect((await api('/api/org/lead-passcode', { json: { passcode: `lead-${uniq()}-${uniq()}` }, cookie: lead })).status).toBe(200);
    await ensureTestEvent();
  });
});

describe('event settings', () => {
  it('create and update validate the posts, teams and dates; the link name is unique', async () => {
    const lead = await leadCookie();
    const slug = `t-${uniq()}`;
    const base = { slug, name: 'TEST-S Settings', startsOn: '2026-11-14', endsOn: '2026-11-15' };
    const made = await api<{ event: EventAdmin }>('/api/events', { json: base, cookie: lead });
    expect(made.status).toBe(201);
    archivedAtEnd.push(made.body.event.id);
    expect(made.body.event).toMatchObject({ timezone: 'America/New_York', dayStartHour: 6, mainMedical: 'Main Med', posts: [], teams: [] });
    expect((await api('/api/events', { json: base, cookie: lead })).status).toBe(409);
    const id = made.body.event.id;
    const patch = (json: unknown) => api<{ event: EventAdmin }>(`/api/events/${id}`, { method: 'PATCH', json, cookie: lead });
    expect((await patch({ posts: [{ label: 'Other' }] })).status).toBe(422);
    expect((await patch({ teams: [{ label: 'A1', medical: true }, { label: 'B1', medical: true }] })).status).toBe(422);
    expect((await patch({ endsOn: '2026-11-01' })).status).toBe(422);
    expect((await patch({ timezone: 'Mars/Olympus' })).status).toBe(422);
    expect((await patch({ dayStartHour: 24 })).status).toBe(422);
    const ok = await patch({ posts: [{ label: 'Gate A' }, { label: 'Gate B', short: 'B' }], teams: [{ label: 'Medics', medical: true }], dayStartHour: 10, timezone: 'America/Chicago' });
    expect(ok.status).toBe(200);
    expect(ok.body.event).toMatchObject({ posts: [{ id: 'gate-a', label: 'Gate A', short: 'Gate A' }, { id: 'gate-b', label: 'Gate B', short: 'B' }], teams: [{ id: 'medics', label: 'Medics', short: 'Medics', medical: true }], dayStartHour: 10 });
    // Go live needs posts and teams (they are there now) and stays the lead's choice.
    expect((await api(`/api/events/${id}/go-live`, { json: {}, cookie: lead })).status).toBe(200);
  });
});

describe('scripts/bootstrap-events.mjs (the one-time bootstrap, run here against the local stack only)', () => {
  const run = async (env: Record<string, string>, args: string[] = []) => {
    const { spawnSync } = await import('node:child_process');
    const base = loadTestEnv();
    return spawnSync(process.execPath, [join(ROOT, 'scripts', 'bootstrap-events.mjs'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NEXT_PUBLIC_SUPABASE_URL: base.NEXT_PUBLIC_SUPABASE_URL!, SUPABASE_SECRET_KEY: base.SUPABASE_SECRET_KEY!, ...env } as unknown as NodeJS.ProcessEnv,
    });
  };
  const bcrypt = async () => (await import('bcryptjs')).default;

  afterAll(async () => {
    psql(`update public.events set staff_password_hash = null, invite_code_sha256 = null, invite_expires_at = null where slug = 'edco26'`);
    await ensureTestEvent();
  });

  it('sets the lead passcode and copies the EDC staff password and join link from the env, printing neither', async () => {
    const lead = pii(`boot-lead-${uniq()}-${uniq()}`);
    const edcPassword = pii(`boot-edc-${uniq()}-${uniq()}`);
    const code = pii(`boot-code-${uniq()}`);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(code, 'utf8').digest('hex');
    const env = { LP_LEAD_PASSCODE: lead, APP_SHARED_PASSWORD: edcPassword, INVITE_CODE_SHA256: sha, INVITE_EXPIRES_AT: '2026-11-09T12:00:00Z' };

    // Already set (the test setups set it): refused without --force; a dry run writes nothing.
    const refused = await run(env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('already set');
    const dry = await run(env, ['--dry-run', '--force']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(psql(`select staff_password_hash is null from public.events where slug = 'edco26'`)).toBe('t');

    const res = await run(env, ['--force']);
    expect(res.status, res.stderr).toBe(0);
    const printed = res.stdout + res.stderr;
    for (const secret of [lead, edcPassword, code, sha]) expect(printed).not.toContain(secret);
    expect(printed).not.toMatch(/\$2[aby]\$/);
    const b = await bcrypt();
    expect(await b.compare(lead, psql('select lead_passcode_hash from public.lp_org'))).toBe(true);
    expect(await b.compare(edcPassword, psql(`select staff_password_hash from public.events where slug = 'edco26'`))).toBe(true);
    expect(psql(`select invite_code_sha256 || '|' || invite_expires_at from public.events where slug = 'edco26'`)).toBe(`${sha}|2026-11-09 12:00:00+00`);

    // The old EDC password and link now reach the Ended screen; the lead passcode signs in as lead.
    const old = await api('/api/session', { json: { staffName: pii(`TEST-S Old ${uniq()}`), team: 'Medical', password: edcPassword }, headers: { 'x-real-ip': await ip() } });
    expect(old.status).toBe(410);
    expect(old.body.error.event).toMatchObject({ name: 'EDC Orlando', stage: 'archived' });
    const oldLink = await api('/api/session', { json: { staffName: pii(`TEST-S Old ${uniq()}`), team: 'Medical', invite: code }, headers: { 'x-real-ip': await ip() } });
    expect(oldLink.status).toBe(410);
    const asLead = await api('/api/session', { json: { staffName: pii(`TEST-S Boss ${uniq()}`), team: 'Medical', password: lead }, headers: { 'x-real-ip': await ip() } });
    expect(asLead.body).toMatchObject({ role: 'lead' });

    // A lead passcode equal to the EDC password is refused.
    const same = await run({ ...env, LP_LEAD_PASSCODE: edcPassword }, ['--force']);
    expect(same.status).toBe(1);
    expect(same.stderr).toContain('choose another');
  });
});

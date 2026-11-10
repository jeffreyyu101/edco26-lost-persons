// Multi-event foundation, phase 1 (~/.config/lp-deploy/events-spec-20261109.md "Model", "Data", "Server"):
//   * two events live at once: no request, sync payload, stats number, Activity row, push target or case number of
//     one ever reaches the other (both start at LP-0001), even for one person signed in to both;
//   * practice → go live deletes every practice request (rows, audit, messages, photos with their objects) and
//     numbering restarts at LP-0001;
//   * end → every write path answers event_ended at all three guard layers (route 410, lp_require_writable P0410, the
//     patients trigger) while reads still work; (grace period) for 24 h the end keeps its staff password and join
//     link, which then answer 410 with the Ended screen's event and sign nobody in; after 24 h (ended_at moved back,
//     the way these tests move time) both are cleared, lazily at sign-in / reopen and by the auto-close job: the old
//     password is a wrong password (401), the old link (its slug) still → 410; reopen → writable again, numbering
//     continues, with the same password and link inside the 24 h and neither after them;
//   * a staff session never reaches another event by passing its ids;
//   * lead vs staff route access; a lead opens an event with a re-issued cookie;
//   * the password rule (lead passcode first; a password names one way in).
// Every event here is created through the lead routes with synthetic names. Synthetic values only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventAdmin, EventStats, RequestSummary, SessionInfo, SyncResponse } from '@/lib/api-types';
import { STATUS } from '@/lib/domain';
import { ROOT, TEST_EVENT_SLUG, ensureTestEvent, loadTestEnv } from '../../scripts/test-env.mjs';
import { BASE, EVENT_ID, PASSWORD, admin, api, clearAttempts, cookieFor, createBody, freshIp, newStaff, pii, psql, psqlAsync, randomUUID, setCookies, uniq, withTestServer, type Staff } from './harness';

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

/** "YYYY-MM-DD" moved by `days`. */
function dayShift(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

afterAll(async () => {
  for (const v of ips.splice(0)) await clearAttempts(v);
  // Leave nothing of this file running: its events end (their requests stay frozen, as at a real event's end).
  const lead = await leadCookie();
  for (const id of archivedAtEnd) await api(`/api/events/${id}/end`, { json: {}, cookie: lead });
  // The end clears their staff passwords and links (phase 3); their retired hashes go too, or every later lead
  // passcode change in this stack would compare against each of them (bcrypt, ≈ 70 ms).
  if (archivedAtEnd.length) {
    psql(`update public.events set staff_password_hash = null, ended_password_hash = null, invite_code_sha256 = null, invite_expires_at = null
          where id = any (array[${archivedAtEnd.map((id) => `'${id}'`).join(', ')}]::uuid[])`);
  }
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
  it('messages delta, inactive claim, en route, Health, speed and attention: nothing of B reaches A', async () => {
    const letters = (v: string) => v.replace(/\d/g, (c) => 'abcdefghij'[Number(c)] ?? 'a');
    const before = (await sync(cookieA)).serverTime;
    // B: its request answered (In medical), someone en route, and a message on it.
    const vB1 = Number(psql(`select row_version from public.patients where id = '${reqB1.id}'`));
    const answered = await api(`/api/requests/${reqB1.id}/status`, { json: { status: STATUS.inMedical, expectedVersion: vB1, kind: 'answer' }, cookie: cookieB });
    expect(answered.status, answered.text).toBe(200);
    expect((await api(`/api/requests/${reqB1.id}/enroute`, { json: { action: 'set', etaMinutes: 5 }, cookie: cookieB })).status).toBe(200);
    expect((await api(`/api/requests/${reqB1.id}/messages`, { json: { body: 'TEST-S in B', clientMutationId: randomUUID() }, cookie: cookieB })).status).toBe(201);

    // Messages delta: A's delta carries no row or thread of B (the same person is in both); B's does.
    const deltaA = await api<SyncResponse>(`/api/sync?since=${encodeURIComponent(before)}`, { cookie: cookieA });
    expect(deltaA.body.rows.map((r) => r.id)).not.toContain(reqB1.id);
    const deltaB = await api<SyncResponse>(`/api/sync?since=${encodeURIComponent(before)}`, { cookie: cookieB });
    expect(deltaB.body.rows.find((r) => r.id === reqB1.id)?.messageCount).toBe(1);
    const staffBoth = `${(await api<SessionInfo>('/api/session', { cookie: cookieA })).body.staff}`;
    const raw = JSON.parse(psql(`set role service_role; select lp_messages_sync('${a.event.id}', '${staffBoth}', array['${reqB1.id}']::uuid[], now() - interval '1 hour', true)::text`)) as { threads: unknown[]; rows: unknown[] };
    expect([raw.threads, raw.rows]).toEqual([[], []]);

    // En route stats: B counts its friend en route, A none.
    const statsA = (await api<EventStats>('/api/stats?range=event', { cookie: cookieA })).body;
    const statsB = (await api<EventStats>('/api/stats?range=event', { cookie: cookieB })).body;
    expect([statsA.friendsEnRoute, statsB.friendsEnRoute]).toEqual([0, 1]);
    // Speed: only B's first check counts in B; A has none. Attention: each lists only its own requests.
    expect(statsA.speed!.find((x) => x.key === 'firstCheck')?.n ?? 0).toBe(0);
    expect(statsB.speed!.find((x) => x.key === 'firstCheck')?.n).toBe(1);
    const aIds = [reqA1.id, reqA2.id];
    expect(statsA.attention!.items.map((i) => i.id).sort()).toEqual([...aIds].sort());
    expect(statsA.attention!.total).toBe(2);
    expect(statsB.attention!.items.map((i) => i.id)).toEqual([reqB1.id]);

    // Inactive claim: a close of B's request is never claimed through A.
    const closedB = await create(cookieB);
    psql(`update public.patients set status = 'Closed – Inactive', closed_at = now() where id = '${closedB.id}';
          insert into public.lp_inactive_closes (request_id, closed_at, idle_since, quiet) values ('${closedB.id}', now(), now() - interval '2 hours', false)`);
    expect(psql(`set role service_role; select lp_inactive_claim('${a.event.id}', array['${closedB.id}']::uuid[])::text`)).toBe('[]');
    expect(psql(`select count(*) from public.lp_inactive_closes where request_id = '${closedB.id}' and notified_at is null`)).toBe('1');
    expect(psql(`set role service_role; select lp_inactive_claim('${b.event.id}', array['${closedB.id}']::uuid[])::text`)).toBe(`["${closedB.id}"]`);

    // Health: B's telemetry problems are B's only.
    const area = letters(`xev${uniq()}`).slice(0, 40);
    const device = letters(`xev${uniq()}${uniq()}`).slice(0, 20);
    psql(`insert into public.lp_tel_events (event_id, at, device, session, team, name, view, area, ctl, n, props, trail)
          values ('${b.event.id}', now(), '${device}', 'sessxeva', 'other', 'rage_tap', 'pending', '${area}', 'check-card', 3, '{"ptr":"touch"}', '[[-500, "t:pending"]]')`);
    try {
      const healthA = await api('/api/telemetry/health?window=1h', { cookie: cookieA });
      const healthB = await api('/api/telemetry/health?window=1h', { cookie: cookieB });
      expect([healthA.status, healthB.status]).toEqual([200, 200]);
      expect(healthA.text).not.toContain(area);
      expect(healthB.text).toContain(area);
    } finally {
      psql(`delete from public.lp_tel_events where device = '${device}'`);
    }
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

describe('end → event_ended at every layer; staff are locked out, leads keep reading; reopen', () => {
  let e: Made;
  let cookie: string;
  let r: RequestSummary;
  let msgId: string;
  let photoId: string;
  let oldLink: string;
  const staff = newStaff('Site Ops');

  beforeAll(async () => {
    e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    // The join link its staff were given while it ran.
    const link = await api<{ link: string }>(`/api/events/${e.event.id}/join-link`, { json: {}, cookie: await leadCookie() });
    expect(link.status).toBe(201);
    expect(link.body.link).toMatch(new RegExp(`/signin#join=${e.event.slug}\\.[A-Za-z0-9_-]{43}$`));
    oldLink = decodeURIComponent(new URL(link.body.link).hash.slice('#join='.length));
    cookie = (await signIn(staff, e.password)).cookie;
    r = await create(cookie);
    const m = await api(`/api/requests/${r.id}/messages`, { json: { body: 'TEST-S before the end', clientMutationId: randomUUID() }, cookie });
    msgId = m.body.message.id;
    photoId = randomUUID();
    const photo = new FormData();
    photo.set('photoId', photoId);
    photo.set('timing', 'today');
    photo.set('photo', new Blob([new Uint8Array(JPEG)], { type: 'image/jpeg' }), 'p.jpg');
    photo.set('thumb', new Blob([new Uint8Array(JPEG_THUMB)], { type: 'image/jpeg' }), 't.jpg');
    expect((await api(`/api/requests/${r.id}/photos`, { method: 'POST', body: photo, cookie })).status).toBe(201);
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
    // Only the original photo's two objects: nothing new was stored.
    expect(((await admin().storage.from('patient-photos').list(r.id)).data ?? []).length).toBe(2);
    expect(psql(`select row_version || ':' || status from public.patients where id = '${r.id}'`)).toBe(`${v}:${STATUS.waiting}`);
  });

  it('staff: every read answers 410 event_ended with the Ended screen\'s event, so a phone that only polls learns it ended', async () => {
    const reads: Array<[string, string, RequestInit & { json?: unknown }]> = [
      ['sync', '/api/sync', {}],
      ['sync delta', '/api/sync?since=2099-01-01T00:00:00.000000%2B00:00&ev=', {}],
      ['sync ids', `/api/sync?ids=${r.id}`, {}],
      ['sync reconcile', '/api/sync?reconcile=1', {}],
      ['detail', `/api/requests/${r.id}`, {}],
      ['messages', `/api/requests/${r.id}/messages`, {}],
      ['photo', `/api/photos/${photoId}?size=thumb`, {}],
      ['stats', '/api/stats?range=event', {}],
      ['stats today', '/api/stats', {}],
      ['activity', '/api/activity', {}],
      ['activity unread', '/api/activity/unread', {}],
      ['health', '/api/telemetry/health', {}],
      // Read markers and push need the event too: after the end there is nothing left to mark or to be told.
      ['message read', `/api/requests/${r.id}/messages/read`, { method: 'POST', json: {} }],
      ['activity read', '/api/activity/read', { method: 'POST', json: { all: true } }],
      ['push prefs', '/api/push/prefs', { method: 'POST', json: { newRequests: true } }],
      // The rest of the signed-in routes: the wrapper answers before the body is read.
      ['activity unread mark', '/api/activity/unread', { method: 'POST', json: {} }],
      ['push subscribe', '/api/push/subscribe', { method: 'POST', json: {} }],
      ['push test', '/api/push/test', { method: 'POST', json: {} }],
      ['telemetry', '/api/telemetry', { method: 'POST', json: {} }],
      // GET /api/session reports the end (the Ended screen), not a bare 401.
      ['session', '/api/session', {}],
    ];
    for (const [label, path, init] of reads) {
      const res = await api(path, { method: init.method, json: init.json, cookie });
      expect(res.status, `${label} ${res.text}`).toBe(410);
      expect(res.body.error, label).toMatchObject({ code: 'event_ended', event: { name: e.event.name, stage: 'archived', logoUrl: null } });
      // No sliding re-issue of an ended event's session.
      expect(setCookies(res.headers), label).toEqual([]);
    }
  });

  it('staff: signing out and removing the device\'s push subscription still work after the end', async () => {
    const endpoint = `https://127.0.0.1:9/push/${uniq()}`;
    psql(`insert into public.lp_push_subscriptions (event_id, endpoint, p256dh, auth, staff, team) values ('${e.event.id}', '${endpoint}', 'p256dh-test-key-0000', 'auth-test-0000', '${`${staff.staffName} · ${staff.team}`.toLowerCase()}', 'Site Ops')`);
    const unsub = await api('/api/push/subscribe', { method: 'DELETE', json: { endpoint }, cookie });
    expect(unsub.status, unsub.text).toBe(200);
    expect(psql(`select count(*) from public.lp_push_subscriptions where endpoint = '${endpoint}'`)).toBe('0');
    // A second session of the same person (the first one keeps its cookie for the reads test above).
    const other = await cookieFor(staff, { eventId: e.event.id });
    const out = await api('/api/session', { method: 'DELETE', cookie: other });
    expect(out.status).toBe(200);
    expect(setCookies(out.headers)[0]).toMatch(/^lp_session=;/);
  });

  it('a lead keeps reading the ended event (sync, detail, messages, photos, stats) and learns its stage from sync', async () => {
    const lead = await leadCookie(e.event.id);
    expect((await sync(lead)).rows.map((x) => x.id)).toEqual([r.id]);
    expect((await api(`/api/requests/${r.id}`, { cookie: lead })).status).toBe(200);
    expect((await api(`/api/requests/${r.id}/messages`, { cookie: lead })).status).toBe(200);
    expect((await api(`/api/photos/${photoId}?size=thumb`, { cookie: lead })).status).toBe(302);
    expect((await api('/api/stats?range=event', { cookie: lead })).status).toBe(200);
    expect((await api(`/api/requests/${r.id}/messages/read`, { json: {}, cookie: lead })).status).toBe(200);
    expect((await api<SessionInfo>('/api/session', { cookie: lead })).body.event?.stage).toBe('archived');
    // A client holding an older config version learns the stage from sync.
    const withEv = await api<SyncResponse>('/api/sync?since=2099-01-01T00:00:00.000000%2B00:00&ev=', { cookie: lead });
    expect(withEv.body.event).toMatchObject({ id: e.event.id, stage: 'archived' });
    const same = await api<SyncResponse>(`/api/sync?since=2099-01-01T00:00:00.000000%2B00:00&ev=${encodeURIComponent(withEv.body.event!.version)}`, { cookie: lead });
    expect(same.body.event).toBeUndefined();
    // Its writes are refused like anyone's (SQL guard → 410).
    const v = Number(psql(`select row_version from public.patients where id = '${r.id}'`));
    const write = await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { expectedVersion: v, patch: { hair: 'Red' } }, cookie: lead });
    expect(write.status).toBe(410);
  });

  it('child tables: no audit row, message, photo row or en route row of an ended event is added, changed or removed, whoever writes', () => {
    const R = `'${r.id}'`;
    const refused = [
      `insert into public.audit_events (patient_id, staff_name, action_type) values (${R}, 'X', 'note')`,
      `update public.audit_events set notes = 'x' where patient_id = ${R}`,
      `delete from public.audit_events where patient_id = ${R}`,
      `insert into public.audit_events (event_id, staff_name, action_type) values ('${e.event.id}', 'X', 'note')`,
      `insert into public.lp_messages (request_id, staff, staff_key, team, body, client_mutation_id) values (${R}, 'X · Site Ops', 'x · site ops', 'Site Ops', 'TEST-S late', gen_random_uuid())`,
      `update public.lp_messages set body = 'x' where request_id = ${R}`,
      `delete from public.lp_messages where request_id = ${R}`,
      `insert into public.patient_photos (patient_id, storage_path, photo_timing, uploaded_by) values (${R}, '${r.id}/late.jpg', 'today', 'X')`,
      `update public.patient_photos set photo_timing = 'older' where patient_id = ${R}`,
      `delete from public.patient_photos where patient_id = ${R}`,
      `insert into public.lp_enroute (request_id, staff, staff_name, eta_at, eta_minutes, state) values (${R}, 'x · site ops', 'X', now(), 5, 'enroute')`,
    ];
    for (const sql of refused) expect(() => psql(sql), sql).toThrow(/event_ended/);
    expect(psql(`select (select count(*) from public.lp_messages where request_id = ${R}) || '/' || (select count(*) from public.patient_photos where patient_id = ${R})`)).toBe('1/1');
    // What the system still writes after the end lives elsewhere: read markers.
    psql(`insert into public.lp_message_reads (request_id, staff, last_read_at) values (${R}, 'test-s marker · site ops', now()) on conflict do nothing`);
    expect(psql(`select event_id from public.lp_message_reads where request_id = ${R} and staff = 'test-s marker · site ops'`)).toBe(e.event.id);
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

  it('(grace period) for 24 h the end keeps its staff password and join link; no other event and not the lead passcode may take that password', async () => {
    expect(psql(`select (staff_password_hash is not null)::text || '/' || (ended_password_hash is null)::text || '/' || (invite_code_sha256 is not null)::text || '/' || (invite_expires_at is not null)::text from public.events where id = '${e.event.id}'`)).toBe('true/true/true/true');
    // Sign-in compares it (a held event: its match is the Ended answer).
    const secrets = JSON.parse(psql('select public.lp_auth_secrets()::text')) as { events: Array<{ id: string; stage: string }> };
    expect(secrets.events.find((x) => x.id === e.event.id)).toMatchObject({ stage: 'archived' });
    // The lead sees what a Reopen keeps, and until when.
    const lead = await leadCookie();
    const got = await api<{ event: EventAdmin }>(`/api/events/${e.event.id}`, { cookie: lead });
    expect(got.body.event).toMatchObject({ stage: 'archived', hasStaffPassword: true });
    expect(got.body.event.joinLinkExpiresAt).not.toBeNull();
    expect(Date.parse(got.body.event.holdUntil!) - Date.parse(got.body.event.endedAt!)).toBe(24 * 3600_000);
    // The uniqueness rule counts it as running: another event may not take its password, nor may the lead passcode.
    const other = await makeEvent({ practice: true });
    archivedAtEnd.push(other.event.id);
    const clash = await api(`/api/events/${other.event.id}/password`, { json: { password: e.password }, cookie: lead });
    expect(clash.status).toBe(422);
    expect(clash.body.error).toMatchObject({ code: 'invalid', field: 'password' });
    const asLead = await api('/api/org/lead-passcode', { json: { passcode: e.password }, cookie: lead });
    expect(asLead.status).toBe(422);
    expect(asLead.body.error).toMatchObject({ code: 'invalid', field: 'passcode' });
    // And an archived event takes no new password or link (Reopen first).
    const pw = await api(`/api/events/${e.event.id}/password`, { json: { password: `pw-${uniq()}-${uniq()}` }, cookie: lead });
    expect(pw.status).toBe(409);
    expect(pw.body.error).toMatchObject({ code: 'conflict', field: 'password' });
    const link = await api(`/api/events/${e.event.id}/join-link`, { json: {}, cookie: lead });
    expect(link.status).toBe(409);
    expect(link.body.error).toMatchObject({ code: 'conflict', field: 'invite' });
  });

  it('(grace period) held: sign-in with its password or its join link → 410 event_ended with the Ended screen\'s event; nobody is signed in', async () => {
    const res = await api('/api/session', { json: { staffName: pii(`TEST-S Late ${uniq()}`), team: 'Site Ops', password: e.password }, headers: { 'x-real-ip': await ip() } });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatchObject({ code: 'event_ended', event: { id: e.event.id, name: e.event.name, stage: 'archived', logoUrl: null } });
    expect(setCookies(res.headers)).toEqual([]);
    const viaLink = await api('/api/session', { json: { staffName: pii(`TEST-S Late ${uniq()}`), team: 'Site Ops', invite: oldLink }, headers: { 'x-real-ip': await ip() } });
    expect(viaLink.status).toBe(410);
    expect(viaLink.body.error).toMatchObject({ code: 'event_ended', event: { id: e.event.id, stage: 'archived' } });
    expect(setCookies(viaLink.headers)).toEqual([]);
    // Still held: nothing was cleared by those sign-ins.
    expect(psql(`select staff_password_hash is not null and invite_code_sha256 is not null from public.events where id = '${e.event.id}'`)).toBe('t');
  });

  it('after 24 h: the first sign-in clears it (lazily); the old password is a wrong password (401); its old join link → 410 event_ended by its slug; no cookie', async () => {
    // 25 hours after the end (the clock moved the way these tests move it: the row's time goes back).
    psql(`update public.events set ended_at = ended_at - interval '25 hours' where id = '${e.event.id}'`);
    expect(psql(`select staff_password_hash is not null from public.events where id = '${e.event.id}'`)).toBe('t');
    const res = await api('/api/session', { json: { staffName: pii(`TEST-S Late ${uniq()}`), team: 'Site Ops', password: e.password }, headers: { 'x-real-ip': await ip() } });
    expect(res.status).toBe(401);
    // Cleared by that sign-in; the hash is kept apart for the lead passcode check only.
    expect(psql(`select (staff_password_hash is null)::text || '/' || (ended_password_hash is not null)::text || '/' || (invite_code_sha256 is null)::text || '/' || (invite_expires_at is null)::text from public.events where id = '${e.event.id}'`)).toBe('true/true/true/true');
    expect((await api<{ event: EventAdmin }>(`/api/events/${e.event.id}`, { cookie: await leadCookie() })).body.event).toMatchObject({ hasStaffPassword: false, joinLinkExpiresAt: null, holdUntil: null });
    expect(res.body.error).toMatchObject({ code: 'unauthorized', field: 'password' });
    expect(setCookies(res.headers)).toEqual([]);
    // The old join link: its code is gone, its slug names the event.
    const viaIp = await ip();
    const viaLink = await api('/api/session', { json: { staffName: pii(`TEST-S Late ${uniq()}`), team: 'Site Ops', invite: oldLink }, headers: { 'x-real-ip': viaIp } });
    expect(viaLink.status).toBe(410);
    expect(viaLink.body.error).toMatchObject({ code: 'event_ended', event: { name: e.event.name, stage: 'archived', logoUrl: null } });
    expect(setCookies(viaLink.headers)).toEqual([]);
    // No credential was verified: it counts as a failed attempt (it can never reset the rate limit).
    expect(psql(`select string_agg(coalesce(ok::text, 'pending'), ',') from public.lp_login_attempts where ip = '${viaIp}'`)).toBe('false');
    // A link of a running event's slug with a wrong code is still just refused.
    const running = await api('/api/session', { json: { staffName: pii(`TEST-S Late ${uniq()}`), team: 'Site Ops', invite: `${TEST_EVENT_SLUG}.${'A'.repeat(43)}` }, headers: { 'x-real-ip': await ip() } });
    expect(running.status).toBe(401);
  });

  it('reopen after 24 h: archived → live, writable again, numbering continues; its password and join link are gone; only from archived', async () => {
    const lead = await leadCookie();
    const reopened = await api<{ event: EventAdmin }>(`/api/events/${e.event.id}/reopen`, { json: {}, cookie: lead });
    expect(reopened.status).toBe(200);
    expect(reopened.body.event).toMatchObject({ stage: 'live', endedAt: null, hasStaffPassword: false, joinLinkExpiresAt: null });
    expect(psql(`select (reopened_at > now() - interval '1 minute')::text || '/' || (staff_password_hash is null)::text || '/' || (invite_code_sha256 is null)::text from public.events where id = '${e.event.id}'`)).toBe('true/true/true');
    // Sessions still open carry on; nobody new signs in until a lead sets a password again.
    expect((await create(cookie)).caseNumber).toBe(2);
    expect((await signIn(newStaff('Site Ops'), e.password)).status).toBe(401);
    expect((await api(`/api/events/${e.event.id}/password`, { json: { password: e.password }, cookie: lead })).status).toBe(200);
    expect((await signIn(newStaff('Site Ops'), e.password)).info.eventId).toBe(e.event.id);
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
      // (Events review) The telemetry kill switch, both ways.
      ['POST', '/api/telemetry/settings', { enabled: false }],
      ['POST', '/api/telemetry/settings', { enabled: true }],
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
  it('a staff password may not be the lead passcode or another running or held event\'s; an ended event\'s is free again after 24 h', async () => {
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
    // Once one has ended its password stays taken for 24 h (a Reopen would bring it back); after that it is free
    // again, and the running event wins at sign-in.
    expect((await api(`/api/events/${one.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    expect((await set(two.event.id, one.password)).status).toBe(422);
    psql(`update public.events set ended_at = ended_at - interval '25 hours' where id = '${one.event.id}'`);
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

  it('removing an ended event\'s password inside its 24 h retires the held hash, as the clearing after 24 h does', async () => {
    const lead = await leadCookie();
    const ended = await makeEvent();
    archivedAtEnd.push(ended.event.id);
    expect((await api(`/api/events/${ended.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    // Held: still the event's own hash (compared by digest; no hash is printed).
    const before = psql(`select md5(staff_password_hash) from public.events where id = '${ended.event.id}'`);
    expect(before).toMatch(/^[0-9a-f]{32}$/);
    const off = await api<{ event: EventAdmin }>(`/api/events/${ended.event.id}/password`, { method: 'DELETE', cookie: lead });
    expect(off.status).toBe(200);
    expect(off.body.event).toMatchObject({ stage: 'archived', hasStaffPassword: false });
    expect(psql(`select (staff_password_hash is null)::text || '/' || md5(coalesce(ended_password_hash, '')) from public.events where id = '${ended.event.id}'`)).toBe(`true/${before}`);
    // Past the 24 h (nothing is left for the clearing to move), the lead passcode still may not be it.
    psql(`update public.events set ended_at = ended_at - interval '25 hours' where id = '${ended.event.id}'`);
    expect(psql(`select public.lp_event_release_held('${ended.event.id}')`)).toBe('0');
    const asLead = await api('/api/org/lead-passcode', { json: { passcode: ended.password }, cookie: lead });
    expect(asLead.status).toBe(422);
    expect(asLead.body.error).toMatchObject({ code: 'invalid', field: 'passcode' });
  });
});

describe('reopen never captures another event\'s staff', () => {
  it('B takes archived A\'s password; A is reopened; B\'s staff still land in B, and A\'s old link is off', async () => {
    const lead = await leadCookie();
    const a = await makeEvent();
    const b = await makeEvent({ practice: true });
    archivedAtEnd.push(a.event.id, b.event.id);
    const link = await api<{ link: string }>(`/api/events/${a.event.id}/join-link`, { json: {}, cookie: lead });
    expect(link.status).toBe(201);
    const token = decodeURIComponent(new URL(link.body.link).hash.slice('#join='.length));
    expect((await api(`/api/events/${a.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    // A's password is free once A's 24 h are over: B takes it.
    expect((await api(`/api/events/${b.event.id}/password`, { json: { password: a.password }, cookie: lead })).status).toBe(422);
    psql(`update public.events set ended_at = ended_at - interval '25 hours' where id = '${a.event.id}'`);
    expect((await api(`/api/events/${b.event.id}/password`, { json: { password: a.password }, cookie: lead })).status).toBe(200);
    const reopened = await api<{ event: EventAdmin }>(`/api/events/${a.event.id}/reopen`, { json: {}, cookie: lead });
    expect(reopened.status).toBe(200);
    expect(reopened.body.event).toMatchObject({ stage: 'live', hasStaffPassword: false, joinLinkExpiresAt: null });
    // A (older, now live) would have matched first; its hash is gone, so the password is B's alone.
    const who = await signIn(newStaff('Site Ops'), a.password);
    expect(who.status).toBe(200);
    expect(who.info.eventId).toBe(b.event.id);
    // A's join link from before the end no longer opens anything.
    const viaLink = await api('/api/session', { json: { staffName: pii(`TEST-S Link ${uniq()}`), team: 'Site Ops', invite: token }, headers: { 'x-real-ip': await ip() } });
    expect(viaLink.status).toBe(401);
    // Giving A its old password back now goes through the rule: B (practice) holds it.
    const clash = await api(`/api/events/${a.event.id}/password`, { json: { password: a.password }, cookie: lead });
    expect(clash.status).toBe(422);
    expect(clash.body.error).toMatchObject({ field: 'password' });
  });
});

describe('(grace period) End by mistake, Reopen inside 24 h: the same password and join link', () => {
  it('reopened 23 h after the end: live again with both kept; staff sign in with what they have and find their requests', async () => {
    const lead = await leadCookie();
    const e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    const link = await api<{ link: string; expiresAt: string }>(`/api/events/${e.event.id}/join-link`, { json: {}, cookie: lead });
    expect(link.status).toBe(201);
    const token = decodeURIComponent(new URL(link.body.link).hash.slice('#join='.length));
    const staff = newStaff('Site Ops');
    const before = await create((await signIn(staff, e.password)).cookie);
    expect((await api(`/api/events/${e.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    psql(`update public.events set ended_at = ended_at - interval '23 hours' where id = '${e.event.id}'`);
    const shown = (await api<{ event: EventAdmin }>(`/api/events/${e.event.id}`, { cookie: lead })).body.event;
    expect(shown).toMatchObject({ stage: 'archived', hasStaffPassword: true });
    expect(Date.parse(shown.joinLinkExpiresAt!)).toBe(Date.parse(link.body.expiresAt));
    const left = Date.parse(shown.holdUntil!) - Date.now();
    expect(left).toBeGreaterThan(55 * 60_000);
    expect(left).toBeLessThanOrEqual(3600_000);

    const reopened = await api<{ event: EventAdmin }>(`/api/events/${e.event.id}/reopen`, { json: {}, cookie: lead });
    expect(reopened.status).toBe(200);
    expect(reopened.body.event).toMatchObject({ stage: 'live', endedAt: null, holdUntil: null, hasStaffPassword: true });
    expect(Date.parse(reopened.body.event.joinLinkExpiresAt!)).toBe(Date.parse(link.body.expiresAt));
    const again = await signIn(staff, e.password);
    expect(again.status).toBe(200);
    expect(again.info.eventId).toBe(e.event.id);
    expect((await sync(again.cookie)).rows.map((r) => r.id)).toContain(before.id);
    const viaLink = await api<SessionInfo>('/api/session', { json: { staffName: pii(`TEST-S Link ${uniq()}`), team: 'Site Ops', invite: token }, headers: { 'x-real-ip': await ip() } });
    expect(viaLink.status).toBe(200);
    expect(viaLink.body.eventId).toBe(e.event.id);
    expect((await create(again.cookie)).caseNumber).toBe(before.caseNumber + 1);
  });

  it('reopened 25 h after the end with no sign-in in between: the reopen itself clears both (lazily) and needs new ones', async () => {
    const lead = await leadCookie();
    const e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    expect((await api(`/api/events/${e.event.id}/join-link`, { json: {}, cookie: lead })).status).toBe(201);
    expect((await api(`/api/events/${e.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    psql(`update public.events set ended_at = ended_at - interval '25 hours' where id = '${e.event.id}'`);
    // Nothing cleared it yet (files run one at a time; nobody signed in since).
    expect(psql(`select staff_password_hash is not null and invite_code_sha256 is not null from public.events where id = '${e.event.id}'`)).toBe('t');
    const reopened = await api<{ event: EventAdmin }>(`/api/events/${e.event.id}/reopen`, { json: {}, cookie: lead });
    expect(reopened.status).toBe(200);
    expect(reopened.body.event).toMatchObject({ stage: 'live', hasStaffPassword: false, joinLinkExpiresAt: null, holdUntil: null });
    expect(psql(`select (staff_password_hash is null)::text || '/' || (ended_password_hash is not null)::text || '/' || (invite_code_sha256 is null)::text from public.events where id = '${e.event.id}'`)).toBe('true/true/true');
    expect((await signIn(newStaff('Site Ops'), e.password)).status).toBe(401);
  });

  it('the auto-close job clears holds over 24 h old and leaves younger ones', async () => {
    const lead = await leadCookie();
    const old = await makeEvent();
    const young = await makeEvent();
    archivedAtEnd.push(old.event.id, young.event.id);
    for (const x of [old, young]) {
      expect((await api(`/api/events/${x.event.id}/join-link`, { json: {}, cookie: lead })).status).toBe(201);
      expect((await api(`/api/events/${x.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    }
    psql(`update public.events set ended_at = ended_at - interval '24 hours 1 minute' where id = '${old.event.id}'`);
    psql(`update public.events set ended_at = ended_at - interval '23 hours 59 minutes' where id = '${young.event.id}'`);
    // The function pg_cron runs every 5 minutes; an empty request list so it closes no other test's (or the seed's)
    // requests here. The clearing runs whatever the list.
    psql(`select public.lp_close_inactive(array[]::uuid[])`);
    const state = (id: string) => psql(`select (staff_password_hash is null)::text || '/' || (ended_password_hash is null)::text || '/' || (invite_code_sha256 is null)::text || '/' || (invite_expires_at is null)::text from public.events where id = '${id}'`);
    expect(state(old.event.id)).toBe('true/false/true/true');
    expect(state(young.event.id)).toBe('false/true/false/false');
    // Run again: nothing more to do.
    expect(psql('select public.lp_event_release_held()')).toBe('0');
  });

  it('sign-in cost: an event that ended long ago is never compared, even if its hash were still there', async () => {
    const lead = await leadCookie();
    const e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    expect((await api(`/api/events/${e.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    // Ended 30 days ago, hash still in place (no sign-in, reopen or job since): listed for nobody.
    psql(`update public.events set ended_at = ended_at - interval '30 days' where id = '${e.event.id}'`);
    const listed = (sql: string) => (JSON.parse(psql(sql)) as { events: Array<{ id: string }> }).events.map((x) => x.id);
    expect(psql(`select (stage = 'archived' and staff_password_hash is not null and not public.lp_event_held(e, clock_timestamp()))::text from public.events e where e.id = '${e.event.id}'`)).toBe('true');
    expect(listed('select public.lp_auth_secrets()::text')).not.toContain(e.event.id);
    // Every event sign-in compares is running or ended under 24 h ago.
    const kinds = psql(`select string_agg(distinct case when e.stage <> 'archived' then 'running' when e.ended_at > now() - interval '24 hours' then 'held' else 'old' end, ',')
                          from public.events e where e.id in (select (x ->> 'id')::uuid from jsonb_array_elements(public.lp_auth_secrets() -> 'events') x)`);
    expect(kinds.split(',').sort().filter((k) => k === 'old')).toEqual([]);
    // And it was cleared on the way (the hash kept apart for the lead passcode check only).
    expect(psql(`select (staff_password_hash is null)::text || '/' || (ended_password_hash is not null)::text from public.events where id = '${e.event.id}'`)).toBe('true/true');
  });

  it('a reopen while another event is being given that password: never two running events with one password', async () => {
    const lead = await leadCookie();
    const a = await makeEvent();
    const b = await makeEvent({ practice: true });
    archivedAtEnd.push(a.event.id, b.event.id);
    expect((await api(`/api/events/${a.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    // B is refused A's password while A holds it.
    expect((await api(`/api/events/${b.event.id}/password`, { json: { password: a.password }, cookie: lead })).status).toBe(422);
    // A write whose check did not see A's hash (it ran when A's was not in force) is refused under the lock: the app
    // server then checks again. Here: B's check list leaves A's held hash out.
    const bcrypt = (await import('bcryptjs')).default;
    const hashOfA = await bcrypt.hash(a.password, 4);
    const aHash = psql(`select staff_password_hash from public.events where id = '${a.event.id}'`);
    const others = psql(`select coalesce(string_agg(quote_literal(h), ','), '') from (
                           select o.lead_passcode_hash h from public.lp_org o where o.id
                           union all select e.staff_password_hash from public.events e
                            where e.id not in ('${a.event.id}', '${b.event.id}') and e.staff_password_hash is not null
                              and (e.stage <> 'archived' or public.lp_event_held(e, clock_timestamp()))) x`);
    const stale = `array[${others}]::text[]`;
    expect(() => psql(`select public.lp_event_set_password('${b.event.id}', '${hashOfA}', ${stale})`)).toThrow(/secrets_changed/);
    // Reopen holds the lock while it decides: a write racing it waits, then sees A running with its password.
    const reopen = psqlAsync(`begin; select public.lp_event_reopen('${a.event.id}'); select pg_sleep(1.5); commit;`);
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    const racing = psqlAsync(`select public.lp_event_set_password('${b.event.id}', '${hashOfA}', ${stale})`);
    const [r1, r2] = await Promise.all([reopen.done, racing.done]);
    expect(r1.code).toBe(0);
    expect(r2.code).not.toBe(0);
    expect(r2.out).toMatch(/secrets_changed/);
    expect(Date.now() - t0).toBeGreaterThan(700);
    // A is live with its own password; B kept its own; sign-in with A's lands in A.
    expect(psql(`select stage || '/' || (staff_password_hash = '${aHash}')::text from public.events where id = '${a.event.id}'`)).toBe('live/true');
    expect(await bcrypt.compare(a.password, psql(`select staff_password_hash from public.events where id = '${b.event.id}'`))).toBe(false);
    expect((await signIn(newStaff('Site Ops'), a.password)).info.eventId).toBe(a.event.id);
    // Through the route (check, then the locked write), B is still refused: A is running with it.
    expect((await api(`/api/events/${b.event.id}/password`, { json: { password: a.password }, cookie: lead })).status).toBe(422);
  });
});

describe('a lead passcode change signs every lead out', () => {
  afterAll(async () => {
    await ensureTestEvent();
  });

  it('old lead sessions get 401 with the cookie cleared; the lead who changed it carries on', async () => {
    const minted = await leadCookie();
    const res = await api('/api/session', { json: { staffName: pii(`TEST-S Lead ${uniq()}`), team: 'Medical', password: LEAD_PASSCODE }, headers: { 'x-real-ip': await ip() } });
    expect(res.status).toBe(200);
    const signedIn = setCookies(res.headers)[0]!.split(';')[0]!;
    expect((await api('/api/events', { cookie: signedIn })).status).toBe(200);
    const version = Number(psql('select lead_passcode_version from public.lp_org'));

    const changed = await api('/api/org/lead-passcode', { json: { passcode: pii(`lead-${uniq()}-${uniq()}`) }, cookie: signedIn });
    expect(changed.status).toBe(200);
    expect(Number(psql('select lead_passcode_version from public.lp_org'))).toBe(version + 1);
    const reissued = setCookies(changed.headers)[0]!.split(';')[0]!;
    expect((await api('/api/events', { cookie: reissued })).status).toBe(200);

    for (const [label, cookie] of [['the changing lead\'s old cookie', signedIn], ['another lead', minted]] as const) {
      const out = await api('/api/events', { cookie });
      expect(out.status, label).toBe(401);
      expect(setCookies(out.headers)[0], label).toMatch(/^lp_session=;/);
      expect((await api<SessionInfo>('/api/session', { cookie })).status, label).toBe(401);
    }
    // A token with a version from the future is refused the same way; staff sessions are untouched.
    expect((await api('/api/events', { cookie: await cookieFor(newStaff(), { role: 'lead', pv: version + 5 }) })).status).toBe(401);
    expect((await api('/api/sync', { cookie: await cookieFor(newStaff()) })).status).toBe(200);
  });
});

describe('event settings and the requests that use them', () => {
  it('a renamed post takes its requests along; a post or team in use cannot be removed; an ended event\'s setup is frozen', async () => {
    const lead = await leadCookie();
    const e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    const staffCookie = (await signIn(newStaff('Site Ops'), e.password)).cookie;
    const r = await create(staffCookie);
    const patch = (json: unknown) => api<{ event: EventAdmin; error?: { code: string; field?: string } }>(`/api/events/${e.event.id}`, { method: 'PATCH', json, cookie: lead });

    // Rename "Main Stage Tent" (same id): the request moves with it, in stats too, and stays editable.
    const renamed = [{ id: 'main', label: 'Main Tent', short: 'Main' }, POSTS[1]!];
    expect((await patch({ posts: renamed })).status).toBe(200);
    const row = (await api(`/api/requests/${r.id}`, { cookie: staffCookie })).body as RequestSummary;
    expect(row.reportingLocation).toBe('Main Tent');
    expect(row.rowVersion).toBeGreaterThan(r.rowVersion);
    const stats = (await api<EventStats>('/api/stats?range=event', { cookie: staffCookie })).body;
    expect(stats.range!.posts).toEqual([{ post: 'Main', n: 1 }]);
    const edit = await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { expectedVersion: row.rowVersion, patch: { hair: 'Red', reportingLocation: 'Main Tent' } }, cookie: staffCookie });
    expect(edit.status, edit.text).toBe(200);
    // Two posts swap labels: the requests swap with them (one statement).
    expect((await patch({ posts: [{ id: 'main', label: 'North Gate', short: 'North' }, { id: 'north', label: 'Main Tent', short: 'Main' }] })).status).toBe(200);
    expect(psql(`select reporting_location from public.patients where id = '${r.id}'`)).toBe('North Gate');

    // Removing the post in use: refused, with the field. An unused one goes.
    const inUse = await patch({ posts: [{ id: 'north', label: 'Main Tent', short: 'Main' }] });
    expect(inUse.status).toBe(422);
    expect(inUse.body.error).toMatchObject({ code: 'invalid', field: 'posts' });
    expect((await patch({ posts: [{ id: 'main', label: 'North Gate', short: 'North' }] })).status).toBe(200);
    // A team in use (the request was logged by Site Ops) cannot go; an unused one can.
    const teamInUse = await patch({ teams: [TEAMS[1]] });
    expect(teamInUse.status).toBe(422);
    expect(teamInUse.body.error).toMatchObject({ code: 'invalid', field: 'teams' });
    expect((await patch({ teams: [...TEAMS, { id: 'spare', label: 'Spare Crew' }] })).status).toBe(200);
    expect((await patch({ teams: TEAMS })).status).toBe(200);

    // Ended: posts, teams, Main Med, chips, time zone, show-day start and dates are frozen; the name is not.
    expect((await api(`/api/events/${e.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    const current = (await api<{ event: EventAdmin }>(`/api/events/${e.event.id}`, { cookie: lead })).body.event;
    const frozen: Array<[string, Record<string, unknown>]> = [
      ['posts', { posts: [...current.posts, { id: 'extra', label: 'Extra Post' }] }],
      ['teams', { teams: [...current.teams, { id: 'extra', label: 'Extra Crew' }] }],
      ['mainMedical', { mainMedical: 'Big Med' }],
      ['lastSeen', { lastSeen: ['Somewhere else'] }],
      ['timezone', { timezone: 'America/Denver' }],
      ['dayStartHour', { dayStartHour: 9 }],
      ['startsOn', { startsOn: dayShift(current.startsOn, -1) }],
      ['endsOn', { endsOn: dayShift(current.endsOn, 1) }],
    ];
    for (const [field, body] of frozen) {
      const res = await patch(body);
      expect(res.status, field).toBe(409);
      expect(res.body.error, field).toMatchObject({ code: 'conflict', field });
    }
    // The same values again are fine, and the name may change.
    expect((await patch({ posts: current.posts, teams: current.teams, timezone: current.timezone })).status).toBe(200);
    const named = await patch({ name: pii(`TEST-S Renamed ${uniq()}`) });
    expect(named.status).toBe(200);
    expect(psql(`select timezone || '/' || jsonb_array_length(posts) from public.events where id = '${e.event.id}'`)).toBe(`${current.timezone}/1`);
  });
});

describe('(phase 2) X-LP-Event: a tab never writes into another event than the one it works', () => {
  it("a request naming another event than the cookie's is refused (409 wrong_event); its own, none, or GET /api/session are not", async () => {
    const a = await makeEvent();
    const b = await makeEvent();
    archivedAtEnd.push(a.event.id, b.event.id);
    const cookie = (await signIn(newStaff('Site Ops'), b.password)).cookie;
    const as = (event: string) => ({ cookie, headers: { 'x-lp-event': event } });
    const wrong = await api('/api/requests', { json: createBody({ reportingLocation: 'Main Stage Tent' }), ...as(a.event.id) });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('wrong_event');
    expect((await sync(cookie)).rows).toHaveLength(0);
    expect((await api('/api/sync', as(a.event.id))).body.error.code).toBe('wrong_event');
    // The session check answers whatever the header says: that is how the tab learns the cookie's event.
    const who = await api<SessionInfo>('/api/session', as(a.event.id));
    expect(who.status).toBe(200);
    expect(who.body.eventId).toBe(b.event.id);
    // Its own event, or 'none' (a tab that knows no event yet), go through.
    expect((await api('/api/requests', { json: createBody({ reportingLocation: 'Main Stage Tent' }), ...as(b.event.id) })).status).toBe(201);
    expect((await api('/api/sync', as('none'))).status).toBe(200);
  });

  it("(cut-over fix A1) no header at all (the old build's app) is refused like a wrong one; the headerless routes still answer", async () => {
    const e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    const cookie = (await signIn(newStaff('Site Ops'), e.password)).cookie;
    const bare = { cookie, event: false as const };
    // A write (the old outbox's create, with a post this event has) and the old app's poll.
    const write = await api('/api/requests', { json: createBody({ reportingLocation: 'Main Stage Tent' }), ...bare });
    expect(write.status).toBe(409);
    expect(write.body.error.code).toBe('wrong_event');
    const poll = await api('/api/sync', bare);
    expect(poll.status).toBe(409);
    expect(poll.body.error.code).toBe('wrong_event');
    expect(psql(`select count(*) from public.patients where event_id = '${e.event.id}'`)).toBe('0');
    // The session check needs no event: the old app still learns who is signed in (and the new app which event).
    expect((await api<SessionInfo>('/api/session', bare)).body.eventId).toBe(e.event.id);
    // With the cookie's event, as the new client sends it: as before.
    expect((await api('/api/requests', { json: createBody({ reportingLocation: 'Main Stage Tent' }), cookie, event: e.event.id })).status).toBe(201);
    expect((await api('/api/sync', { cookie, event: e.event.id })).status).toBe(200);
    // The routes whose calls cannot carry the header (an <img src>, sendBeacon, the service worker) answer without it.
    const photo = await api(`/api/photos/${randomUUID()}`, bare);
    expect(photo.status).toBe(404);
    expect(photo.body.error.code).toBe('not_found');
    const beacon = await api('/api/telemetry', { body: 'not a batch', headers: { 'content-type': 'text/plain' }, ...bare });
    expect(beacon.body?.error?.code ?? null).not.toBe('wrong_event');
    expect([200, 204, 400, 415, 422]).toContain(beacon.status);
    const resubscribe = await api('/api/push/subscribe', { json: { endpoint: 'https://push.invalid/x', keys: { p256dh: 'x', auth: 'y' } }, ...bare });
    expect(resubscribe.body?.error?.code ?? null).not.toBe('wrong_event');
    expect(resubscribe.status).not.toBe(409);
    // …but never for another event than the cookie's.
    expect((await api(`/api/photos/${randomUUID()}`, { cookie, event: EVENT_ID })).status).toBe(409);
  });
});

describe('(phase 2) a renamed team stays that team', () => {
  it('renaming the medical team (same id) keeps "Medical asked" for messages stored, and sessions signed in, under the old label', async () => {
    const lead = await leadCookie();
    const e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    const patch = (json: unknown) => api<{ event: EventAdmin }>(`/api/events/${e.event.id}`, { method: 'PATCH', json, cookie: lead });
    const foh = (await signIn(newStaff('Site Ops'), e.password)).cookie;
    // Signed in under the medical team's label before the rename (the session keeps it).
    const medic = (await signIn(newStaff('Medics'), e.password)).cookie;
    const r1 = await create(foh);
    const r2 = await create(foh);
    const ask = (cookie: string, id: string) =>
      api(`/api/requests/${id}/messages`, { json: { body: 'Wristband colour?', clientMutationId: randomUUID() }, cookie });
    expect((await ask(medic, r1.id)).status).toBe(201);
    const needsInfo = async (id: string) => (await sync(foh)).rows.find((x) => x.id === id)?.needsInfo;
    expect(await needsInfo(r1.id)).toBe(true);

    // Rename it under the same id.
    const renamed = await patch({ teams: [TEAMS[0], { id: 'med', label: 'First Aid', short: 'Aid', medical: true }] });
    expect(renamed.status, renamed.text).toBe(200);
    expect(renamed.body.event.teams.find((t) => t.id === 'med')).toMatchObject({ label: 'First Aid', aliases: ['Medics'] });
    // The message stored under "Medics" still counts as Medical asked.
    expect(await needsInfo(r1.id)).toBe(true);
    // A session still signed in as "Medics" asks again: it counts too.
    expect((await ask(medic, r2.id)).status).toBe(201);
    expect(await needsInfo(r2.id)).toBe(true);
    // A new sign-in with the old label lands in the renamed team, spelled the new way.
    expect((await signIn(newStaff('Medics'), e.password)).info.team).toBe('First Aid');
    // Staff see the earlier label in their config (the medical side of the app knows it).
    expect((await api<SessionInfo>('/api/session', { cookie: foh })).body.event?.teams.find((t) => t.id === 'med')?.aliases).toEqual(['Medics']);
    // The team (old label in use) can't be removed; sending the teams back as read (aliases included) is fine.
    const current = (await api<{ event: EventAdmin }>(`/api/events/${e.event.id}`, { cookie: lead })).body.event;
    expect((await patch({ teams: current.teams })).status).toBe(200);
    const gone = await patch({ teams: [TEAMS[0]] });
    expect(gone.status).toBe(422);
    // Renamed back: no alias left for its own label.
    const back = await patch({ teams: [TEAMS[0], { id: 'med', label: 'Medics', short: 'Med', medical: true }] });
    expect(back.body.event.teams.find((t) => t.id === 'med')).toMatchObject({ label: 'Medics', aliases: ['First Aid'] });
  });
});

describe('the auto-close after a reopen', () => {
  it('counts inactivity from the reopen, not from before the end', async () => {
    const lead = await leadCookie();
    const e = await makeEvent();
    archivedAtEnd.push(e.event.id);
    const staffCookie = (await signIn(newStaff('Site Ops'), e.password)).cookie;
    const r = await create(staffCookie);
    const located = await api(`/api/requests/${r.id}/status`, { json: { status: STATUS.inMedical, expectedVersion: r.rowVersion, kind: 'answer' }, cookie: staffCookie });
    expect(located.status, located.text).toBe(200);
    // Idle for three hours before the event ended.
    psql(`update public.audit_events set occurred_at = occurred_at - interval '3 hours' where patient_id = '${r.id}';
          update public.patients set created_at = created_at - interval '3 hours' where id = '${r.id}'`);
    expect((await api(`/api/events/${e.event.id}/end`, { json: {}, cookie: lead })).status).toBe(200);
    expect((await api(`/api/events/${e.event.id}/reopen`, { json: {}, cookie: lead })).status).toBe(200);
    // Just reopened: not idle yet, whatever happened before the end.
    expect(psql(`select public.lp_close_inactive(array['${r.id}']::uuid[])`)).toBe('0');
    expect(psql(`select status from public.patients where id = '${r.id}'`)).toBe(STATUS.inMedical);
    // Reopened two hours ago and still untouched: closed, idle since the reopen.
    psql(`update public.events set reopened_at = now() - interval '2 hours' where id = '${e.event.id}'`);
    expect(psql(`select public.lp_close_inactive(array['${r.id}']::uuid[])`)).toBe('1');
    expect(psql(`select status from public.patients where id = '${r.id}'`)).toBe(STATUS.inactive);
    expect(psql(`select (abs(extract(epoch from c.idle_since - e.reopened_at)) < 1)::text from public.lp_inactive_closes c join public.events e on e.id = '${e.event.id}' where c.request_id = '${r.id}'`)).toBe('true');
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
  // The lead passcode goes in on stdin (never the command line or the environment).
  const run = async (env: Record<string, string>, args: string[] = [], passcode?: string) => {
    const { spawnSync } = await import('node:child_process');
    const base = loadTestEnv();
    return spawnSync(process.execPath, [join(ROOT, 'scripts', 'bootstrap-events.mjs'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input: passcode === undefined ? '' : `${passcode}\n`,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NEXT_PUBLIC_SUPABASE_URL: base.NEXT_PUBLIC_SUPABASE_URL!, SUPABASE_SECRET_KEY: base.SUPABASE_SECRET_KEY!, ...env } as unknown as NodeJS.ProcessEnv,
    });
  };
  const bcrypt = async () => (await import('bcryptjs')).default;

  afterAll(async () => {
    psql(`update public.events set staff_password_hash = null, ended_password_hash = null, invite_code_sha256 = null, invite_expires_at = null where slug = 'edco26'`);
    await ensureTestEvent();
  });

  it('sets the lead passcode and records the EDC staff password as retired (never a way in), printing neither', async () => {
    const lead = pii(`boot-lead-${uniq()}-${uniq()}`);
    const edcPassword = pii(`boot-edc-${uniq()}-${uniq()}`);
    const code = pii(`boot-code-${uniq()}`);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(code, 'utf8').digest('hex');
    const env = { APP_SHARED_PASSWORD: edcPassword, INVITE_CODE_SHA256: sha, INVITE_EXPIRES_AT: '2026-11-09T12:00:00Z' };

    // Already set (the test setups set it): refused without --force; a dry run writes nothing.
    const refused = await run(env, [], lead);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('already set');
    const dry = await run(env, ['--dry-run', '--force'], lead);
    expect(dry.status, dry.stderr).toBe(0);
    expect(psql(`select staff_password_hash is null and ended_password_hash is null from public.events where slug = 'edco26'`)).toBe('t');
    // Never from the environment (it would sit in shell history and process listings), nor an empty stdin.
    const fromEnv = await run({ ...env, LP_LEAD_PASSCODE: lead }, ['--force'], lead);
    expect(fromEnv.status).toBe(1);
    expect(fromEnv.stderr).toContain('LP_LEAD_PASSCODE is not read');
    // Nor from the command line: any other argument is refused without being echoed.
    const fromArgv = await run(env, ['--force', lead], lead);
    expect(fromArgv.status).toBe(1);
    expect(fromArgv.stderr).toContain('only --dry-run and --force');
    expect(fromArgv.stdout + fromArgv.stderr).not.toContain(lead);
    const empty = await run(env, ['--force']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('at least 8 characters');
    expect(psql(`select staff_password_hash is null and ended_password_hash is null from public.events where slug = 'edco26'`)).toBe('t');

    const res = await run(env, ['--force'], lead);
    expect(res.status, res.stderr).toBe(0);
    const printed = res.stdout + res.stderr;
    for (const secret of [lead, edcPassword, code, sha]) expect(printed).not.toContain(secret);
    expect(printed).not.toMatch(/\$2[aby]\$/);
    const b = await bcrypt();
    expect(await b.compare(lead, psql('select lead_passcode_hash from public.lp_org'))).toBe(true);
    // (Phase 3) Archived EDC keeps no staff password or join link: the old password is kept apart (ended_password_hash),
    // for the lead passcode check only. INVITE_* are no longer read.
    expect(psql(`select (staff_password_hash is null)::text || '/' || (invite_code_sha256 is null)::text from public.events where slug = 'edco26'`)).toBe('true/true');
    expect(await b.compare(edcPassword, psql(`select ended_password_hash from public.events where slug = 'edco26'`))).toBe(true);

    // The old EDC password is a wrong password; an old EDC link (no slug: made before events) is not accepted; a link
    // with EDC's slug reaches the Ended screen; the lead passcode signs in as lead.
    const old = await api('/api/session', { json: { staffName: pii(`TEST-S Old ${uniq()}`), team: 'Medical', password: edcPassword }, headers: { 'x-real-ip': await ip() } });
    expect(old.status).toBe(401);
    const oldLink = await api('/api/session', { json: { staffName: pii(`TEST-S Old ${uniq()}`), team: 'Medical', invite: code }, headers: { 'x-real-ip': await ip() } });
    expect(oldLink.status).toBe(401);
    const slugLink = await api('/api/session', { json: { staffName: pii(`TEST-S Old ${uniq()}`), team: 'Medical', invite: `edco26.${code}` }, headers: { 'x-real-ip': await ip() } });
    expect(slugLink.status).toBe(410);
    expect(slugLink.body.error.event).toMatchObject({ name: 'EDC Orlando', stage: 'archived' });
    const asLead = await api('/api/session', { json: { staffName: pii(`TEST-S Boss ${uniq()}`), team: 'Medical', password: lead }, headers: { 'x-real-ip': await ip() } });
    expect(asLead.body).toMatchObject({ role: 'lead' });

    // A lead passcode equal to the EDC password is refused, by the bootstrap and by the app's passcode change.
    const same = await run(env, ['--force'], edcPassword);
    expect(same.status).toBe(1);
    expect(same.stderr).toContain('choose another');
    const inApp = await api('/api/org/lead-passcode', { json: { passcode: edcPassword }, cookie: await leadCookie() });
    expect(inApp.status).toBe(422);
    expect(inApp.body.error).toMatchObject({ field: 'passcode' });
  });
});

describe('event logo', () => {
  it('a lead uploads a PNG / WebP / JPEG logo; the public logo route serves its bytes from this origin; replacing or removing it deletes the old object', async () => {
    const lead = await leadCookie();
    const made = await makeEvent({ practice: true });
    archivedAtEnd.push(made.event.id);
    const { syntheticPng } = await import('../helpers/images');
    const upload = (bytes: Buffer, type: string) => {
      const f = new FormData();
      f.set('logo', new Blob([new Uint8Array(bytes)], { type }), 'logo');
      return api<{ event: EventAdmin }>(`/api/events/${made.event.id}/logo`, { method: 'POST', body: f, cookie: lead });
    };
    const objects = async () => ((await admin().storage.from('event-logos').list(made.event.id)).data ?? []).map((o) => o.name);

    const first = await upload(syntheticPng(32, 32), 'image/png');
    expect(first.status, first.text).toBe(200);
    expect(first.body.event.logoUrl).toMatch(new RegExp(`^/api/events/logo/${made.event.slug}\\?v=`));
    expect(await objects()).toHaveLength(1);
    // (Phase 2) Same-origin bytes, not a redirect: the client reads the logo's pixels and masks the rainbow with it.
    const served = await fetch(new URL(first.body.event.logoUrl!, BASE), { redirect: 'manual' });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(syntheticPng(32, 32))).toBe(true);
    // Staff see it in their config too.
    expect((await signIn(newStaff('Site Ops'), made.password)).info.event?.logoUrl).toBe(first.body.event.logoUrl);

    const second = await upload(JPEG, 'image/jpeg');
    expect(second.status).toBe(200);
    expect(second.body.event.logoUrl).not.toBe(first.body.event.logoUrl);
    expect(await objects()).toHaveLength(1);

    // Not an image, too large: refused, nothing stored.
    expect((await upload(Buffer.from('not an image at all'), 'image/png')).status).toBe(415);
    expect((await upload(Buffer.alloc(1024 * 1024 + 10, 1), 'image/png')).status).toBe(413);
    expect(await objects()).toHaveLength(1);

    const removed = await api<{ event: EventAdmin }>(`/api/events/${made.event.id}/logo`, { method: 'DELETE', cookie: lead });
    expect(removed.body.event.logoUrl).toBeNull();
    expect(await objects()).toHaveLength(0);
    expect((await api(`/api/events/logo/${made.event.slug}`)).status).toBe(404);
    expect((await api('/api/events/logo/no-such-event')).status).toBe(404);
  });
});

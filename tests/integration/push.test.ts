// Web Push, the Alerts switches and the Activity inbox through the real routes (F4, spec §18 A53–A59), against
// the local stack and a fake push service that decrypts every push (tests/integration/push-service.ts).
//   * POST /api/push/prefs, POST/DELETE /api/push/subscribe, POST /api/push/test: session, same-origin,
//     validation, defaults (Medical: New requests on), re-binding, endpoint rotation, 410 deletes.
//   * The routes notify (after the response): In medical reaches the logger (Activity row + push, initials as
//     the title, no ids or contact details), never the actor; a Not in medical answer sends NOTHING (F5 owns
//     it); new requests reach whoever has New requests on; the location completes the answer or moves it.
//   * GET /api/activity, GET /api/activity/unread, POST /api/activity/read | unread, and sync's activityUnread
//     and activityKey (no ids on a poll; the key moves with every change).
//   * Nobody can remove another person's device (DELETE, oldEndpoint); New requests is never lost to whichever
//     device of a staff member came first; an edit's event is its own author's.
//   * A hanging push service never slows the API response.
// Synthetic data only; every request is closed afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestSummary, SyncResponse } from '@/lib/api-types';
import { STATUS_META } from '@/lib/domain';
import { admin, api, cookieFor, createRequest, newStaff, staffOf, withTestServer, type Staff } from './harness';
import { eventually, startPushService, type FakeDevice, type PushService } from './push-service';

withTestServer();

let push: PushService;
beforeAll(async () => {
  push = await startPushService();
});
afterAll(async () => {
  await push?.close();
  // The shared local stack: leave no synthetic staff with "New requests" on (they would get every new
  // request of later runs) and no subscription pointing at this closed service.
  for (const table of ['lp_activity', 'lp_push_subscriptions', 'lp_push_prefs'] as const) {
    const { error } = await admin().from(table).delete().like('staff', 'test-s staff %');
    if (error) throw new Error(`cleanup ${table}: ${error.code}`);
  }
});

const canon = (s: Staff) => staffOf(s).toLowerCase();

async function subscribe(staff: Staff, device: FakeDevice, extra: Record<string, unknown> = {}) {
  const res = await api('/api/push/subscribe', { json: { endpoint: device.endpoint, keys: device.keys, ...extra }, cookie: await cookieFor(staff) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { enabled: boolean; publicKey: string; newRequests: boolean; myUpdates: boolean };
}

async function subRow(endpoint: string) {
  const { data, error } = await admin().from('lp_push_subscriptions').select('staff, team, new_requests, my_updates, failures, last_ok_at').eq('endpoint', endpoint).maybeSingle();
  if (error) throw new Error(error.code);
  return data as { staff: string; team: string; new_requests: boolean; my_updates: boolean; failures: number; last_ok_at: string | null } | null;
}

async function activityOf(staff: Staff, requestId: string) {
  const { data, error } = await admin().from('lp_activity').select('kind, actor, detail, read_at, at').eq('staff', canon(staff)).eq('request_id', requestId).maybeSingle();
  if (error) throw new Error(error.code);
  return data as { kind: string; actor: string; detail: string; read_at: string | null; at: string } | null;
}

async function setStatus(r: RequestSummary, status: string, kind: string, staff: Staff): Promise<RequestSummary> {
  const res = await api(`/api/requests/${r.id}/status`, { json: { status, expectedVersion: r.rowVersion, kind }, cookie: await cookieFor(staff) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.request as RequestSummary;
}

const medical = () => newStaff('Medical');

describe('POST /api/push/prefs', () => {
  it('needs a session and the same origin', async () => {
    expect((await api('/api/push/prefs', { json: {} })).status).toBe(401);
    expect((await api('/api/push/prefs', { json: {}, cookie: await cookieFor(newStaff()), origin: 'https://evil.example' })).status).toBe(403);
  });

  it('push is on (the test keys), with the defaults: New requests off (unless the phone bell was on, or Medical), Updates on', async () => {
    const res = await api('/api/push/prefs', { json: {}, cookie: await cookieFor(newStaff('GC/HX - Base')) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, newRequests: false, myUpdates: true });
    expect(res.body.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
    // (F6 7b, Brian 2026-11-07 02:15: Main Med gets distracted) The Medical team starts with New requests ON.
    expect((await api('/api/push/prefs', { json: {}, cookie: await cookieFor(medical()) })).body).toMatchObject({ newRequests: true, myUpdates: true });
    expect((await api('/api/push/prefs', { json: {}, cookie: await cookieFor(newStaff()) })).body).toMatchObject({ newRequests: false, myUpdates: true });
    // The phone's old "Alerts" bell is the default for a staff member seen for the first time.
    expect((await api('/api/push/prefs', { json: { bell: true }, cookie: await cookieFor(newStaff()) })).body).toMatchObject({ newRequests: true });
  });

  it('changes a switch for every device of the staff member', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const d1 = push.device();
    const d2 = push.device();
    await subscribe(staff, d1);
    await subscribe(staff, d2);
    const res = await api('/api/push/prefs', { json: { newRequests: true, myUpdates: false }, cookie });
    expect(res.body).toMatchObject({ newRequests: true, myUpdates: false });
    expect(await subRow(d1.endpoint)).toMatchObject({ new_requests: true, my_updates: false });
    expect(await subRow(d2.endpoint)).toMatchObject({ new_requests: true, my_updates: false });
    // A first read never changes them back.
    expect((await api('/api/push/prefs', { json: { bell: false }, cookie })).body).toMatchObject({ newRequests: true, myUpdates: false });
  });

  it('F6 7b: Medical has New requests ON by default (new devices and rows never set); set in the sheet, it stays; nobody else changes', async () => {
    // A new Medical device: on, the device row too, and they are among the new-request staff.
    const rae = medical();
    const raePhone = push.device();
    expect(await subscribe(rae, raePhone, { bell: false })).toMatchObject({ newRequests: true, myUpdates: true });
    expect(await subRow(raePhone.endpoint)).toMatchObject({ new_requests: true });
    const { data: who } = await admin().rpc('lp_push_new_request_staff');
    expect(who as string[]).toContain(canon(rae));
    // An existing Medical row that never had the switch set (made before this default) turns on at its next read.
    const sam = medical();
    const { error } = await admin().from('lp_push_prefs').insert({ staff: canon(sam), team: 'Medical', new_requests: false, new_requests_set: false });
    expect(error).toBeNull();
    expect((await api('/api/push/prefs', { json: {}, cookie: await cookieFor(sam) })).body).toMatchObject({ newRequests: true });
    // Switched off in the Alerts sheet: it stays off, whatever a device's old bell says.
    const lee = medical();
    const leeCookie = await cookieFor(lee);
    expect((await api('/api/push/prefs', { json: { newRequests: false }, cookie: leeCookie })).body).toMatchObject({ newRequests: false });
    expect((await api('/api/push/prefs', { json: {}, cookie: leeCookie })).body).toMatchObject({ newRequests: false });
    expect(await subscribe(lee, push.device())).toMatchObject({ newRequests: false });
    // Front of house keeps New requests off.
    const dana = newStaff();
    expect(await subscribe(dana, push.device())).toMatchObject({ newRequests: false });
    // So a new request reaches the Medical phone with nothing set, on its lock screen.
    // Medical staff who turned it on themselves (the sheet, or a device's old bell) keep their Activity rows.
    const kai = medical();
    const kaiPhone = push.device();
    await subscribe(kai, kaiPhone);
    expect((await api('/api/push/prefs', { json: { newRequests: true }, cookie: await cookieFor(kai) })).body).toMatchObject({ newRequests: true });
    const ivy = medical();
    const ivyPhone = push.device();
    expect(await subscribe(ivy, ivyPhone, { bell: true })).toMatchObject({ newRequests: true });
    const raeCookie = await cookieFor(rae);
    // The device echoes the server's switch back as its bell (ActivityHost): it stays the team's default.
    expect((await api('/api/push/prefs', { json: { bell: true }, cookie: raeCookie })).body).toMatchObject({ newRequests: true });
    const unreadBefore = (await api('/api/activity/unread', { cookie: raeCookie })).body.count;
    const res = await api('/api/requests', {
      json: { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 3 – Kinetic', name: 'Kim TEST-S Ode', age: '30' },
      cookie: await cookieFor(dana),
    });
    expect(res.status).toBe(201);
    const id = res.body.request.id as string;
    await eventually(() => raePhone.deliveries.some((d) => d.payload.requestId === id && d.payload.kind === 'new_request'));
    await eventually(() => kaiPhone.deliveries.some((d) => d.payload.requestId === id && d.payload.kind === 'new_request'));
    await eventually(() => ivyPhone.deliveries.some((d) => d.payload.requestId === id && d.payload.kind === 'new_request'));
    // Regression (review; "show nothing extra"): on by the Medical default alone it is the push only, no Activity row,
    // so Rae's bell and app badge never count every request logged.
    expect(await activityOf(rae, id)).toBeNull();
    expect((await api('/api/activity/unread', { cookie: raeCookie })).body.count).toBe(unreadBefore);
    expect(await activityOf(kai, id)).toMatchObject({ kind: 'new_request', read_at: null });
    expect(await activityOf(ivy, id)).toMatchObject({ kind: 'new_request', read_at: null });
    // Set in the sheet (even to on), it is Rae's own choice from then: the Activity rows come back.
    expect((await api('/api/push/prefs', { json: { newRequests: true }, cookie: raeCookie })).body).toMatchObject({ newRequests: true });
    const res2 = await api('/api/requests', {
      json: { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 3 – Kinetic', name: 'Lou TEST-S Ode', age: '31' },
      cookie: await cookieFor(dana),
    });
    expect(res2.status).toBe(201);
    const id2 = res2.body.request.id as string;
    await eventually(() => activityOf(rae, id2).then((a) => a?.kind === 'new_request' && a));
  });

  it('regression: a device with the old bell ON is never turned off by another device of theirs (bell off) that came first', async () => {
    const staff = newStaff();
    const desk = await cookieFor(staff);
    const phone = await cookieFor(staff);
    expect((await api('/api/push/prefs', { json: { bell: false }, cookie: desk })).body).toMatchObject({ newRequests: false });
    expect((await api('/api/push/prefs', { json: { bell: true }, cookie: phone })).body).toMatchObject({ newRequests: true });
    // …and the desk (bell off) loading again does not take it away.
    expect((await api('/api/push/prefs', { json: { bell: false }, cookie: desk })).body).toMatchObject({ newRequests: true });
    // The same through subscribe (the device's first push subscription).
    const other = newStaff();
    const d1 = push.device();
    const d2 = push.device();
    expect(await subscribe(other, d1, { bell: false })).toMatchObject({ newRequests: false });
    expect(await subscribe(other, d2, { bell: true })).toMatchObject({ newRequests: true });
    expect(await subRow(d1.endpoint)).toMatchObject({ new_requests: true });
  });

  it('…but once the staff member sets New requests in the Alerts sheet, that choice stays', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    await api('/api/push/prefs', { json: { bell: true }, cookie });
    expect((await api('/api/push/prefs', { json: { newRequests: false }, cookie })).body).toMatchObject({ newRequests: false });
    expect((await api('/api/push/prefs', { json: { bell: true }, cookie })).body).toMatchObject({ newRequests: false });
    expect((await api('/api/push/prefs', { json: { newRequests: true }, cookie })).body).toMatchObject({ newRequests: true });
    expect((await api('/api/push/prefs', { json: { bell: false }, cookie })).body).toMatchObject({ newRequests: true });
  });

  it('refuses unknown fields', async () => {
    expect((await api('/api/push/prefs', { json: { newRequests: 'yes' }, cookie: await cookieFor(newStaff()) })).status).toBe(422);
    expect((await api('/api/push/prefs', { json: { other: true }, cookie: await cookieFor(newStaff()) })).status).toBe(422);
  });
});

describe('POST / DELETE /api/push/subscribe', () => {
  it('needs a session and the same origin', async () => {
    const d = push.device();
    expect((await api('/api/push/subscribe', { json: { endpoint: d.endpoint, keys: d.keys } })).status).toBe(401);
    expect((await api('/api/push/subscribe', { json: { endpoint: d.endpoint, keys: d.keys }, cookie: await cookieFor(newStaff()), origin: 'https://evil.example' })).status).toBe(403);
  });

  it('validates: https, known push services only, base64url keys', async () => {
    const cookie = await cookieFor(newStaff());
    const d = push.device();
    for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://evil.example/push/1', 'https://fcm.googleapis.com.evil.example/x', 'not a url']) {
      const res = await api('/api/push/subscribe', { json: { endpoint, keys: d.keys }, cookie });
      expect(res.status, endpoint).toBe(422);
    }
    expect((await api('/api/push/subscribe', { json: { endpoint: d.endpoint, keys: { p256dh: 'no spaces allowed!', auth: d.keys.auth } }, cookie })).status).toBe(422);
    expect((await api('/api/push/subscribe', { json: { endpoint: d.endpoint }, cookie })).status).toBe(422);
  });

  it('stores one row per device; a different staff signing in re-binds it; a rotation drops the old endpoint', async () => {
    const dana = newStaff();
    const rae = medical();
    const d = push.device();
    expect(await subscribe(dana, d)).toMatchObject({ enabled: true, newRequests: false, myUpdates: true });
    expect(await subRow(d.endpoint)).toMatchObject({ staff: canon(dana), team: dana.team, new_requests: false, my_updates: true });
    await api('/api/push/prefs', { json: { newRequests: true }, cookie: await cookieFor(rae) });
    await subscribe(rae, d);
    expect(await subRow(d.endpoint)).toMatchObject({ staff: canon(rae), new_requests: true });
    // (A GET, not a HEAD count: a HEAD through the local gateway can leave its upstream connection to PostgREST
    // reset for whichever request reuses it next, which is then the server's call: a 502 the app answers 503.)
    const { data: same } = await admin().from('lp_push_subscriptions').select('id').eq('endpoint', d.endpoint);
    expect(same).toHaveLength(1);
    const rotated = push.device();
    await subscribe(rae, rotated, { oldEndpoint: d.endpoint });
    expect(await subRow(d.endpoint)).toBeNull();
    expect(await subRow(rotated.endpoint)).not.toBeNull();
  });

  it('DELETE removes this device (sign-out) and never re-issues the cookie', async () => {
    const staff = newStaff();
    const d = push.device();
    await subscribe(staff, d);
    const res = await api('/api/push/subscribe', { method: 'DELETE', json: { endpoint: d.endpoint }, cookie: await cookieFor(staff, { issuedAgo: 2 * 3600 }) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await subRow(d.endpoint)).toBeNull();
  });

  it("regression: nobody can remove another person's device (DELETE, or a made-up oldEndpoint)", async () => {
    const owner = newStaff();
    const other = newStaff();
    const d = push.device();
    await subscribe(owner, d);
    const res = await api('/api/push/subscribe', { method: 'DELETE', json: { endpoint: d.endpoint }, cookie: await cookieFor(other) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: false });
    expect(await subRow(d.endpoint)).toMatchObject({ staff: canon(owner) });
    await subscribe(other, push.device(), { oldEndpoint: d.endpoint });
    expect(await subRow(d.endpoint)).toMatchObject({ staff: canon(owner) });
  });
});

describe('POST /api/push/test', () => {
  it('a real push to this device only, with a fixed text', async () => {
    const staff = newStaff();
    const d = push.device();
    await subscribe(staff, d);
    const res = await api('/api/push/test', { json: { endpoint: d.endpoint }, cookie: await cookieFor(staff) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(d.deliveries).toHaveLength(1);
    expect(d.deliveries[0]?.payload).toMatchObject({ title: 'Is my friend in medical?', body: 'Test alert', tag: 'lp-test', url: '/' });
    expect((await subRow(d.endpoint))?.last_ok_at).not.toBeNull();
  });

  it("another staff member's device: 404, nothing sent", async () => {
    const d = push.device();
    await subscribe(newStaff(), d);
    const res = await api('/api/push/test', { json: { endpoint: d.endpoint }, cookie: await cookieFor(newStaff()) });
    expect(res.status).toBe(404);
    expect(d.deliveries).toHaveLength(0);
  });

  it('a device the push service says is gone (410) is deleted', async () => {
    const staff = newStaff();
    const d = push.device();
    await subscribe(staff, d);
    d.mode = 'gone';
    const res = await api('/api/push/test', { json: { endpoint: d.endpoint }, cookie: await cookieFor(staff) });
    expect(res.body).toEqual({ sent: false });
    expect(await subRow(d.endpoint)).toBeNull();
  });
});

describe('the routes notify (contract D)', () => {
  it('In medical: the logger gets one Activity row and one push (initials, no ids or contact details); the actor nothing', async () => {
    const dana = newStaff();
    const rae = medical();
    const danaPhone = push.device();
    const raePhone = push.device();
    await subscribe(dana, danaPhone);
    await subscribe(rae, raePhone);
    const r = await createRequest(dana, { name: 'Jordan TEST-S Diaz', contactPhone: '(407) 555-0142' });
    const started = Date.now();
    await setStatus(r, 'Found – Awaiting Reunion', 'answer', rae);
    expect(Date.now() - started).toBeLessThan(1_500);
    const row = await eventually(() => activityOf(dana, r.id).then((a) => a ?? undefined));
    expect(row).toMatchObject({ kind: 'in_medical', detail: 'Located', read_at: null });
    expect(row.actor).toBe(staffOf(rae));
    // The actor's own answer is never theirs to hear. (F6 7b: Rae's Medical default pushes the new request, but writes
    // no Activity row.)
    expect(await activityOf(rae, r.id)).toBeNull();
    await eventually(() => danaPhone.deliveries.length === 1);
    const p = danaPhone.deliveries[0]!;
    expect(p.payload).toMatchObject({ title: 'J.D.', body: 'Located', tag: `lp-${r.id}`, url: `/?r=${r.id}`, kind: 'in_medical', renotify: true, requireInteraction: true });
    expect(p.urgency).toBe('high');
    expect(p.ttl).toBe('3600');
    const text = JSON.stringify(p.payload);
    expect(text).not.toMatch(/LP-?\d/);
    expect(text).not.toContain('555');
    expect(text).not.toContain('Jordan');
    // The actor never hears about their own answer (the new-request push Rae's switch asked for is another event).
    expect(raePhone.deliveries.filter((d) => d.payload.requestId === r.id && d.payload.kind !== 'new_request')).toHaveLength(0);
    // The where completes the answer ("Located · Chair 9"), then a move reads "Chair 9 → Bed 3".
    const after = (await api(`/api/sync?ids=${r.id}`, { cookie: await cookieFor(rae) })).body.rows[0] as RequestSummary;
    const patch = async (loc: string, version: number) =>
      api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { medicalLocation: loc }, expectedVersion: version }, cookie: await cookieFor(rae) });
    const p1 = await patch('Chair 9', after.rowVersion);
    expect(p1.status).toBe(200);
    await eventually(() => activityOf(dana, r.id).then((a) => a?.detail === 'Located · Chair 9' && a));
    await patch('Bed 3', p1.body.request.rowVersion);
    const moved = await eventually(() => activityOf(dana, r.id).then((a) => a?.kind === 'moved' && a));
    expect(moved.detail).toBe('Chair 9 → Bed 3');
    // Still ONE row for the request.
    const { data: one } = await admin().from('lp_activity').select('request_id').eq('staff', canon(dana)).eq('request_id', r.id);
    expect(one).toHaveLength(1);
    await eventually(() => danaPhone.deliveries.length === 3);
    expect(danaPhone.deliveries.map((d) => d.payload.body)).toEqual(['Located', 'Located · Chair 9', 'Chair 9 → Bed 3']);
  });

  // F3 + F4 release: F5's stage-notify sends both Not found answers (not_in_medical); F4's status events never
  // do, and a hold (the status stays Waiting for check) never reads as "Back to Waiting for check".
  it('Not found: the hold and the final answer each notify ONCE as not_in_medical (F5); an Undo is Back to Waiting', async () => {
    const dana = newStaff();
    const rae = medical();
    const danaPhone = push.device();
    await subscribe(dana, danaPhone);
    const r = await createRequest(dana);
    // The first Not found: the "Not located yet" hold (the row stays Waiting for check, recheck in 20 minutes).
    const held = await setStatus(r, 'Checked – Not Found', 'answer', rae);
    expect(held.status).toBe('Added');
    expect(held.recheckAt).toBeTruthy();
    const first = await eventually(() => activityOf(dana, r.id).then((a) => a ?? undefined));
    expect(first).toMatchObject({ kind: 'not_in_medical', read_at: null });
    expect(first.detail).toMatch(/^Not located yet · recheck \d{1,2}:\d{2} (AM|PM)$/);
    await eventually(() => danaPhone.deliveries.length === 1);
    // The final Not found closes it: the status's own label (STATUS_META, "Not located").
    const closed = await setStatus(held, 'Checked – Not Found', 'answer', rae);
    expect(closed.status).toBe('Checked – Not Found');
    await eventually(() => activityOf(dana, r.id).then((a) => a?.detail === STATUS_META['Checked – Not Found'].label && a));
    await eventually(() => danaPhone.deliveries.length === 2);
    // Undo of the final answer: back to Waiting for check (on hold again), F4's back_to_waiting.
    await setStatus(closed, 'Added', 'undo', rae);
    await eventually(() => activityOf(dana, r.id).then((a) => a?.kind === 'back_to_waiting' && a));
    await eventually(() => danaPhone.deliveries.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // Exactly once each: three pushes, never a back_to_waiting for the hold itself; still ONE Activity row.
    expect(danaPhone.deliveries.map((d) => d.payload.kind)).toEqual(['not_in_medical', 'not_in_medical', 'back_to_waiting']);
    for (const d of danaPhone.deliveries) expect(JSON.stringify(d.payload)).not.toMatch(/LP-?\d/);
    const { data: one } = await admin().from('lp_activity').select('kind').eq('staff', canon(dana)).eq('request_id', r.id);
    expect(one).toHaveLength(1);
    // The actor never hears about their own answers.
    expect(await activityOf(rae, r.id)).toBeNull();
  });

  it('F3 + F4 release: whoever gave the first Not found (the hold) is involved, so a later message reaches them', async () => {
    const dana = newStaff();
    const rae = medical();
    const r = await createRequest(dana);
    await setStatus(r, 'Checked – Not Found', 'answer', rae);
    const { data, error } = await admin().rpc('lp_involved_staff', { p_request: r.id });
    expect(error).toBeNull();
    expect(data as string[]).toEqual(expect.arrayContaining([canon(dana), canon(rae)]));
    const res = await api(`/api/requests/${r.id}/messages`, { json: { clientMutationId: crypto.randomUUID(), body: 'Friend is still here' }, cookie: await cookieFor(dana) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await eventually(() => activityOf(rae, r.id).then((a) => (a?.kind === 'message' ? a : undefined)));
    expect(row.detail).toMatch(/: Friend is still here$/);
  });

  it('a new request reaches whoever has New requests on (never its logger); a retry tells nobody again', async () => {
    const rae = medical();
    const raePhone = push.device();
    await subscribe(rae, raePhone, { bell: true }); // the phone's old bell was on: New requests on
    const off = newStaff();
    const offPhone = push.device();
    await subscribe(off, offPhone);
    const dana = newStaff();
    const body = { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 4 – Oasis', name: 'Tara TEST-S Ruiz', age: '24', gender: 'Male', contactPhone: '4075550142' };
    const cookie = await cookieFor(dana);
    const res = await api('/api/requests', { json: body, cookie });
    expect(res.status).toBe(201);
    const id = res.body.request.id as string;
    await eventually(() => raePhone.deliveries.some((d) => d.payload.requestId === id));
    const p = raePhone.deliveries.find((d) => d.payload.requestId === id)!;
    expect(p.payload).toMatchObject({ title: 'New request', body: 'T.R. · 24 M · FA 4', kind: 'new_request' });
    expect(JSON.stringify(p.payload)).not.toContain('555');
    expect(await activityOf(rae, id)).toMatchObject({ kind: 'new_request', detail: 'T.R. · 24 M · FA 4' });
    expect(await activityOf(dana, id)).toBeNull();
    expect(offPhone.deliveries.some((d) => d.payload.requestId === id)).toBe(false);
    const n = raePhone.deliveries.length;
    expect((await api('/api/requests', { json: body, cookie })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(raePhone.deliveries.length).toBe(n);
  });

  it('cancel tells the answerer; Updates on my requests off: an Activity row but no push', async () => {
    const dana = newStaff();
    const rae = medical();
    const raePhone = push.device();
    await subscribe(rae, raePhone);
    await api('/api/push/prefs', { json: { myUpdates: false, newRequests: false }, cookie: await cookieFor(rae) });
    const r = await createRequest(dana);
    const answered = await setStatus(r, 'Found – Awaiting Reunion', 'answer', rae);
    const back = await setStatus(answered, 'Added', 'undo', rae);
    const res = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: back.rowVersion }, cookie: await cookieFor(dana) });
    expect(res.status).toBe(200);
    const row = await eventually(() => activityOf(rae, r.id).then((a) => a?.kind === 'cancelled' && a));
    expect(row.detail).toBe('Cancelled');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(raePhone.deliveries).toHaveLength(0);
  });

  it('a hanging push service never slows the response; failures are counted', async () => {
    const dana = newStaff();
    const rae = medical();
    const stuck = push.device();
    stuck.mode = 'hang';
    await subscribe(dana, stuck);
    const r = await createRequest(dana);
    const started = Date.now();
    await setStatus(r, 'Found – Awaiting Reunion', 'answer', rae);
    expect(Date.now() - started).toBeLessThan(1_500);
    await eventually(async () => ((await subRow(stuck.endpoint))?.failures ?? 0) >= 1, 15_000);
  }, 30_000);
});

describe('Activity routes', () => {
  async function seeded() {
    const dana = newStaff();
    const rae = medical();
    const a = await createRequest(dana, { name: 'Ava TEST-S Lane' });
    const b = await createRequest(dana, { name: 'Ben TEST-S Wu' });
    await setStatus(a, 'Found – Awaiting Reunion', 'answer', rae);
    await setStatus(b, 'Found – Awaiting Reunion', 'answer', rae);
    await eventually(async () => (await activityOf(dana, a.id)) && (await activityOf(dana, b.id)));
    return { dana, rae, a, b, cookie: await cookieFor(dana) };
  }

  it('need a session and (for writes) the same origin', async () => {
    expect((await api('/api/activity')).status).toBe(401);
    expect((await api('/api/activity/read', { json: { all: true } })).status).toBe(401);
    const cookie = await cookieFor(newStaff());
    expect((await api('/api/activity/read', { json: { all: true }, cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('/api/activity/unread', { json: { requestIds: [crypto.randomUUID()] }, cookie, origin: null })).status).toBe(403);
    expect((await api('/api/activity/read', { json: { requestId: 'nope' }, cookie })).status).toBe(422);
    expect((await api('/api/activity/unread', { json: { requestIds: [] }, cookie })).status).toBe(422);
  });

  it('GET: one row per request, newest first, initials only; sync carries the unread count', async () => {
    const { a, b, cookie } = await seeded();
    const res = await api('/api/activity', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const rows = res.body.rows as Array<{ requestId: string; title: string; detail: string; kind: string; read: boolean }>;
    expect(rows.map((r) => r.requestId)).toEqual([b.id, a.id]);
    expect(rows[0]).toMatchObject({ title: 'B.W.', detail: 'Located', kind: 'in_medical', read: false });
    expect(JSON.stringify(res.body)).not.toContain('TEST-S');
    const sync = (await api('/api/sync', { cookie })).body as SyncResponse & Record<string, unknown>;
    expect(sync.activityUnread).toBe(2);
    expect(sync.activityKey).toMatch(/^[0-9a-f]{16}$/);
    const unread = await api('/api/activity/unread', { cookie });
    expect(unread.status).toBe(200);
    expect(unread.body).toEqual({ count: 2, ids: [b.id, a.id], key: sync.activityKey });
  });

  it('regression: a poll never carries the unread ids (data use); the key moves with every change, read or not', async () => {
    const { a, dana, rae, cookie } = await seeded();
    const first = (await api('/api/sync', { cookie })).body as SyncResponse & Record<string, unknown>;
    expect(first).not.toHaveProperty('activityUnreadIds');
    const again = (await api('/api/sync', { cookie })).body as SyncResponse;
    expect(again.activityKey).toBe(first.activityKey);
    // Medical sets the location of A: A stays unread (same unread set), but the key moves.
    const row = ((await api(`/api/sync?ids=${a.id}`, { cookie })).body as SyncResponse).rows[0] as RequestSummary;
    const patched = await api(`/api/requests/${a.id}`, { method: 'PATCH', json: { patch: { medicalLocation: 'Bed 3' }, expectedVersion: row.rowVersion }, cookie: await cookieFor(rae) });
    expect(patched.status).toBe(200);
    await eventually(async () => (await activityOf(dana, a.id))?.detail === 'Located · Bed 3' || null);
    const moved = (await api('/api/sync', { cookie })).body as SyncResponse;
    expect(moved.activityUnread).toBe(2);
    expect(moved.activityKey).not.toBe(first.activityKey);
    await api('/api/activity/read', { json: { requestId: a.id }, cookie });
    const read = (await api('/api/sync', { cookie })).body as SyncResponse;
    expect(read.activityUnread).toBe(1);
    expect(read.activityKey).not.toBe(moved.activityKey);
  });

  it('read one (the request was opened), then Mark all read and Undo', async () => {
    const { a, b, cookie } = await seeded();
    expect((await api('/api/activity/read', { json: { requestId: a.id }, cookie })).body).toEqual({ count: 1, ids: [a.id] });
    expect((await api('/api/activity/read', { json: { requestId: a.id }, cookie })).body).toEqual({ count: 0, ids: [] });
    const all = await api('/api/activity/read', { json: { all: true }, cookie });
    expect(all.body).toEqual({ count: 1, ids: [b.id] });
    const none = (await api('/api/sync', { cookie })).body as SyncResponse;
    expect(none.activityUnread).toBe(0);
    // Nothing unread: the count alone (the empty delta stays small).
    expect(none).not.toHaveProperty('activityKey');
    expect((await api('/api/activity/unread', { json: { requestIds: all.body.ids }, cookie })).body).toEqual({ count: 1 });
    expect((await api('/api/activity/unread', { cookie })).body).toMatchObject({ count: 1, ids: [b.id] });
  });

  it("only ever touches the signed-in staff member's rows", async () => {
    const { a, cookie } = await seeded();
    const other = await cookieFor(newStaff());
    expect((await api('/api/activity/read', { json: { requestId: a.id }, cookie: other })).body).toEqual({ count: 0, ids: [] });
    expect(((await api('/api/sync', { cookie })).body as SyncResponse).activityUnread).toBe(2);
  });
});

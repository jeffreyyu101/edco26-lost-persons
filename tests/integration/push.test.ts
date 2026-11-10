// Web Push, the Alerts switches and the Activity inbox through the real routes (F4, spec §18 A53–A59), against
// the local stack and a fake push service that decrypts every push (tests/integration/push-service.ts).
//   * POST /api/push/prefs, POST/DELETE /api/push/subscribe, POST /api/push/test: session, same-origin,
//     validation, defaults (every team: New requests on, push only, until set in the sheet), re-binding, endpoint
//     rotation, 410 deletes.
//   * The routes notify (after the response): In medical reaches the logger (Activity row + push, the full name as
//     the title, no ids or contact details), never the actor; a Not in medical answer sends NOTHING (F5 owns
//     it); new requests reach whoever has New requests on; the location completes the answer or moves it.
//   * GET /api/activity, GET /api/activity/unread, POST /api/activity/read | unread, and sync's activityUnread
//     and activityKey (no ids on a poll; the key moves with every change).
//   * Nobody can remove another person's device (DELETE, oldEndpoint); New requests is never lost to whichever
//     device of a staff member came first; an edit's event is its own author's.
//   * A hanging push service never slows the API response.
// Synthetic data only; every request is closed afterwards.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestSummary, SyncResponse } from '@/lib/api-types';
import { apiRequest } from '@/lib/client/http';
import { forgetBell, forgetBellForOtherStaff, readPrefs, setBell, setBellIntroSeen, writeRememberedIdentity } from '@/lib/client/prefs';
import { createPushClient, type PushHost } from '@/lib/client/push-client';
import { STATUS_META } from '@/lib/domain';
import { EVENT_ID, BASE, ORIGIN, admin, api, cookieFor, createRequest, newStaff, staffOf, withTestServer, type Staff } from './harness';
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

async function prefsRow(staff: Staff) {
  const { data, error } = await admin().from('lp_push_prefs').select('new_requests, new_requests_set, new_requests_team_default').eq('staff', canon(staff)).maybeSingle();
  if (error) throw new Error(error.code);
  return data as { new_requests: boolean; new_requests_set: boolean; new_requests_team_default: boolean } | null;
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

  it('push is on (the test keys), with the defaults: New requests on for every team (push only), Updates on', async () => {
    const base = newStaff('GC/HX - Base');
    const res = await api('/api/push/prefs', { json: {}, cookie: await cookieFor(base) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, newRequests: true, myUpdates: true });
    expect(res.body.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
    // (2026-11-08, Brian: "new requests should be on for everyone by default n configurable") Every team starts with
    // New requests ON, as Medical did (F6 7b): by the team default alone, so the push only, no Activity row.
    expect(await prefsRow(base)).toEqual({ new_requests: true, new_requests_set: false, new_requests_team_default: true });
    for (const staff of [medical(), newStaff('GC/HX - Dispatch'), newStaff('GC/HX - Special Operations/Med Transpo')]) {
      expect((await api('/api/push/prefs', { json: {}, cookie: await cookieFor(staff) })).body, staff.team).toMatchObject({ newRequests: true, myUpdates: true });
      expect(await prefsRow(staff), staff.team).toMatchObject({ new_requests: true, new_requests_team_default: true });
    }
    // The phone's old "Alerts" bell for a staff member seen for the first time: on as their own (Activity rows too).
    const bell = newStaff();
    expect((await api('/api/push/prefs', { json: { bell: true }, cookie: await cookieFor(bell) })).body).toMatchObject({ newRequests: true });
    expect(await prefsRow(bell)).toEqual({ new_requests: true, new_requests_set: false, new_requests_team_default: false });
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

  it('F6 7b: New requests is ON by default for every team (new devices and rows never set); set in the sheet, it stays', async () => {
    // A new Medical device: on, the device row too, and they are among the new-request staff.
    const rae = medical();
    const raePhone = push.device();
    expect(await subscribe(rae, raePhone, { bell: false })).toMatchObject({ newRequests: true, myUpdates: true });
    expect(await subRow(raePhone.endpoint)).toMatchObject({ new_requests: true });
    const { data: who } = await admin().rpc('lp_push_new_request_staff', { p_event: EVENT_ID });
    expect(who as string[]).toContain(canon(rae));
    // Existing rows that never had the switch set (made before this default) turn on at their next read, Medical
    // or not (2026-11-08).
    for (const sam of [medical(), newStaff('GC/HX - Base')]) {
      const { error } = await admin().from('lp_push_prefs').insert({ staff: canon(sam), team: sam.team, new_requests: false, new_requests_set: false });
      expect(error).toBeNull();
      expect((await api('/api/push/prefs', { json: {}, cookie: await cookieFor(sam) })).body, sam.team).toMatchObject({ newRequests: true });
      expect(await prefsRow(sam), sam.team).toMatchObject({ new_requests: true, new_requests_set: false, new_requests_team_default: true });
    }
    // Switched off in the Alerts sheet: it stays off, whatever a device's old bell says.
    const lee = medical();
    const leeCookie = await cookieFor(lee);
    expect((await api('/api/push/prefs', { json: { newRequests: false }, cookie: leeCookie })).body).toMatchObject({ newRequests: false });
    expect((await api('/api/push/prefs', { json: {}, cookie: leeCookie })).body).toMatchObject({ newRequests: false });
    expect(await subscribe(lee, push.device(), { bell: true })).toMatchObject({ newRequests: false });
    // Front of house is on by the same default now (2026-11-08); Dana logs the requests below.
    const dana = newStaff();
    const danaPhone = push.device();
    expect(await subscribe(dana, danaPhone)).toMatchObject({ newRequests: true });
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
    // Regression (review; "show nothing extra"): on by the team default alone it is the push only, no Activity row,
    // so Rae's bell and app badge never count every request logged.
    expect(await activityOf(rae, id)).toBeNull();
    expect((await api('/api/activity/unread', { cookie: raeCookie })).body.count).toBe(unreadBefore);
    expect(await activityOf(kai, id)).toMatchObject({ kind: 'new_request', read_at: null });
    expect(await activityOf(ivy, id)).toMatchObject({ kind: 'new_request', read_at: null });
    // The logger never hears about their own request, default or not.
    expect(danaPhone.deliveries.some((d) => d.payload.requestId === id)).toBe(false);
    expect(await activityOf(dana, id)).toBeNull();
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

  it('regression: a device with the old bell ON is never turned off by another device of theirs (bell off), whichever came first', async () => {
    // (2026-11-08) The desk first, bell off: on by the team default (push only). The phone's old bell then keeps it on;
    // a later bell is no choice (each device echoes the server's switch back as its bell), so it stays the default.
    const staff = newStaff();
    const desk = await cookieFor(staff);
    const phone = await cookieFor(staff);
    expect((await api('/api/push/prefs', { json: { bell: false }, cookie: desk })).body).toMatchObject({ newRequests: true });
    expect((await api('/api/push/prefs', { json: { bell: true }, cookie: phone })).body).toMatchObject({ newRequests: true });
    // …and the desk (bell off) loading again does not take it away.
    expect((await api('/api/push/prefs', { json: { bell: false }, cookie: desk })).body).toMatchObject({ newRequests: true });
    expect(await prefsRow(staff)).toEqual({ new_requests: true, new_requests_set: false, new_requests_team_default: true });
    // The same through subscribe (the device's first push subscription), the old bell first: on as the staff
    // member's own (Activity rows), and a device of theirs with the bell off never takes it away.
    const other = newStaff();
    const d1 = push.device();
    const d2 = push.device();
    expect(await subscribe(other, d1, { bell: true })).toMatchObject({ newRequests: true });
    expect(await subscribe(other, d2, { bell: false })).toMatchObject({ newRequests: true });
    expect(await subRow(d1.endpoint)).toMatchObject({ new_requests: true });
    expect(await subRow(d2.endpoint)).toMatchObject({ new_requests: true });
    expect(await prefsRow(other)).toEqual({ new_requests: true, new_requests_set: false, new_requests_team_default: false });
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

// F6 follow-up (release review): on a shared phone or iPad the bell holds a copy of the signed-in staff member's
// server switch (ActivityHost). Sent back as the "old bell" it gave the next staff member New requests for good,
// as their own choice: Activity rows for every new request instead of the team default's push only (2026-11-08:
// every team's default is on, so that mark is what tells a copy from the default). The page's real push client (lib/client/
// push-client.ts) and prefs (lib/client/prefs.ts, a fake localStorage) against the real routes.
describe('a shared phone: a copy of the server switch is never an old bell (F6 follow-up)', () => {
  const local = new Map<string, string>();
  let cookie = '';
  const host: PushHost = {
    device: () => ({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5, standalone: true }),
    // No worker in this test: the client only reads the switches (POST /api/push/prefs), as at every start.
    hasServiceWorker: () => false,
    hasPushManager: () => false,
    hasNotification: () => false,
    permission: () => 'default',
    requestPermission: async () => 'default',
    ready: () => null,
    workerShowsPush: async () => false,
    getSubscription: async () => null,
    subscribe: () => Promise.reject(new Error('no push in this test')),
    request: (path, opts) =>
      apiRequest((input, init) => fetch(`${BASE}${input}`, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie, origin: ORIGIN } }), path, opts),
    storage: () => null,
    watch: () => () => undefined,
    setBadge: () => undefined,
  };

  beforeAll(() => {
    vi.stubGlobal('window', {
      localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  /** Signs `staff` in on this phone (the sign-in page), starts the push client and copies the switch (ActivityHost). */
  async function signIn(staff: Staff, opts: { signInPage?: boolean } = {}) {
    if (opts.signInPage !== false) {
      forgetBellForOtherStaff(staff.staffName, staff.team);
      writeRememberedIdentity(staff.staffName, staff.team);
    }
    cookie = await cookieFor(staff);
    const client = createPushClient(host);
    client.start(staffOf(staff));
    const prefs = await eventually(() => client.getState().prefs);
    setBellIntroSeen(true);
    setBell(prefs.newRequests);
    return prefs;
  }

  // (2026-11-08) Every team starts with New requests ON by the team default (push only). A copy of someone else's
  // switch sent as an old bell would show as the staff member's own choice instead: new_requests_team_default false,
  // an Activity row for every request logged.
  const teamDefault = { new_requests: true, new_requests_set: false, new_requests_team_default: true };

  it('Medical A signs out; new Medical B and never-set front of house C stay push-only (the team default)', async () => {
    local.clear();
    const a = medical();
    expect(await signIn(a)).toMatchObject({ newRequests: true });
    expect(readPrefs().bell).toBe(true); // the device now shows A's switch
    forgetBell(); // A signs out (the store's sign-out)
    const b = medical();
    expect(await signIn(b)).toMatchObject({ newRequests: true });
    expect(await prefsRow(b)).toEqual(teamDefault);
    forgetBell();
    const c = newStaff('GC/HX - Base');
    expect(await signIn(c)).toMatchObject({ newRequests: true });
    expect(await prefsRow(c)).toEqual(teamDefault);
  });

  it('…and the same with no sign-out in between (the session ran out, someone else signed in), on the copy mark alone', async () => {
    local.clear();
    const a = medical();
    expect(await signIn(a)).toMatchObject({ newRequests: true });
    expect(local.get('lp-bell')).toBe('1');
    const b = medical();
    expect(await signIn(b, { signInPage: false })).toMatchObject({ newRequests: true });
    expect(await prefsRow(b)).toEqual(teamDefault);
    const c = newStaff('GC/HX - Base');
    expect(local.get('lp-bell')).toBe('1'); // still B's copy on the device
    expect(await signIn(c, { signInPage: false })).toMatchObject({ newRequests: true });
    expect(await prefsRow(c)).toEqual(teamDefault);
    // Switched off in the Alerts sheet (on another device): the copy on this one never turns it back on.
    const f = newStaff('GC/HX - Base');
    expect((await api('/api/push/prefs', { json: { newRequests: false }, cookie: await cookieFor(f) })).body).toMatchObject({ newRequests: false });
    expect(local.get('lp-bell')).toBe('1'); // C's copy
    expect(await signIn(f, { signInPage: false })).toMatchObject({ newRequests: false });
    expect(await prefsRow(f)).toEqual({ new_requests: false, new_requests_set: true, new_requests_team_default: false });
    // What the old build did: that copy sent as an old bell makes New requests the staff member's own for good,
    // an Activity row for every request logged (the bug).
    const d = newStaff('GC/HX - Base');
    expect((await api('/api/push/prefs', { json: { bell: true }, cookie: await cookieFor(d) })).body).toMatchObject({ newRequests: true });
    expect(await prefsRow(d)).toMatchObject({ new_requests: true, new_requests_team_default: false });
  });

  it('a bell left by the build that is live now (no mark) is forgotten when someone else signs in', async () => {
    local.clear();
    const a = medical();
    writeRememberedIdentity(a.staffName, a.team);
    local.set('lp-bell', '1'); // A's switch, copied by the live build, never marked; A signed out there
    local.set('lp-bell-intro-seen', '1');
    const c = newStaff('GC/HX - Base');
    expect(await signIn(c)).toMatchObject({ newRequests: true });
    expect(await prefsRow(c)).toEqual(teamDefault);
  });

  it("a phone's own old bell (set before the server switch) still turns New requests on for its staff member", async () => {
    local.clear();
    const e = newStaff('GC/HX - Base');
    writeRememberedIdentity(e.staffName, e.team);
    local.set('lp-bell', '1');
    expect(await signIn(e)).toMatchObject({ newRequests: true });
    expect(await prefsRow(e)).toMatchObject({ new_requests: true, new_requests_team_default: false });
    expect(local.get('lp-bell-server')).toBe('1');
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
    expect(await subscribe(dana, d)).toMatchObject({ enabled: true, newRequests: true, myUpdates: true });
    expect(await subRow(d.endpoint)).toMatchObject({ staff: canon(dana), team: dana.team, new_requests: true, my_updates: true });
    // Rae switched New requests off in the sheet: the re-bound row takes Rae's switches, not Dana's.
    await api('/api/push/prefs', { json: { newRequests: false }, cookie: await cookieFor(rae) });
    await subscribe(rae, d);
    expect(await subRow(d.endpoint)).toMatchObject({ staff: canon(rae), team: rae.team, new_requests: false });
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
  it('In medical: the logger gets one Activity row and one push (the full name, no ids or contact details); the actor nothing', async () => {
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
    // The actor's own answer is never theirs to hear. (F6 7b: Rae's team default pushes the new request, but writes
    // no Activity row.)
    expect(await activityOf(rae, r.id)).toBeNull();
    await eventually(() => danaPhone.deliveries.length === 1);
    const p = danaPhone.deliveries[0]!;
    expect(p.payload).toMatchObject({ title: 'Jordan TEST-S Diaz', body: 'Located', tag: `lp-${r.id}`, url: `/?r=${r.id}`, kind: 'in_medical', renotify: true, requireInteraction: true });
    expect(p.urgency).toBe('high');
    expect(p.ttl).toBe('3600');
    // (Telemetry) sentAt is the server clock, a 13-digit number: left out of the text check.
    const text = JSON.stringify({ ...p.payload, sentAt: undefined });
    expect(text).not.toMatch(/LP-?\d/);
    expect(text).not.toContain('555');
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
    // The first Not found: the "Pending" hold (the row stays Waiting for check, recheck in 20 minutes).
    const held = await setStatus(r, 'Checked – Not Found', 'answer', rae);
    expect(held.status).toBe('Added');
    expect(held.recheckAt).toBeTruthy();
    const first = await eventually(() => activityOf(dana, r.id).then((a) => a ?? undefined));
    expect(first).toMatchObject({ kind: 'not_in_medical', read_at: null });
    expect(first.detail).toMatch(/^Pending · recheck \d{1,2}:\d{2} (AM|PM)$/);
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
    const { data, error } = await admin().rpc('lp_involved_staff', { p_event: EVENT_ID, p_request: r.id });
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
    // On by the team default (2026-11-08); switched off in the Alerts sheet.
    expect((await api('/api/push/prefs', { json: { newRequests: false }, cookie: await cookieFor(off) })).body).toMatchObject({ newRequests: false });
    const dana = newStaff();
    const body = { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 4 – Oasis', name: 'Tara TEST-S Ruiz', age: '24', gender: 'Male', contactPhone: '4075550142' };
    const cookie = await cookieFor(dana);
    const res = await api('/api/requests', { json: body, cookie });
    expect(res.status).toBe(201);
    const id = res.body.request.id as string;
    await eventually(() => raePhone.deliveries.some((d) => d.payload.requestId === id));
    const p = raePhone.deliveries.find((d) => d.payload.requestId === id)!;
    expect(p.payload).toMatchObject({ title: 'New request', body: 'Tara TEST-S Ruiz · 24 M · FA 4', kind: 'new_request' });
    expect(JSON.stringify({ ...p.payload, sentAt: undefined })).not.toContain('555');
    expect(await activityOf(rae, id)).toMatchObject({ kind: 'new_request', detail: 'Tara TEST-S Ruiz · 24 M · FA 4' });
    expect(await activityOf(dana, id)).toBeNull();
    expect(offPhone.deliveries.some((d) => d.payload.requestId === id)).toBe(false);
    const n = raePhone.deliveries.length;
    expect((await api('/api/requests', { json: body, cookie })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(raePhone.deliveries.length).toBe(n);
  });

  it('2026-11-08: front of house that never set New requests gets the push only (no Activity row); off in the sheet stays off; never the logger', async () => {
    // Never set: on by the team default, as Medical is.
    const fay = newStaff('GC/HX - Base');
    const fayPhone = push.device();
    expect(await subscribe(fay, fayPhone)).toMatchObject({ newRequests: true });
    expect(await subRow(fayPhone.endpoint)).toMatchObject({ new_requests: true });
    expect(await prefsRow(fay)).toEqual({ new_requests: true, new_requests_set: false, new_requests_team_default: true });
    // Switched off in the Alerts sheet: off on every device of theirs, a later device and a later read included.
    const gus = newStaff();
    const gusCookie = await cookieFor(gus);
    const gusPhone = push.device();
    expect(await subscribe(gus, gusPhone)).toMatchObject({ newRequests: true });
    expect((await api('/api/push/prefs', { json: { newRequests: false }, cookie: gusCookie })).body).toMatchObject({ newRequests: false });
    const gusDesk = push.device();
    expect(await subscribe(gus, gusDesk)).toMatchObject({ newRequests: false });
    expect((await api('/api/push/prefs', { json: {}, cookie: gusCookie })).body).toMatchObject({ newRequests: false });
    expect(await subRow(gusPhone.endpoint)).toMatchObject({ new_requests: false });
    expect(await subRow(gusDesk.endpoint)).toMatchObject({ new_requests: false });
    // The logger: front of house too, on by the same default.
    const dana = newStaff();
    const danaPhone = push.device();
    expect(await subscribe(dana, danaPhone)).toMatchObject({ newRequests: true });
    const { data: who } = await admin().rpc('lp_push_new_request_staff', { p_event: EVENT_ID });
    expect(who as string[]).toEqual(expect.arrayContaining([canon(fay), canon(dana)]));
    expect(who as string[]).not.toContain(canon(gus));

    const fayCookie = await cookieFor(fay);
    const unreadBefore = (await api('/api/activity/unread', { cookie: fayCookie })).body.count as number;
    const res = await api('/api/requests', {
      json: { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 4 – Oasis', name: 'Uma TEST-S Vale', age: '27', contactPhone: '4075550142' },
      cookie: await cookieFor(dana),
    });
    expect(res.status).toBe(201);
    const id = res.body.request.id as string;
    // Fay's lock screen: the new request, no contact details.
    const p = await eventually(() => fayPhone.deliveries.find((d) => d.payload.requestId === id));
    expect(p.payload).toMatchObject({ title: 'New request', kind: 'new_request' });
    expect(JSON.stringify({ ...p.payload, sentAt: undefined })).not.toContain('555');
    // The push only: no Activity row, so Fay's bell and badge never count every request logged.
    expect(await activityOf(fay, id)).toBeNull();
    expect((await api('/api/activity/unread', { cookie: fayCookie })).body.count).toBe(unreadBefore);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(fayPhone.deliveries.filter((d) => d.payload.requestId === id)).toHaveLength(1);
    // Off in the sheet: nothing. The logger: never their own request.
    for (const d of [gusPhone, gusDesk, danaPhone]) expect(d.deliveries.some((x) => x.payload.requestId === id), d.name).toBe(false);
    expect(await activityOf(gus, id)).toBeNull();
    expect(await activityOf(dana, id)).toBeNull();
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

  it('GET: one row per request, newest first, the full name and no contact details; sync carries the unread count', async () => {
    const { a, b, cookie } = await seeded();
    const res = await api('/api/activity', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const rows = res.body.rows as Array<{ requestId: string; title: string; detail: string; kind: string; read: boolean }>;
    expect(rows.map((r) => r.requestId)).toEqual([b.id, a.id]);
    expect(rows[0]).toMatchObject({ title: 'Ben TEST-S Wu', detail: 'Located', kind: 'in_medical', read: false });
    expect(rows[1]).toMatchObject({ title: 'Ava TEST-S Lane' });
    const listed = JSON.stringify(res.body);
    for (const secret of ['TEST-S Friend', 'TEST-S red hoodie', '555']) expect(listed).not.toContain(secret);
    expect(listed).not.toMatch(/LP-?\d/);
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

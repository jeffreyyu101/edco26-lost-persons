// F3 messages and en route (spec §18 A53–A58) through the API and SQL: every lp_messages / lp_enroute
// function (idempotency, permissions, closed requests, rate limit, unsend), read cursors and receipts, the
// derived needsInfo, the activity in sync (including a thread that changed without its row changing) and
// the detail, en route set / change / cancel / arrive and its clearing by status changes (the trigger),
// lp_involved_staff, the stats fields, and a re-run of the migration. Synthetic data only.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PostMessageResponse, RequestDetail, RequestSummary, Stats, SyncResponse, ThreadPage } from '@/lib/api-types';
import { syncPath } from '@/lib/client/api-paths';
import { STATUS, canonStaff } from '@/lib/domain';
import { shortStaffName } from '@/lib/messaging';
import { ROOT } from '../../scripts/test-env.mjs';
import { api, cookieFor, createRequest, dbUrl, newStaff, pii, psql, randomUUID, staffOf, uniq, withTestServer, type Staff } from './harness';

withTestServer();

async function post(id: string, body: string, cookie: string, clientMutationId = randomUUID()) {
  return api<PostMessageResponse>(`/api/requests/${id}/messages`, { json: { clientMutationId, body }, cookie });
}

async function thread(id: string, cookie: string, query = ''): Promise<ThreadPage> {
  const res = await api<ThreadPage>(`/api/requests/${id}/messages${query}`, { cookie });
  expect(res.status, res.text).toBe(200);
  return res.body;
}

async function rowFor(id: string, cookie: string): Promise<RequestSummary> {
  const res = await api<SyncResponse>(syncPath({ ids: [id] }), { cookie });
  expect(res.status).toBe(200);
  const row = res.body.rows.find((r) => r.id === id);
  if (!row) throw new Error('row not in sync');
  return row;
}

async function setStatus(r: RequestSummary, status: string, kind: string, cookie: string): Promise<RequestSummary> {
  const res = await api(`/api/requests/${r.id}/status`, { json: { status, expectedVersion: r.rowVersion, kind }, cookie });
  expect(res.status, res.text).toBe(200);
  return res.body.request as RequestSummary;
}

async function enroute(id: string, json: Record<string, unknown>, cookie: string) {
  const res = await api(`/api/requests/${id}/enroute`, { json, cookie });
  expect(res.status, res.text).toBe(200);
  return res.body as { changed: boolean; ignored?: boolean; activity: RequestSummary };
}

interface People {
  foh: Staff;
  med: Staff;
  fohCookie: string;
  medCookie: string;
}

async function people(): Promise<People> {
  const foh = newStaff();
  const med = newStaff('Medical');
  return { foh, med, fohCookie: await cookieFor(foh), medCookie: await cookieFor(med) };
}

describe('POST /api/requests/:id/messages', () => {
  it('needs a session and the same origin, validates the body, 404s an unknown request', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    expect((await api(`/api/requests/${r.id}/messages`, {})).status).toBe(401);
    expect((await api(`/api/requests/${r.id}/messages`, { json: { clientMutationId: randomUUID(), body: 'x' } })).status).toBe(401);
    expect((await api(`/api/requests/${r.id}/messages`, { json: { clientMutationId: randomUUID(), body: 'x' }, cookie: p.fohCookie, origin: 'https://evil.test' })).status).toBe(403);
    const empty = await post(r.id, '   ', p.fohCookie);
    expect(empty.status).toBe(422);
    expect(empty.body).toMatchObject({ error: { code: 'invalid', field: 'body' } });
    expect((await post(r.id, 'x'.repeat(501), p.fohCookie)).status).toBe(422);
    expect((await post(r.id, 'x'.repeat(500), p.fohCookie)).status).toBe(201);
    expect((await api(`/api/requests/${r.id}/messages`, { json: { clientMutationId: 'nope', body: 'x' }, cookie: p.fohCookie })).status).toBe(422);
    expect((await post(randomUUID(), 'Hello', p.fohCookie)).status).toBe(404);
    expect((await api('/api/requests/not-a-uuid/messages', { cookie: p.fohCookie })).status).toBe(404);
  });

  it('is idempotent on clientMutationId (201 then 200, one row, one audit); another staff reusing it gets 422', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    const cmid = randomUUID();
    const first = await post(r.id, pii(`TEST-S body ${uniq()}`), p.medCookie, cmid);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, message: { mine: true, by: shortStaffName(p.med.staffName), team: 'Medical' } });
    expect(first.body.message.by).toMatch(/^TEST-S [A-Z0-9]\.$/);
    const again = await post(r.id, 'different text', p.medCookie, cmid);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.message.id).toBe(first.body.message.id);
    expect(psql(`select count(*) from lp_messages where client_mutation_id = '${cmid}'`)).toBe('1');
    expect(psql(`select count(*) from audit_events where action_type = 'message_posted' and patient_id = '${r.id}'`)).toBe('1');
    expect((await post(r.id, 'x', p.fohCookie, cmid)).status).toBe(422);
  });

  it('works at every status, closed requests included', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    const cancelled = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: r.rowVersion }, cookie: p.fohCookie });
    expect(cancelled.status).toBe(200);
    expect((await post(r.id, 'Friend left the area', p.fohCookie)).status).toBe(201);
    expect((await thread(r.id, p.medCookie)).messages.map((m) => m.body)).toEqual(['Friend left the area']);
  });

  it('allows 20 messages a minute per staff, then 429 with Retry-After', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    for (let i = 0; i < 20; i += 1) expect((await post(r.id, `m${i}`, p.fohCookie)).status).toBe(201);
    const limited = await post(r.id, 'one too many', p.fohCookie);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({ error: { code: 'rate_limited' } });
    // Someone else is not limited by it.
    expect((await post(r.id, 'from medical', p.medCookie)).status).toBe(201);
  });
});

describe('the thread, unread and receipts', () => {
  it('oldest first, mine for the caller, never anyone\'s full name; "Earlier messages" pages back', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    // 105 synthetic messages straight into the table (the API limit is 20 a minute).
    psql(`insert into lp_messages (request_id, staff, staff_key, team, body, client_mutation_id, created_at)
          select '${r.id}', '${staffOf(p.med)}', lp_canon_staff('${staffOf(p.med)}'), 'Medical', 'n' || g, gen_random_uuid(),
                 clock_timestamp() - make_interval(secs => 200 - g)
          from generate_series(1, 105) g`);
    const first = await thread(r.id, p.fohCookie);
    expect(first.messages).toHaveLength(100);
    expect(first.hasEarlier).toBe(true);
    expect(first.messages[0]?.body).toBe('n6');
    expect(first.messages[99]?.body).toBe('n105');
    expect(first.messages.every((m) => !m.mine && m.by === shortStaffName(p.med.staffName) && m.team === 'Medical')).toBe(true);
    const oldest = first.messages[0] as { createdAt: string; id: string };
    const earlier = await thread(r.id, p.fohCookie, `?${new URLSearchParams({ beforeAt: oldest.createdAt, beforeId: oldest.id })}`);
    expect(earlier.messages.map((m) => m.body)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(earlier.hasEarlier).toBe(false);
    expect((await api(`/api/requests/${r.id}/messages?beforeAt=${encodeURIComponent(oldest.createdAt)}`, { cookie: p.fohCookie })).status).toBe(400);
  });

  it('unread counts other people\'s messages after my cursor; reading moves it; "Read" shows once someone else read mine', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    const ask = await post(r.id, 'Any tattoos or marks?', p.medCookie);
    // The sender never has their own message unread; the receipt says Delivered.
    expect((await rowFor(r.id, p.medCookie)).unread).toBe(0);
    let medThread = await thread(r.id, p.medCookie);
    expect(medThread.receipt).toEqual({ messageId: ask.body.message.id, readAt: null });
    expect((await rowFor(r.id, p.fohCookie)).unread).toBe(1);
    // Read up to the newest on screen.
    const read = await api(`/api/requests/${r.id}/messages/read`, { json: { upto: ask.body.message.createdAt }, cookie: p.fohCookie });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ changed: true, activity: { unread: 0 } });
    // Nothing new: nothing written.
    expect((await api(`/api/requests/${r.id}/messages/read`, { json: {}, cookie: p.fohCookie })).body.changed).toBe(false);
    medThread = await thread(r.id, p.medCookie);
    expect(medThread.receipt?.messageId).toBe(ask.body.message.id);
    expect(medThread.receipt?.readAt).toMatch(/^\d{4}-/);
    // A message after the cursor is unread again.
    await post(r.id, 'Do you have a photo?', p.medCookie);
    expect((await rowFor(r.id, p.fohCookie)).unread).toBe(1);
    // Reads are never audited.
    expect(psql(`select count(*) from audit_events where patient_id = '${r.id}' and action_type not in ('patient_created', 'message_posted')`)).toBe('0');
  });

  it('the preview is at most 120 characters, "mine" for the sender', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    await post(r.id, `${'z'.repeat(200)}`, p.fohCookie);
    const mine = await rowFor(r.id, p.fohCookie);
    expect(mine.lastMessage?.mine).toBe(true);
    expect(Array.from(mine.lastMessage?.text ?? '')).toHaveLength(120);
    expect((await rowFor(r.id, p.medCookie)).lastMessage).toMatchObject({ mine: false, by: shortStaffName(p.foh.staffName) });
  });

  it('unsend: only mine, within 15 minutes, gone for everyone, kept in the audit and the table', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    const m = await post(r.id, 'Wrong request', p.fohCookie);
    const other = await createRequest(p.foh);
    const path = `/api/requests/${r.id}/messages/${m.body.message.id}/unsend`;
    expect((await api(path, { json: {}, cookie: p.medCookie })).status).toBe(403);
    expect((await api(`/api/requests/${other.id}/messages/${m.body.message.id}/unsend`, { json: {}, cookie: p.fohCookie })).status).toBe(404);
    const done = await api(path, { json: {}, cookie: p.fohCookie });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ changed: true, activity: { messageCount: 0, lastMessage: null } });
    expect((await api(path, { json: {}, cookie: p.fohCookie })).body.changed).toBe(false);
    expect((await thread(r.id, p.medCookie)).messages).toHaveLength(0);
    expect((await rowFor(r.id, p.medCookie)).messageCount).toBe(0);
    expect(psql(`select (unsent_at is not null)::text from lp_messages where id = '${m.body.message.id}'`)).toBe('true');
    expect(psql(`select count(*) from audit_events where patient_id = '${r.id}' and action_type = 'message_unsent'`)).toBe('1');
    // Too late after 15 minutes.
    const late = await post(r.id, 'Old one', p.fohCookie);
    psql(`update lp_messages set created_at = clock_timestamp() - interval '16 minutes' where id = '${late.body.message.id}'`);
    const refused = await api(`/api/requests/${r.id}/messages/${late.body.message.id}/unsend`, { json: {}, cookie: p.fohCookie });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: { field: 'message' } });
  });
});

describe('needsInfo (derived)', () => {
  it('medical asks → true; front of house replies → false; medical asks again → true; any status change → false', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    expect((await rowFor(r.id, p.fohCookie)).needsInfo).toBe(false);
    await post(r.id, 'Any tattoos or marks?', p.medCookie);
    expect((await rowFor(r.id, p.fohCookie)).needsInfo).toBe(true);
    expect((await rowFor(r.id, p.medCookie)).needsInfo).toBe(true);
    await post(r.id, 'Butterfly tattoo, left wrist', p.fohCookie);
    expect((await rowFor(r.id, p.fohCookie)).needsInfo).toBe(false);
    await post(r.id, 'Which wrist again?', p.medCookie);
    expect((await rowFor(r.id, p.fohCookie)).needsInfo).toBe(true);
    // In medical, then back to Waiting for check: still clear (the question was before the status change).
    const inMed = await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    expect((await rowFor(r.id, p.fohCookie)).needsInfo).toBe(false);
    await setStatus(inMed, STATUS.waiting, 'change', p.medCookie);
    expect((await rowFor(r.id, p.fohCookie)).needsInfo).toBe(false);
    // A new question asks again.
    await post(r.id, 'Still here?', p.medCookie);
    expect((await rowFor(r.id, p.fohCookie)).needsInfo).toBe(true);
  });
});

describe('sync and the detail carry the activity', () => {
  it('a delta brings a request whose thread changed although its row did not', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    // The row's own change is older than the 30 s overlap by the time the delta is asked for.
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    const first = await api<SyncResponse>(syncPath({ ids: [r.id] }), { cookie: p.fohCookie });
    const cursor = first.body.serverTime;
    expect((await api<SyncResponse>(syncPath({ since: cursor }), { cookie: p.fohCookie })).body.rows.some((x) => x.id === r.id)).toBe(false);
    await post(r.id, 'Any tattoos or marks?', p.medCookie);
    const delta = await api<SyncResponse>(syncPath({ since: cursor }), { cookie: p.fohCookie });
    const row = delta.body.rows.find((x) => x.id === r.id);
    expect(row).toMatchObject({ rowVersion: r.rowVersion, messageCount: 1, unread: 1, needsInfo: true, lastMessage: { text: 'Any tattoos or marks?' } });
    // My read on another phone (same staff) comes back the same way: lp_messages_sync adds the row.
    const since = psql('select clock_timestamp()::text');
    await api(`/api/requests/${r.id}/messages/read`, { json: {}, cookie: await cookieFor(p.foh) });
    const changed = psql(`select string_agg(x ->> 'id', ',') from jsonb_array_elements(lp_messages_sync('${staffOf(p.foh)}', '{}'::uuid[], '${since}'::timestamptz + interval '30 seconds', true) -> 'threads') x where x ->> 'id' = '${r.id}'`);
    expect(changed).toBe(r.id);
    expect((await rowFor(r.id, p.fohCookie)).unread).toBe(0);
  }, 60_000);

  it('every sync row has the activity fields (zeros without messages); the detail adds the thread and leaves messages out of the audit trail', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    const quiet = await rowFor(r.id, p.fohCookie);
    expect(quiet).toMatchObject({ messageCount: 0, unread: 0, needsInfo: false, lastMessage: null, enroute: null, lastMessageAt: null });
    await post(r.id, 'Friend is still here', p.fohCookie);
    const detail = (await api<RequestDetail>(`/api/requests/${r.id}`, { cookie: p.medCookie })).body;
    expect(detail.thread?.messages.map((m) => m.body)).toEqual(['Friend is still here']);
    expect(detail).toMatchObject({ messageCount: 1, unread: 1 });
    expect(detail.audit.map((a) => a.action)).toEqual(['created']);
  });
});

describe('en route', () => {
  it('only while In medical: accepted and ignored before; set, change, a repeat, a second person, cancel, arrive', async () => {
    const p = await people();
    const other = await cookieFor(newStaff());
    const r = await createRequest(p.foh);
    expect(await enroute(r.id, { action: 'set', etaMinutes: 5 }, p.fohCookie)).toMatchObject({ changed: false, ignored: true });
    await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    const set = await enroute(r.id, { action: 'set', etaMinutes: 5 }, p.fohCookie);
    expect(set.changed).toBe(true);
    expect(set.activity.enroute).toMatchObject({ count: 1, state: 'enroute', mine: { etaMinutes: 5 } });
    const eta = Date.parse(set.activity.enroute?.earliestEta ?? '');
    expect(eta - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(eta - Date.now()).toBeLessThan(6 * 60_000);
    // A queued tap keeps its ETA: 3 minutes queued → ~2 minutes left.
    const queued = await enroute(r.id, { action: 'set', etaMinutes: 5, queuedMs: 180_000 }, other);
    expect(Date.parse(queued.activity.enroute?.mine?.etaAt ?? '') - Date.now()).toBeLessThan(2.5 * 60_000);
    expect(queued.activity.enroute).toMatchObject({ count: 2 });
    expect(Date.parse(queued.activity.enroute?.earliestEta ?? '')).toBeLessThan(eta);
    // A repeat changes nothing; a change is a change.
    expect((await enroute(r.id, { action: 'set', etaMinutes: 5 }, p.fohCookie)).changed).toBe(false);
    expect((await enroute(r.id, { action: 'set', etaMinutes: 10 }, p.fohCookie)).changed).toBe(true);
    // Medical sees it read-only (no mine), no names anywhere.
    const medRow = await rowFor(r.id, p.medCookie);
    expect(medRow.enroute).toMatchObject({ count: 2, state: 'enroute', mine: null });
    expect(JSON.stringify(medRow.enroute)).not.toMatch(/TEST-S/);
    // Cancel clears only mine; Undo puts the exact ETA back.
    const before = (await rowFor(r.id, p.fohCookie)).enroute?.mine?.etaAt ?? null;
    const cancelled = await enroute(r.id, { action: 'cancel' }, p.fohCookie);
    expect(cancelled.activity.enroute).toMatchObject({ count: 1, mine: null });
    expect((await enroute(r.id, { action: 'cancel' }, p.fohCookie)).changed).toBe(false);
    const undone = await enroute(r.id, { action: 'set', etaAt: before, etaMinutes: 10 }, p.fohCookie);
    expect(undone.activity.enroute?.mine?.etaAt).toBe(before);
    // Arrived wins over everyone en route: the other walker's row is arrived too (nobody is stranded).
    const arrived = await enroute(r.id, { action: 'arrive' }, p.fohCookie);
    expect(arrived.activity.enroute).toMatchObject({ state: 'arrived' });
    expect((await enroute(r.id, { action: 'arrive' }, p.fohCookie)).changed).toBe(false);
    expect((await rowFor(r.id, other)).enroute).toMatchObject({ state: 'arrived', mine: { state: 'arrived' } });
    expect((await enroute(r.id, { action: 'arrive' }, other)).changed).toBe(false);
    expect(psql(`select string_agg(state, ',') from lp_enroute where request_id = '${r.id}'`)).toBe('arrived,arrived');
    expect(psql(`select new_value ->> 'also_arrived' from audit_events where patient_id = '${r.id}' and action_type = 'enroute' order by occurred_at desc limit 1`)).toBe('1');
    // Audit rows (one per change) with the staff key, for the export and Time to arrive.
    expect(psql(`select string_agg(new_value ->> 'state', ',' order by occurred_at) from audit_events where patient_id = '${r.id}' and action_type = 'enroute'`))
      .toBe('enroute,enroute,changed,cancelled,enroute,arrived');
    // Validation.
    expect((await api(`/api/requests/${r.id}/enroute`, { json: { action: 'set', etaMinutes: 7 }, cookie: p.fohCookie })).status).toBe(422);
    expect((await api(`/api/requests/${r.id}/enroute`, { json: { action: 'cancel', etaMinutes: 5 }, cookie: p.fohCookie })).status).toBe(422);
    expect((await api(`/api/requests/${r.id}/enroute`, { json: { action: 'fly' }, cookie: p.fohCookie })).status).toBe(422);
  });

  it.each([
    ['Reunited', STATUS.reunited, 'reunite'],
    ['Not in medical', STATUS.notInMedical, 'change'],
    ['Back to Waiting for check', STATUS.waiting, 'change'],
    ['Discharged', STATUS.discharged, 'discharge'],
  ])('%s clears every en route in the same transaction (one audit row, no names)', async (_label, status, kind) => {
    const p = await people();
    const r = await createRequest(p.foh);
    const inMed = await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    await enroute(r.id, { action: 'set', etaMinutes: 5 }, p.fohCookie);
    await enroute(r.id, { action: 'set', etaMinutes: null }, await cookieFor(newStaff()));
    expect(psql(`select count(*) from lp_enroute where request_id = '${r.id}'`)).toBe('2');
    await setStatus(inMed, status, kind, p.medCookie);
    expect(psql(`select count(*) from lp_enroute where request_id = '${r.id}'`)).toBe('0');
    expect(psql(`select new_value ->> 'state' from audit_events where patient_id = '${r.id}' and action_type = 'enroute' order by occurred_at desc limit 1`)).toBe('cleared');
    expect((await rowFor(r.id, p.fohCookie)).enroute).toBeNull();
  });

  it('a reopened request keeps its thread and starts with nobody en route', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    const inMed = await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    await post(r.id, 'Bring 1 person only', p.medCookie);
    await enroute(r.id, { action: 'set', etaMinutes: 5 }, p.fohCookie);
    const reunited = await setStatus(inMed, STATUS.reunited, 'reunite', p.medCookie);
    // Reopened later than the Undo window (the clearing is backdated by a minute).
    psql(`update audit_events set occurred_at = occurred_at - interval '1 minute' where patient_id = '${r.id}' and action_type = 'enroute'`);
    await setStatus(reunited, STATUS.inMedical, 'reopen', p.medCookie);
    const row = await rowFor(r.id, p.fohCookie);
    expect(row).toMatchObject({ messageCount: 1, enroute: null });
  });

  it.each([
    ['Reunited', STATUS.reunited, 'reunite'],
    ['Not in medical', STATUS.notInMedical, 'change'],
    ['Discharged', STATUS.discharged, 'discharge'],
  ])('Undo of %s puts every en route back as it was', async (_label, status, kind) => {
    const p = await people();
    const walker = await cookieFor(newStaff('GC/HX - Base'));
    const r = await createRequest(p.foh);
    const inMed = await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    await enroute(r.id, { action: 'set', etaMinutes: 10 }, p.fohCookie);
    await enroute(r.id, { action: 'set', etaMinutes: 5 }, walker);
    const before = (await rowFor(r.id, p.fohCookie)).enroute;
    const snapshot = () => psql(`select string_agg(staff || '/' || state || '/' || coalesce(eta_minutes::text, '-') || '/' || coalesce(eta_at::text, '-'), ',' order by staff) from lp_enroute where request_id = '${r.id}'`);
    const rows = snapshot();
    const closed = await setStatus(inMed, status, kind, p.medCookie);
    expect(psql(`select count(*) from lp_enroute where request_id = '${r.id}'`)).toBe('0');
    await setStatus(closed, STATUS.inMedical, 'undo', p.medCookie);
    expect(snapshot()).toBe(rows);
    expect((await rowFor(r.id, p.fohCookie)).enroute).toEqual(before);
    expect(psql(`select new_value ->> 'state' from audit_events where patient_id = '${r.id}' and action_type = 'enroute' order by occurred_at desc limit 1`)).toBe('restored');
    // Once only: a second round trip with nobody en route in between brings nothing back from the first.
    await enroute(r.id, { action: 'cancel' }, p.fohCookie);
    await enroute(r.id, { action: 'cancel' }, walker);
    const again = await setStatus(await rowFor(r.id, p.medCookie), status, kind, p.medCookie);
    await setStatus(again, STATUS.inMedical, 'undo', p.medCookie);
    expect(psql(`select count(*) from lp_enroute where request_id = '${r.id}'`)).toBe('0');
  });
});

describe('lp_involved_staff and permissions', () => {
  it('logger, answerer, location setter, everyone who messaged and everyone en route, canonical', async () => {
    const p = await people();
    const writer = newStaff();
    const walker = newStaff('GC/HX - Base');
    const r = await createRequest(p.foh);
    const inMed = await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    const locator = newStaff('Medical');
    expect((await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { medicalLocation: 'Chair 9' }, expectedVersion: inMed.rowVersion }, cookie: await cookieFor(locator) })).status).toBe(200);
    await post(r.id, 'Hi', await cookieFor(writer));
    await enroute(r.id, { action: 'set', etaMinutes: null }, await cookieFor(walker));
    const involved = psql(`select string_agg(s, '|') from lp_involved_staff('${r.id}') s`).split('|').sort();
    const expected = [p.foh, p.med, locator, writer, walker].map((s) => canonStaff(staffOf(s)) as string).sort();
    expect(involved).toEqual(expected);
    // Someone who only looked is not involved.
    expect(involved).not.toContain(canonStaff(staffOf(newStaff())));
  });

  it('only service_role may execute the functions; the tables have RLS on', () => {
    const fns = ['lp_post_message', 'lp_mark_read', 'lp_set_enroute', 'lp_unsend_message', 'lp_involved_staff', 'lp_messages_thread', 'lp_messages_sync', 'lp_enroute_stats', 'lp_messages_activity', 'lp_enroute_summary', 'lp_messages_json'];
    const out = psql(`select string_agg(distinct has_function_privilege('service_role', p.oid, 'execute')::text || '/' ||
                         has_function_privilege('anon', p.oid, 'execute')::text || '/' || has_function_privilege('authenticated', p.oid, 'execute')::text, ',')
                      from pg_proc p where p.proname in (${fns.map((f) => `'${f}'`).join(', ')})`);
    expect(out).toBe('true/false/false');
    expect(psql(`select count(*) from pg_proc where proname in (${fns.map((f) => `'${f}'`).join(', ')})`)).toBe(String(fns.length));
    expect(psql(`select string_agg(relname || ':' || relrowsecurity::text, ',' order by relname) from pg_class where relname in ('lp_messages', 'lp_message_reads', 'lp_enroute')`))
      .toBe('lp_enroute:true,lp_message_reads:true,lp_messages:true');
    expect(psql(`select has_table_privilege('anon', 'public.lp_messages', 'select')::text`)).toBe('false');
    // The mutating RPCs carry the function-level timeouts (A7).
    expect(psql(`select proconfig::text from pg_proc where proname = 'lp_post_message'`)).toMatch(/statement_timeout=4s.*lock_timeout=2s|lock_timeout=2s.*statement_timeout=4s/);
  });
});

describe('dashboard stats', () => {
  it('friendsEnRoute counts requests with someone en route now; avgArriveMinutes averages en route → arrived', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    const before = (await api<Stats>('/api/stats', { cookie: p.fohCookie })).body;
    expect(typeof before.friendsEnRoute).toBe('number');
    await enroute(r.id, { action: 'set', etaMinutes: 5 }, p.fohCookie);
    const during = (await api<Stats>('/api/stats', { cookie: p.fohCookie })).body;
    expect(during.friendsEnRoute).toBe((before.friendsEnRoute ?? 0) + 1);
    await enroute(r.id, { action: 'arrive' }, p.fohCookie);
    const after = (await api<Stats>('/api/stats', { cookie: p.fohCookie })).body;
    expect(after.friendsEnRoute).toBe(before.friendsEnRoute);
    expect(typeof after.avgArriveMinutes).toBe('number');
    expect(after).toHaveProperty('open');
  });

  it('friendsEnRoute leaves out a request whose friend arrived, even with a stale en route row on it', async () => {
    const p = await people();
    const walker = newStaff('GC/HX - Base');
    const r = await createRequest(p.foh);
    await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    const base = Number(psql(`select lp_enroute_stats() ->> 'friendsEnRoute'`));
    await enroute(r.id, { action: 'set', etaMinutes: 5 }, p.fohCookie);
    await enroute(r.id, { action: 'set', etaMinutes: 10 }, await cookieFor(walker));
    expect(Number(psql(`select lp_enroute_stats() ->> 'friendsEnRoute'`))).toBe(base + 1);
    await enroute(r.id, { action: 'arrive' }, p.fohCookie);
    expect(Number(psql(`select lp_enroute_stats() ->> 'friendsEnRoute'`))).toBe(base);
    // A late tap (queued offline) puts someone back to 'enroute' after the friend arrived: still not counted.
    await enroute(r.id, { action: 'set', etaMinutes: 5 }, await cookieFor(walker));
    expect(psql(`select string_agg(state, ',' order by state) from lp_enroute where request_id = '${r.id}'`)).toBe('arrived,enroute');
    expect(Number(psql(`select lp_enroute_stats() ->> 'friendsEnRoute'`))).toBe(base);
  });
});

describe('the migration', () => {
  it('runs again over messages, reads and en route without losing any', async () => {
    const p = await people();
    const r = await createRequest(p.foh);
    await setStatus(r, STATUS.inMedical, 'answer', p.medCookie);
    await post(r.id, 'Kept', p.medCookie);
    await enroute(r.id, { action: 'set', etaMinutes: 5 }, p.fohCookie);
    await api(`/api/requests/${r.id}/messages/read`, { json: {}, cookie: p.fohCookie });
    const count = () => psql(`select (select count(*) from lp_messages where request_id = '${r.id}') || '/' || (select count(*) from lp_enroute where request_id = '${r.id}') || '/' || (select count(*) from lp_message_reads where request_id = '${r.id}')`);
    expect(count()).toBe('1/1/1');
    execFileSync('psql', [dbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(ROOT, 'supabase', 'migrations', '20261106000000_rework.sql')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(count()).toBe('1/1/1');
    // PostgREST reloads its schema; the API keeps answering.
    for (let i = 0; i < 40; i += 1) {
      const res = await api(`/api/requests/${r.id}/messages`, { cookie: p.fohCookie });
      if (res.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect((await thread(r.id, p.fohCookie)).messages.map((m) => m.body)).toEqual(['Kept']);
  }, 60_000);
});

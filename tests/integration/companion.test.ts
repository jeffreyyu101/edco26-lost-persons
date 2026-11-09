// (Companion) 20261108120000_companion.sql through the real routes: the intake field, Located · already accompanied,
// the friend swap (POST /api/requests/:id/swap: request → the answerer, approve → everyone involved, decline → the
// requester and the creator), Friend informed and its Undo, sync / detail payloads, stats and the inactive close.
import { describe, expect, it } from 'vitest';
import type { RequestDetail, RequestSummary, Stats, SyncResponse } from '@/lib/api-types';
import { STATUS } from '@/lib/domain';
import { admin, api, cookieFor, createRequest, newStaff, psql, staffOf, withTestServer, type Staff } from './harness';
import { eventually } from './push-service';

withTestServer();

const FOH = newStaff('GC/HX - Dispatch');
const ANSWERER = newStaff('GC/HX - Special Operations/Med Transpo');
const ASKER = newStaff('GC/HX - Command');
const OTHER = newStaff('GC/HX - Base');

const canon = (s: Staff) => staffOf(s).toLowerCase();
const lit = (id: string) => `'${id.replace(/'/g, "''")}'`;

async function setStatus(staff: Staff, r: Pick<RequestSummary, 'id' | 'rowVersion'>, status: string, kind = 'answer') {
  return api(`/api/requests/${r.id}/status`, { json: { status, expectedVersion: r.rowVersion, kind }, cookie: await cookieFor(staff) });
}

async function swap(staff: Staff, r: Pick<RequestSummary, 'id' | 'rowVersion'>, body: Record<string, unknown>) {
  return api(`/api/requests/${r.id}/swap`, { json: { ...body, expectedVersion: r.rowVersion }, cookie: await cookieFor(staff) });
}

async function activity(requestId: string, staff: Staff) {
  const { data, error } = await admin().from('lp_activity').select('kind, detail, actor').eq('request_id', requestId).eq('staff', canon(staff)).maybeSingle();
  if (error) throw new Error(error.code);
  return data as { kind: string; detail: string; actor: string } | null;
}

/** Waits until `staff`'s Activity row for the request is of `kind`. */
async function activityOf(requestId: string, staff: Staff, kind: string) {
  return eventually(async () => {
    const row = await activity(requestId, staff);
    return row?.kind === kind ? row : null;
  });
}

/** A request logged by FOH at FA 4 and answered Located · already accompanied by ANSWERER. */
async function accompanied(extra: Record<string, unknown> = {}): Promise<RequestSummary> {
  const r = await createRequest(FOH, { reportingLocation: 'FA 4 – Oasis', ...extra });
  const res = await setStatus(ANSWERER, r, STATUS.accompanied);
  expect(res.status, res.text).toBe(200);
  return res.body.request as RequestSummary;
}

describe('intake: friendInMedical', () => {
  it('defaults to unsure; yes keeps a trimmed name; no or unsure never keeps one', async () => {
    const plain = await createRequest(FOH);
    expect(plain.friendInMedical).toBe('unsure');
    expect(plain.friendInMedicalName).toBeNull();
    expect(plain.swapRequestedAt).toBeNull();
    expect(plain.swapPlace).toBeNull();

    const yes = await createRequest(FOH, { friendInMedical: 'yes', friendInMedicalName: '  Sam  ' });
    expect(yes.friendInMedical).toBe('yes');
    expect(yes.friendInMedicalName).toBe('Sam');

    const no = await createRequest(FOH, { friendInMedical: 'no', friendInMedicalName: 'Sam' });
    expect(no.friendInMedical).toBe('no');
    expect(no.friendInMedicalName).toBeNull();

    const bad = await api('/api/requests', { json: { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 3 – Kinetic', friendInMedical: 'maybe' }, cookie: await cookieFor(FOH) });
    expect(bad.status).toBe(422);
    const long = await api('/api/requests', {
      json: { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 3 – Kinetic', friendInMedical: 'yes', friendInMedicalName: 'x'.repeat(61) },
      cookie: await cookieFor(FOH),
    });
    expect(long.status).toBe(422);
  });

  it('PATCH changes it; leaving yes clears the name', async () => {
    const r = await createRequest(FOH, { friendInMedical: 'yes', friendInMedicalName: 'Sam' });
    const res = await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { friendInMedical: 'no' }, expectedVersion: r.rowVersion }, cookie: await cookieFor(FOH) });
    expect(res.status, res.text).toBe(200);
    expect(res.body.request.friendInMedical).toBe('no');
    expect(res.body.request.friendInMedicalName).toBeNull();
  });

  it('a new request with yes says "friend may be with them" in the new_request detail', async () => {
    const { newRequestDetail } = await import('@/lib/activity');
    const r = await createRequest(FOH, { friendInMedical: 'yes' });
    expect(newRequestDetail(r)).toMatch(/ · friend may be with them$/);
  });
});

describe('Located · already accompanied', () => {
  it('answers Waiting → Accompanied (found_at set, no reunion clock) and tells the creator "Don\'t send the friend"', async () => {
    const r = await accompanied();
    expect(r.status).toBe(STATUS.accompanied);
    expect(r.foundAt).not.toBeNull();
    expect(r.reunionStartedAt).toBeNull();
    const row = await activityOf(r.id, FOH, 'accompanied');
    expect(row.detail).toBe("Located · already accompanied · Don't send the friend");
    // The answerer is involved now.
    const { data } = await admin().rpc('lp_involved_staff', { p_request: r.id });
    expect(data as string[]).toContain(canon(ANSWERER));
  });

  it('Change answer: Accompanied ↔ Located · friend coming, and Undo back to Waiting', async () => {
    const r = await accompanied();
    const coming = await setStatus(ANSWERER, r, STATUS.inMedical, 'change');
    expect(coming.status, coming.text).toBe(200);
    const back = await setStatus(ANSWERER, coming.body.request, STATUS.accompanied, 'change');
    expect(back.status, back.text).toBe(200);
    const undo = await setStatus(ANSWERER, back.body.request, STATUS.waiting, 'undo');
    expect(undo.status, undo.text).toBe(200);
    expect(undo.body.request.status).toBe(STATUS.waiting);
  });

  it('Friend informed closes it; Undo reopens Accompanied; Reunited is not a move from Accompanied', async () => {
    const r = await accompanied();
    const informed = await setStatus(ANSWERER, r, STATUS.friendInformed, 'inform');
    expect(informed.status, informed.text).toBe(200);
    expect(informed.body.request.status).toBe(STATUS.friendInformed);
    expect(informed.body.request.closedAt).not.toBeNull();
    expect((await activityOf(r.id, FOH, 'friend_informed')).detail).toBe('Friend informed');
    const undo = await setStatus(ANSWERER, informed.body.request, STATUS.accompanied, 'undo');
    expect(undo.status, undo.text).toBe(200);
    expect(undo.body.request.closedAt).toBeNull();
    const reunite = await setStatus(ANSWERER, undo.body.request, STATUS.reunited, 'reunite');
    expect(reunite.status).toBe(422);
  });
});

describe('POST /api/requests/:id/swap', () => {
  it('request → the answerer only; repeat is {changed: false}; approve at the tent → In medical, everyone involved told', async () => {
    const r = await accompanied();
    await activityOf(r.id, FOH, 'accompanied');
    const asked = await swap(ASKER, r, { action: 'request' });
    expect(asked.status, asked.text).toBe(200);
    expect(asked.body.changed).toBe(true);
    const q = asked.body.request as RequestSummary;
    expect(q.status).toBe(STATUS.accompanied);
    expect(q.swapRequestedBy).toBe(staffOf(ASKER));
    expect(q.swapRequestedAt).not.toBeNull();
    const told = await activityOf(r.id, ANSWERER, 'swap_requested');
    expect(told.detail).toBe('Friend swap requested · FA 4 · decide where');
    // The creator is not told about the request (only the answerer decides).
    expect((await activity(r.id, FOH))?.kind).toBe('accompanied');

    const again = await swap(ASKER, q, { action: 'request' });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);

    const approved = await swap(ANSWERER, q, { action: 'approve', place: 'fa' });
    expect(approved.status, approved.text).toBe(200);
    const a = approved.body.request as RequestSummary;
    expect(a.status).toBe(STATUS.inMedical);
    expect(a.swapPlace).toBe('fa');
    expect(a.swapRequestedAt).toBeNull();
    expect(a.swapRequestedBy).toBeNull();
    expect(a.reunionStartedAt).not.toBeNull();
    expect((await activityOf(r.id, ASKER, 'swap_approved')).detail).toBe('Swap at FA 4');
    expect((await activityOf(r.id, FOH, 'swap_approved')).detail).toBe('Swap at FA 4');

    // Swap done is the existing Reunited.
    const done = await setStatus(ANSWERER, a, STATUS.reunited, 'reunite');
    expect(done.status, done.text).toBe(200);
    expect(done.body.request.swapPlace).toBe('fa');
  });

  it('approve at Main Med reads "Swap at Main Med"', async () => {
    const r = await accompanied();
    const asked = (await swap(ASKER, r, { action: 'request' })).body.request as RequestSummary;
    const approved = await swap(ANSWERER, asked, { action: 'approve', place: 'mm' });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.request.swapPlace).toBe('mm');
    expect((await activityOf(r.id, ASKER, 'swap_approved')).detail).toBe('Swap at Main Med');
  });

  it('decline → stays Accompanied, the requester and the creator told; withdraw tells nobody', async () => {
    const r = await accompanied();
    const asked = (await swap(ASKER, r, { action: 'request' })).body.request as RequestSummary;
    await activityOf(r.id, ANSWERER, 'swap_requested');
    const declined = await swap(ANSWERER, asked, { action: 'decline' });
    expect(declined.status, declined.text).toBe(200);
    const d = declined.body.request as RequestSummary;
    expect(d.status).toBe(STATUS.accompanied);
    expect(d.swapRequestedAt).toBeNull();
    expect((await activityOf(r.id, ASKER, 'swap_declined')).detail).toBe('Swap declined');
    expect((await activityOf(r.id, FOH, 'swap_declined')).detail).toBe('Swap declined');

    const again = (await swap(OTHER, d, { action: 'request' })).body.request as RequestSummary;
    const withdrawn = await swap(OTHER, again, { action: 'withdraw' });
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect(withdrawn.body.request.swapRequestedAt).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await activity(r.id, ASKER))?.kind).toBe('swap_declined');
  });

  it('cancel from requested → stays Accompanied, the answerer told "Swap request cancelled"; repeat is {changed: false}', async () => {
    const r = await accompanied();
    const asked = (await swap(ASKER, r, { action: 'request' })).body.request as RequestSummary;
    await activityOf(r.id, ANSWERER, 'swap_requested');
    const cancelled = await swap(ASKER, asked, { action: 'cancel' });
    expect(cancelled.status, cancelled.text).toBe(200);
    const c = cancelled.body.request as RequestSummary;
    expect(c.status).toBe(STATUS.accompanied);
    expect(c.swapRequestedAt).toBeNull();
    expect(c.swapRequestedBy).toBeNull();
    expect((await activityOf(r.id, ANSWERER, 'swap_cancelled')).detail).toBe('Swap request cancelled');
    const again = await swap(ASKER, c, { action: 'cancel' });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
  });

  it('cancel from approved → back to Accompanied, swapPlace cleared, everyone involved told "Swap cancelled"; Reunited → 422', async () => {
    const r = await accompanied();
    const asked = (await swap(ASKER, r, { action: 'request' })).body.request as RequestSummary;
    const approved = (await swap(ANSWERER, asked, { action: 'approve', place: 'mm' })).body.request as RequestSummary;
    const cancelled = await swap(ANSWERER, approved, { action: 'cancel' });
    expect(cancelled.status, cancelled.text).toBe(200);
    const c = cancelled.body.request as RequestSummary;
    expect(c.status).toBe(STATUS.accompanied);
    expect(c.swapPlace).toBeNull();
    expect(c.reunionStartedAt).toBeNull();
    expect((await activityOf(r.id, ASKER, 'swap_cancelled')).detail).toBe('Swap cancelled');
    expect((await activityOf(r.id, FOH, 'swap_cancelled')).detail).toBe('Swap cancelled');

    const asked2 = (await swap(ASKER, c, { action: 'request' })).body.request as RequestSummary;
    const approved2 = (await swap(ANSWERER, asked2, { action: 'approve', place: 'fa' })).body.request as RequestSummary;
    const done = (await setStatus(ANSWERER, approved2, STATUS.reunited, 'reunite')).body.request as RequestSummary;
    expect((await swap(ANSWERER, done, { action: 'cancel' })).status).toBe(422);
  });

  it('a status change ends an open swap request', async () => {
    const r = await accompanied();
    const asked = (await swap(ASKER, r, { action: 'request' })).body.request as RequestSummary;
    const informed = await setStatus(ANSWERER, asked, STATUS.friendInformed, 'inform');
    expect(informed.status, informed.text).toBe(200);
    expect(informed.body.request.swapRequestedAt).toBeNull();
  });

  it('not Accompanied → 422; stale version → 409; bad body → 422', async () => {
    const waiting = await createRequest(FOH);
    const notYet = await swap(ASKER, waiting, { action: 'request' });
    expect(notYet.status).toBe(422);
    expect(notYet.body.error.currentStatus).toBe(STATUS.waiting);

    const r = await accompanied();
    const stale = await swap(ASKER, { id: r.id, rowVersion: r.rowVersion - 1 }, { action: 'request' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.currentStatus).toBe(STATUS.accompanied);

    expect((await swap(ANSWERER, r, { action: 'approve' })).status).toBe(422);
    expect((await swap(ANSWERER, r, { action: 'approve', place: 'tent' })).status).toBe(422);
    expect((await swap(ANSWERER, r, { action: 'nope' })).status).toBe(422);
  });
});

describe('payloads, stats, inactive close', () => {
  it('sync and the detail carry the new fields', async () => {
    const r = await accompanied({ friendInMedical: 'yes', friendInMedicalName: 'Sam' });
    const asked = (await swap(ASKER, r, { action: 'request' })).body.request as RequestSummary;
    const sync = (await api(`/api/sync?ids=${r.id}`, { cookie: await cookieFor(FOH) })).body as SyncResponse;
    const row = sync.rows[0] as RequestSummary;
    expect(row).toMatchObject({ friendInMedical: 'yes', friendInMedicalName: 'Sam', swapRequestedBy: staffOf(ASKER), swapPlace: null });
    expect(row.swapRequestedAt).toBe(asked.swapRequestedAt);
    const detail = (await api(`/api/requests/${r.id}`, { cookie: await cookieFor(FOH) })).body as RequestDetail;
    expect(detail.friendInMedical).toBe('yes');
    expect(detail.swapRequestedBy).toBe(staffOf(ASKER));
  });

  it('stats: Accompanied is In medical / located; a swap request needs attention (kind swap); Friend informed is counted', async () => {
    const r = await accompanied();
    await swap(ASKER, r, { action: 'request' });
    const stats = (await api('/api/stats?range=tonight', { cookie: await cookieFor(FOH) })).body as Stats;
    expect(stats.open.inMedical).toBeGreaterThanOrEqual(1);
    expect(typeof stats.friendInformed).toBe('number');
    expect(stats.live?.located).toBeGreaterThanOrEqual(1);
    // This request's swap is among the needs-attention rows (aggregates only: its id and kind).
    const kind = psql(
      `select x ->> 'kind' from public.lp_stats('event') s, jsonb_array_elements(s #> '{attention,items}') x where x ->> 'id' = ${lit(r.id)}` +
        ` union all select 'swap-not-top-5' where (public.lp_stats('event') #>> '{attention,total}')::int > 5 limit 1`,
    );
    expect(['swap', 'swap-not-top-5']).toContain(kind);
  });

  it('lp_close_inactive closes an idle Accompanied request like In medical, ending its swap request', async () => {
    const r = await accompanied();
    await swap(ASKER, r, { action: 'request' });
    psql(
      `update public.audit_events set occurred_at = occurred_at - interval '61 minutes' where patient_id = ${lit(r.id)};` +
        ` update public.patients set created_at = created_at - interval '61 minutes' where id = ${lit(r.id)};`,
    );
    expect(Number(psql(`select public.lp_close_inactive(array[${lit(r.id)}]::uuid[])`))).toBe(1);
    const { data } = await admin().from('patients').select('status, swap_requested_at').eq('id', r.id).single();
    expect(data).toEqual({ status: STATUS.inactive, swap_requested_at: null });
  });
});

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

  it('a status change ends an open swap request; (post-event) Friend informed over one is a conflict', async () => {
    const r = await accompanied();
    const asked = (await swap(ASKER, r, { action: 'request' })).body.request as RequestSummary;
    const informed = await setStatus(ANSWERER, asked, STATUS.friendInformed, 'inform');
    expect(informed.status, informed.text).toBe(409);
    const changed = await setStatus(ANSWERER, asked, STATUS.notInMedical, 'change');
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body.request.swapRequestedAt).toBeNull();
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

// (Post-event) 20261109120000_companion_post_event.sql: a stale approve, restore (the Undo of Cancel swap / Decline /
// Swap at …), withdraw telling the answerer, the answerer skipping Undo / Reopen, swap_closed, Undo of a change
// bringing a swap request back, Reopen of an Accompanied request closed as inactive or discharged, and the friend's
// clock restarting at a swap approval.
describe('post-event fixes', () => {
  const body = async (res: Awaited<ReturnType<typeof swap>>) => {
    expect(res.status, res.text).toBe(200);
    return res.body.request as RequestSummary;
  };

  it('approve needs an open request: after a decline (or cancel) a stale approve is 422, the decline stands', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    const declined = await body(await swap(OTHER, asked, { action: 'decline' }));
    expect(declined.swapClosed).toBe('declined');
    const late = await swap(ANSWERER, declined, { action: 'approve', place: 'mm' });
    expect(late.status, late.text).toBe(422);
    const { data } = await admin().from('patients').select('status, swap_place').eq('id', r.id).single();
    expect(data).toEqual({ status: STATUS.accompanied, swap_place: null });
  });

  it('an app from before this build undoes its own Cancel swap by approving again at the same place: still allowed, for that person only', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    const approved = await body(await swap(ANSWERER, asked, { action: 'approve', place: 'mm' }));
    const cancelled = await body(await swap(OTHER, approved, { action: 'cancel' }));
    expect((await swap(ASKER, cancelled, { action: 'approve', place: 'mm' })).status).toBe(422);
    expect((await swap(OTHER, cancelled, { action: 'approve', place: 'fa' })).status).toBe(422);
    const again = await body(await swap(OTHER, cancelled, { action: 'approve', place: 'mm' }));
    expect(again).toMatchObject({ status: STATUS.inMedical, swapPlace: 'mm' });
  });

  it('swap_closed says how a request ended: cancelled by anyone, withdrawn; a new request clears it', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    const cancelled = await body(await swap(OTHER, asked, { action: 'cancel' }));
    expect(cancelled.swapClosed).toBe('cancelled');
    const again = await body(await swap(ASKER, cancelled, { action: 'request' }));
    expect(again.swapClosed).toBeNull();
    expect((await body(await swap(ASKER, again, { action: 'withdraw' }))).swapClosed).toBe('withdrawn');
  });

  it('withdraw tells the answerer "Swap request cancelled"', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    await activityOf(r.id, ANSWERER, 'swap_requested');
    await body(await swap(ASKER, asked, { action: 'withdraw' }));
    expect((await activityOf(r.id, ANSWERER, 'swap_cancelled')).detail).toBe('Swap request cancelled');
  });

  it('restore after someone else cancelled the request: back with its original requester and time; the answerer is told again', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    const cancelled = await body(await swap(OTHER, asked, { action: 'cancel' }));
    await activityOf(r.id, ANSWERER, 'swap_cancelled');
    // Only the person who cancelled can take it back.
    expect((await swap(ASKER, cancelled, { action: 'restore' })).status).toBe(422);
    const back = await body(await swap(OTHER, cancelled, { action: 'restore' }));
    expect(back).toMatchObject({ status: STATUS.accompanied, swapRequestedBy: staffOf(ASKER), swapRequestedAt: asked.swapRequestedAt, swapClosed: null });
    expect((await activityOf(r.id, ANSWERER, 'swap_requested')).actor).toBe(staffOf(OTHER));
    // A repeat is a no-op.
    expect((await swap(OTHER, back, { action: 'restore' })).body.changed).toBe(false);
  });

  it('restore after a decline: the request is back (the requester kept)', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    const declined = await body(await swap(ANSWERER, asked, { action: 'decline' }));
    const back = await body(await swap(ANSWERER, declined, { action: 'restore' }));
    expect(back).toMatchObject({ status: STATUS.accompanied, swapRequestedBy: staffOf(ASKER), swapRequestedAt: asked.swapRequestedAt });
  });

  it('restore after Swap at …: Accompanied with the request open again; everyone involved told "Swap cancelled"', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    const approved = await body(await swap(ANSWERER, asked, { action: 'approve', place: 'fa' }));
    await activityOf(r.id, ASKER, 'swap_approved');
    const back = await body(await swap(ANSWERER, approved, { action: 'restore' }));
    expect(back).toMatchObject({ status: STATUS.accompanied, swapPlace: null, swapRequestedBy: staffOf(ASKER), swapRequestedAt: asked.swapRequestedAt, reunionStartedAt: null });
    expect((await activityOf(r.id, ASKER, 'swap_cancelled')).detail).toBe('Swap cancelled');
  });

  it('restore after Cancel swap on an approved swap: the swap is back at the same place, "Swap at …" again', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    const approved = await body(await swap(ANSWERER, asked, { action: 'approve', place: 'mm' }));
    const cancelled = await body(await swap(OTHER, approved, { action: 'cancel' }));
    await activityOf(r.id, ASKER, 'swap_cancelled');
    const back = await body(await swap(OTHER, cancelled, { action: 'restore' }));
    expect(back).toMatchObject({ status: STATUS.inMedical, swapPlace: 'mm', reunionStartedAt: approved.reunionStartedAt });
    expect((await activityOf(r.id, ASKER, 'swap_approved')).detail).toBe('Swap at Main Med');
  });

  it('the staff who answered skips Undo / Reopen: a swap request after someone undid Friend informed still reaches the answerer', async () => {
    const r = await accompanied();
    const informed = (await setStatus(OTHER, r, STATUS.friendInformed, 'inform')).body.request as RequestSummary;
    const undone = await setStatus(OTHER, informed, STATUS.accompanied, 'undo');
    expect(undone.status, undone.text).toBe(200);
    await body(await swap(OTHER, undone.body.request, { action: 'request' }));
    expect((await activityOf(r.id, ANSWERER, 'swap_requested')).actor).toBe(staffOf(OTHER));
  });

  it('Undo of a change made while a swap was requested brings the request back', async () => {
    const r = await accompanied();
    const asked = await body(await swap(ASKER, r, { action: 'request' }));
    const changed = await setStatus(ANSWERER, asked, STATUS.inMedical, 'change');
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body.request.swapRequestedAt).toBeNull();
    const undone = await setStatus(ANSWERER, changed.body.request, STATUS.accompanied, 'undo');
    expect(undone.status, undone.text).toBe(200);
    expect(undone.body.request).toMatchObject({ status: STATUS.accompanied, swapRequestedAt: asked.swapRequestedAt, swapRequestedBy: staffOf(ASKER) });
  });

  it('Reopen of an Accompanied request closed as inactive, or discharged, goes back to Accompanied ("Don\'t send the friend")', async () => {
    const r = await accompanied();
    psql(
      `update public.audit_events set occurred_at = occurred_at - interval '61 minutes' where patient_id = ${lit(r.id)};` +
        ` update public.patients set created_at = created_at - interval '61 minutes' where id = ${lit(r.id)};`,
    );
    expect(Number(psql(`select public.lp_close_inactive(array[${lit(r.id)}]::uuid[])`))).toBe(1);
    const closed = (await api(`/api/requests/${r.id}`, { cookie: await cookieFor(FOH) })).body as RequestDetail;
    const reopened = await setStatus(OTHER, closed, STATUS.inMedical, 'reopen');
    expect(reopened.status, reopened.text).toBe(200);
    expect(reopened.body.request.status).toBe(STATUS.accompanied);
    const told = await eventually(async () => {
      const row = await activity(r.id, FOH);
      return row?.actor === staffOf(OTHER) ? row : null;
    });
    expect(told.kind).toBe('accompanied');

    const discharged = await setStatus(ANSWERER, reopened.body.request, STATUS.discharged, 'discharge');
    expect(discharged.status, discharged.text).toBe(200);
    const again = await setStatus(OTHER, discharged.body.request, STATUS.inMedical, 'reopen');
    expect(again.body.request.status).toBe(STATUS.accompanied);

    // A plain In medical request closed as inactive still reopens to In medical.
    const plain = await createRequest(FOH);
    const located = (await setStatus(ANSWERER, plain, STATUS.inMedical)).body.request as RequestSummary;
    psql(`update public.audit_events set occurred_at = occurred_at - interval '61 minutes' where patient_id = ${lit(located.id)}; update public.patients set created_at = created_at - interval '61 minutes' where id = ${lit(located.id)};`);
    expect(Number(psql(`select public.lp_close_inactive(array[${lit(located.id)}]::uuid[])`))).toBe(1);
    const closedPlain = (await api(`/api/requests/${located.id}`, { cookie: await cookieFor(FOH) })).body as RequestDetail;
    expect((await setStatus(OTHER, closedPlain, STATUS.inMedical, 'reopen')).body.request.status).toBe(STATUS.inMedical);
  });

  it('Closed · inactive → Accompanied is a Reopen of a request closed while Accompanied, nothing else', async () => {
    const closeInactive = async (row: RequestSummary): Promise<RequestDetail> => {
      psql(
        `update public.audit_events set occurred_at = occurred_at - interval '61 minutes' where patient_id = ${lit(row.id)};` +
          ` update public.patients set created_at = created_at - interval '61 minutes' where id = ${lit(row.id)};`,
      );
      expect(Number(psql(`select public.lp_close_inactive(array[${lit(row.id)}]::uuid[])`))).toBe(1);
      return (await api(`/api/requests/${row.id}`, { cookie: await cookieFor(FOH) })).body as RequestDetail;
    };
    // Closed from Located · friend coming: no kind takes it to Accompanied, a Reopen included.
    const plain = await createRequest(FOH);
    const located = (await setStatus(ANSWERER, plain, STATUS.inMedical)).body.request as RequestSummary;
    const closed = await closeInactive(located);
    for (const kind of ['change', 'answer', 'undo', 'reopen']) {
      const res = await setStatus(OTHER, closed, STATUS.accompanied, kind);
      expect(res.status, `${kind}: ${res.text}`).toBe(422);
    }
    expect(psql(`select status from public.patients where id = ${lit(closed.id)}`)).toBe(STATUS.inactive);
    // Closed from Accompanied: still only a Reopen (asked as Located, or as Accompanied).
    const acc = await closeInactive(await accompanied());
    for (const kind of ['change', 'answer', 'undo']) {
      const res = await setStatus(OTHER, acc, STATUS.accompanied, kind);
      expect(res.status, `${kind}: ${res.text}`).toBe(422);
    }
    const reopened = await setStatus(OTHER, acc, STATUS.accompanied, 'reopen');
    expect(reopened.status, reopened.text).toBe(200);
    expect(reopened.body.request.status).toBe(STATUS.accompanied);
  });

  it('Needs attention times an approved swap from the approval, not from the Accompanied answer', async () => {
    const r = await accompanied();
    psql(`update public.audit_events set occurred_at = occurred_at - interval '40 minutes' where patient_id = ${lit(r.id)};`);
    const asked = await body(await swap(ASKER, { id: r.id, rowVersion: r.rowVersion }, { action: 'request' }));
    await body(await swap(ANSWERER, asked, { action: 'approve', place: 'mm' }));
    const minutes = Number(
      psql(
        `select coalesce(max(extract(epoch from now() - (x ->> 'since')::timestamptz) / 60), -1) from public.lp_stats('event') s,` +
          ` jsonb_array_elements(s #> '{attention,items}') x where x ->> 'id' = ${lit(r.id)}`,
      ),
    );
    // On the card (when it makes the top 5): minutes since the approval, not 40.
    expect(minutes).toBeLessThan(5);
  });
});

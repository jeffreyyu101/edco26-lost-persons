// F5: the "Not found yet" hold (rework SQL step 1d and lp_set_status; design/screens/updates.html #recheck),
// through the API and SQL on the local stack: the first Not found holds (status stays 'Added', recheck in 20
// minutes, 1 check), the second is final (2 checks), Undo clears or puts back exactly what was there, In medical
// clears the recheck, Back to Waiting clears both, a due hold never closes itself, a build from before this
// (the old server's call, the old client's Undo) gets the same safe behaviour, sync carries recheckAt and
// notFoundChecks, and the dashboard counts a hold as Waiting, not as Not in medical. Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { AuditEvent, RequestDetail, RequestSummary, Stats, SyncResponse } from '@/lib/api-types';
import { RECHECK_MINUTES, STATUS } from '@/lib/domain';
import { admin, api, cookieFor, createRequest, newStaff, psql, staffOf, withTestServer, type Staff } from './harness';

withTestServer();

const medical = newStaff('Medical');
const other = newStaff('Medical');

async function answer(staff: Staff, id: string, status: string, expectedVersion: number, kind = 'answer') {
  const res = await api(`/api/requests/${id}/status`, { json: { status, expectedVersion, kind }, cookie: await cookieFor(staff) });
  return res;
}

async function ok(staff: Staff, id: string, status: string, expectedVersion: number, kind = 'answer'): Promise<RequestSummary> {
  const res = await answer(staff, id, status, expectedVersion, kind);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.changed).toBe(true);
  return res.body.request as RequestSummary;
}

async function dbRow(id: string) {
  const { data, error } = await admin().from('patients').select('status, recheck_at, not_found_checks, row_version').eq('id', id).single();
  if (error) throw new Error(`select failed: ${error.code}`);
  return data as { status: string; recheck_at: string | null; not_found_checks: number; row_version: number };
}

const minutesFromNow = (iso: string | null | undefined) => (Date.parse(iso as string) - Date.now()) / 60_000;

async function statusEvents(staff: Staff, id: string) {
  const detail = (await api(`/api/requests/${id}`, { cookie: await cookieFor(staff) })).body as RequestDetail;
  return detail.audit.filter((e): e is Extract<AuditEvent, { action: 'status' }> => e.action === 'status');
}

describe('the "Not found yet" hold', () => {
  it('the first Not found holds: still Waiting for check, recheck in 20 minutes, 1 check, one audit entry', async () => {
    const creator = newStaff();
    const r = await createRequest(creator);
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    expect(held.status).toBe(STATUS.waiting);
    expect(held.notFoundChecks).toBe(1);
    expect(minutesFromNow(held.recheckAt)).toBeGreaterThan(RECHECK_MINUTES - 1);
    expect(minutesFromNow(held.recheckAt)).toBeLessThanOrEqual(RECHECK_MINUTES + 0.1);
    expect(held.rowVersion).toBe(r.rowVersion + 1);
    expect(held.updatedBy).toBe(staffOf(medical));
    expect(await dbRow(r.id)).toMatchObject({ status: STATUS.waiting, not_found_checks: 1 });
    // One audit entry: the answer, marked held.
    const events = await statusEvents(creator, r.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      staff: staffOf(medical),
      previous: { status: STATUS.waiting },
      next: { status: STATUS.waiting, kind: 'answer', held: true, hold: { checks: 1 } },
    });
    // Sync carries the hold to every phone.
    const sync = (await api(`/api/sync?ids=${r.id}`, { cookie: await cookieFor(creator) })).body as SyncResponse;
    expect(sync.rows[0]).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1, recheckAt: held.recheckAt });
    // A new request is not held.
    expect(r).toMatchObject({ recheckAt: null, notFoundChecks: 0 });
  });

  it('two liaisons tap Not found at once: the second is the idempotent repeat, not a final answer', async () => {
    const r = await createRequest(newStaff());
    const first = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    const second = await answer(other, r.id, STATUS.notInMedical, r.rowVersion);
    expect(second.status).toBe(200);
    expect(second.body.changed).toBe(false);
    expect(second.body.request).toMatchObject({ status: STATUS.waiting, rowVersion: first.rowVersion, notFoundChecks: 1 });
    expect(await dbRow(r.id)).toMatchObject({ status: STATUS.waiting, not_found_checks: 1 });
  });

  it('Not found on a held request (not due yet) is final: Not in medical, 2 checks, no recheck', async () => {
    const r = await createRequest(newStaff());
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    const final = await ok(other, r.id, STATUS.notInMedical, held.rowVersion);
    expect(final).toMatchObject({ status: STATUS.notInMedical, notFoundChecks: 2, recheckAt: null });
    const events = await statusEvents(medical, r.id);
    expect(events.map((e) => [e.previous.status, e.next.status, e.next.held ?? false])).toEqual([
      [STATUS.waiting, STATUS.waiting, true],
      [STATUS.waiting, STATUS.notInMedical, false],
    ]);
    expect(events[1]?.previous.hold?.checks).toBe(1);
  });

  it('a due hold never closes by itself, stays Waiting for check, and the next Not found closes it', async () => {
    const r = await createRequest(newStaff());
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    // Due a while ago (setup only: a direct write, as if 25 minutes had passed).
    psql(`update public.patients set recheck_at = now() - interval '5 minutes' where id = '${r.id}'`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const due = (await api(`/api/sync?ids=${r.id}`, { cookie: await cookieFor(medical) })).body.rows[0] as RequestSummary;
    expect(due.status).toBe(STATUS.waiting);
    expect(minutesFromNow(due.recheckAt)).toBeLessThan(0);
    expect(due.notFoundChecks).toBe(1);
    // Nothing in the database closes it: no trigger, no job, no function runs on the clock.
    expect(psql(`select count(*) from pg_trigger where tgrelid = 'public.patients'::regclass and not tgisinternal and tgname ilike '%recheck%'`)).toBe('0');
    const final = await ok(medical, r.id, STATUS.notInMedical, due.rowVersion);
    expect(final).toMatchObject({ status: STATUS.notInMedical, notFoundChecks: 2, recheckAt: null });
    expect(held.rowVersion).toBeLessThan(final.rowVersion);
  });

  it('Undo of the first Not found clears the hold and the count; Undo of the final one puts the hold back', async () => {
    const r = await createRequest(newStaff());
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    const undone = await ok(medical, r.id, STATUS.waiting, held.rowVersion, 'undo');
    expect(undone).toMatchObject({ status: STATUS.waiting, recheckAt: null, notFoundChecks: 0 });
    // A second Undo is the idempotent repeat.
    const again = await answer(medical, r.id, STATUS.waiting, held.rowVersion, 'undo');
    expect(again.body.changed).toBe(false);

    // Hold again, then the final answer, then its Undo: back on hold with the same recheck time.
    const held2 = await ok(medical, r.id, STATUS.notInMedical, undone.rowVersion);
    expect(held2.notFoundChecks).toBe(1);
    const final = await ok(medical, r.id, STATUS.notInMedical, held2.rowVersion);
    const back = await ok(medical, r.id, STATUS.waiting, final.rowVersion, 'undo');
    expect(back).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1 });
    expect(Date.parse(back.recheckAt as string)).toBe(Date.parse(held2.recheckAt as string));
  });

  it('In medical clears the recheck at any time (the count stays); its Undo puts the hold back', async () => {
    const r = await createRequest(newStaff());
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    const inMedical = await ok(medical, r.id, STATUS.inMedical, held.rowVersion);
    expect(inMedical).toMatchObject({ status: STATUS.inMedical, recheckAt: null, notFoundChecks: 1 });
    const undone = await ok(medical, r.id, STATUS.waiting, inMedical.rowVersion, 'undo');
    expect(undone).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1 });
    expect(Date.parse(undone.recheckAt as string)).toBe(Date.parse(held.recheckAt as string));
  });

  it('Back to Waiting for check clears both; the next Not found is a fresh hold', async () => {
    const r = await createRequest(newStaff());
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    const final = await ok(medical, r.id, STATUS.notInMedical, held.rowVersion);
    const back = await ok(medical, r.id, STATUS.waiting, final.rowVersion, 'change');
    expect(back).toMatchObject({ status: STATUS.waiting, recheckAt: null, notFoundChecks: 0 });
    const again = await ok(medical, r.id, STATUS.notInMedical, back.rowVersion);
    expect(again).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1 });
    // In medical → Back to Waiting clears the count too.
    const im = await ok(medical, r.id, STATUS.inMedical, again.rowVersion);
    const waiting = await ok(medical, r.id, STATUS.waiting, im.rowVersion, 'change');
    expect(waiting).toMatchObject({ recheckAt: null, notFoundChecks: 0 });
    // Change answer from In medical to Not found is final at once (no hold out of In medical).
    const im2 = await ok(medical, r.id, STATUS.inMedical, waiting.rowVersion);
    const changed = await ok(medical, r.id, STATUS.notInMedical, im2.rowVersion, 'change');
    expect(changed).toMatchObject({ status: STATUS.notInMedical, recheckAt: null, notFoundChecks: 1 });
  });

  it('a stale version on a held request is a conflict (409), not a silent final answer', async () => {
    const r = await createRequest(newStaff());
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    const cookie = await cookieFor(medical);
    await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { hair: 'TEST-S red' }, expectedVersion: held.rowVersion }, cookie });
    const stale = await answer(other, r.id, STATUS.notInMedical, held.rowVersion);
    expect(stale.status).toBe(409);
    expect(await dbRow(r.id)).toMatchObject({ status: STATUS.waiting, not_found_checks: 1 });
  });

  it('the creator can cancel a held request; Undo of the cancel keeps the hold, Reopen starts afresh', async () => {
    const creator = newStaff();
    const cookie = await cookieFor(creator);
    const r = await createRequest(creator);
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    const cancelled = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: held.rowVersion }, cookie });
    expect(cancelled.status).toBe(200);
    const undone = await ok(creator, r.id, STATUS.waiting, cancelled.body.request.rowVersion, 'undo');
    expect(undone).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1 });
    expect(undone.recheckAt).toBe(held.recheckAt);
    const again = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: undone.rowVersion }, cookie });
    const reopened = await ok(creator, r.id, STATUS.waiting, again.body.request.rowVersion, 'reopen');
    expect(reopened).toMatchObject({ recheckAt: null, notFoundChecks: 0 });
  });
});

describe('builds from before the hold', () => {
  it('the old server calls lp_set_status exactly as before and gets the hold (its allowlist sees Waiting for check)', async () => {
    const r = await createRequest(newStaff());
    // The call the live build's server makes, straight to the database.
    const { data, error } = await admin().rpc('lp_set_status', {
      p_id: r.id,
      p_expected_version: r.rowVersion,
      p_status: STATUS.notInMedical,
      p_staff: staffOf(medical),
      p_kind: 'answer',
    });
    expect(error).toBeNull();
    const out = data as { changed: boolean; row: Record<string, unknown> };
    expect(out.changed).toBe(true);
    expect(out.row.status).toBe(STATUS.waiting);
    // Every key the old server reads is still there with its old meaning; the new ones are extra.
    for (const key of ['id', 'status', 'row_version', 'created_at', 'updated_at', 'found_at', 'closed_at', 'medical_location']) expect(out.row).toHaveProperty(key);
    expect(out.row).toMatchObject({ not_found_checks: 1 });
    // The old client's Undo of what it thinks was "Not in medical" (back to Waiting, kind undo) clears the hold.
    const undo = await answer(medical, r.id, STATUS.waiting, Number(out.row.row_version), 'undo');
    expect(undo.body).toMatchObject({ changed: true, request: { status: STATUS.waiting, recheckAt: null, notFoundChecks: 0 } });
  });

  it('a database without step 1d is impossible for this build to misread: the columns exist with their defaults', () => {
    expect(
      psql(`select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' order by column_name)
            from information_schema.columns where table_schema = 'public' and table_name = 'patients' and column_name in ('recheck_at', 'not_found_checks')`),
    ).toBe('not_found_checks:smallint:NO:0,recheck_at:timestamp with time zone:YES:-');
    expect(psql('select public.lp_stages_recheck_minutes()')).toBe(String(RECHECK_MINUTES));
  });
});

describe('dashboard', () => {
  it('a held request counts as open Waiting for check, never as Not in medical; the final one does', async () => {
    const r = await createRequest(newStaff());
    const before = (await api('/api/stats', { cookie: await cookieFor(medical) })).body as Stats;
    const held = await ok(medical, r.id, STATUS.notInMedical, r.rowVersion);
    const during = (await api('/api/stats', { cookie: await cookieFor(medical) })).body as Stats;
    // Other files may run in between: compare with the database itself.
    const count = (where: string) => Number(psql(`select count(*) from public.patients where ${where}`));
    expect(during.open.waiting).toBe(count(`status = 'Added'`));
    expect(during.notInMedical).toBe(count(`status = 'Checked – Not Found'`));
    expect(during.notInMedical).toBe(before.notInMedical);
    // Its first Not found counts as its first answer.
    expect(during.avgAnswerMinutes).not.toBeNull();
    // A held request that is not due is not the longest wait.
    if (during.longestWait) expect(during.longestWait.id).not.toBe(r.id);
    await ok(medical, r.id, STATUS.notInMedical, held.rowVersion);
    const after = (await api('/api/stats', { cookie: await cookieFor(medical) })).body as Stats;
    expect(after.notInMedical).toBe(count(`status = 'Checked – Not Found'`));
  });
});

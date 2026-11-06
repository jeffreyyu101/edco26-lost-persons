// POST /api/requests/:id/status (spec §4 transitions, §5 lp_set_status, A12, A36): every legal transition
// succeeds with the right timestamps and audit, every illegal one is 422, the idempotent repeat is
// {changed: false} with no audit, a stale version is 409, and reopening a cancelled request is creator-only.
import { describe, expect, it } from 'vitest';
import type { AuditEvent, RequestDetail, RequestSummary } from '@/lib/api-types';
import { SETTABLE_STATUSES, STATUS, TRANSITIONS, type Status } from '@/lib/domain';
import { admin, api, cookieFor, createRequest, forceStatus, newStaff, randomUUID, staffOf, withTestServer, type Staff } from './harness';

withTestServer();

const FROM_STATUSES: Status[] = [
  STATUS.waiting,
  STATUS.notInMedical,
  STATUS.inMedical,
  STATUS.reunited,
  STATUS.discharged,
  STATUS.cancelled,
  STATUS.legacyBringFriend,
];

async function setStatus(staff: Staff, id: string, status: string, expectedVersion: number, kind = 'answer') {
  return api(`/api/requests/${id}/status`, { json: { status, expectedVersion, kind }, cookie: await cookieFor(staff) });
}

/** A fresh request created by `creator`, moved to `from` directly in the database. */
async function requestIn(creator: Staff, from: Status): Promise<{ id: string; version: number }> {
  const r = await createRequest(creator);
  const version = from === STATUS.waiting ? r.rowVersion : await forceStatus(r.id, from);
  return { id: r.id, version };
}

describe('illegal transitions → 422 (every from × settable target not in TRANSITIONS)', () => {
  const creator = newStaff();
  const cases = FROM_STATUSES.flatMap((from) =>
    SETTABLE_STATUSES.filter((to) => to !== from && !TRANSITIONS[from].includes(to)).map((to) => [from, to] as const),
  );
  it.each(cases)('%s → %s', async (from, to) => {
    const { id, version } = await requestIn(creator, from);
    const res = await setStatus(creator, id, to, version);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid');
    expect(res.body.error.currentStatus).toBe(from);
    // Nothing was written.
    const { data } = await admin().from('patients').select('status, row_version').eq('id', id).single();
    expect(data).toEqual({ status: from, row_version: version });
  });

  it('Cancelled is never a /status target (only /cancel) → 422', async () => {
    const { id, version } = await requestIn(creator, STATUS.waiting);
    const res = await setStatus(creator, id, STATUS.cancelled, version);
    expect(res.status).toBe(422);
    expect(res.body.error.field).toBe('status');
  });
});

describe('legal transitions', () => {
  const creator = newStaff('GC/HX - Base');
  const liaison = newStaff('Medical');
  const cases = FROM_STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as const));
  it.each(cases)('%s → %s', async (from, to) => {
    const { id, version } = await requestIn(creator, from);
    // Cancelled → Added is creator-only; everything else is done by someone else.
    const actor = from === STATUS.cancelled ? creator : liaison;
    const res = await setStatus(actor, id, to, version, from === STATUS.cancelled ? 'reopen' : 'answer');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.changed).toBe(true);
    const row = res.body.request as RequestSummary;
    expect(row.status).toBe(to);
    expect(row.rowVersion).toBe(version + 1);
    expect(row.updatedBy).toBe(staffOf(actor));
    // Timestamps (spec §4).
    if (to === STATUS.inMedical) {
      expect(row.foundAt).not.toBeNull();
      expect(row.reunionStartedAt).not.toBeNull();
    }
    if (to === STATUS.waiting || to === STATUS.notInMedical) expect(row.reunionStartedAt).toBeNull();
    if (to === STATUS.reunited || to === STATUS.discharged) expect(row.closedAt).not.toBeNull();
    else expect(row.closedAt).toBeNull();
  });
});

describe('status details', () => {
  it('found_at is set once and kept; reunion_started_at resets on every entry; audit has kind and previous timestamps', async () => {
    const creator = newStaff();
    const liaison = newStaff('Medical');
    const r = await createRequest(creator);
    const a = await setStatus(liaison, r.id, STATUS.inMedical, r.rowVersion, 'answer');
    const first = a.body.request as RequestSummary;
    await new Promise((res) => setTimeout(res, 30));
    const b = await setStatus(liaison, r.id, STATUS.notInMedical, first.rowVersion, 'change');
    expect(b.body.request.foundAt).toBe(first.foundAt);
    expect(b.body.request.reunionStartedAt).toBeNull();
    await new Promise((res) => setTimeout(res, 30));
    const c = await setStatus(liaison, r.id, STATUS.inMedical, b.body.request.rowVersion, 'change');
    expect(c.body.request.foundAt).toBe(first.foundAt);
    expect(Date.parse(c.body.request.reunionStartedAt)).toBeGreaterThan(Date.parse(first.reunionStartedAt as string));

    const detail = (await api(`/api/requests/${r.id}`, { cookie: await cookieFor(creator) })).body as RequestDetail;
    const statuses = detail.audit.filter((e): e is Extract<AuditEvent, { action: 'status' }> => e.action === 'status');
    expect(statuses.map((e) => [e.previous.status, e.next.status, e.next.kind])).toEqual([
      [STATUS.waiting, STATUS.inMedical, 'answer'],
      [STATUS.inMedical, STATUS.notInMedical, 'change'],
      [STATUS.notInMedical, STATUS.inMedical, 'change'],
    ]);
    expect(statuses.every((e) => e.staff === staffOf(liaison))).toBe(true);
  });

  it('idempotent repeat (two liaisons tap the same answer) → 200 {changed: false}, no audit, even with an old version', async () => {
    const creator = newStaff();
    const r = await createRequest(creator);
    const first = await setStatus(newStaff('Medical'), r.id, STATUS.inMedical, r.rowVersion);
    expect(first.body.changed).toBe(true);
    const second = await setStatus(newStaff('Medical'), r.id, STATUS.inMedical, r.rowVersion);
    expect(second.status).toBe(200);
    expect(second.body.changed).toBe(false);
    expect(second.body.request.rowVersion).toBe(first.body.request.rowVersion);
    const { data } = await admin().from('audit_events').select('id').eq('patient_id', r.id).eq('action_type', 'status_changed');
    expect(data).toHaveLength(1);
  });

  it('the legacy "Bring friend to medical" is never a target through the API (A36) → 422', async () => {
    // setStatusSchema accepts only settable statuses; the SQL-level legacy repeat ({changed: false}) is
    // covered by scripts/verify-migration.sh (migration.test.ts).
    const res = await setStatus(newStaff('Medical'), '5eed0000-0000-4000-8000-000000001005', STATUS.legacyBringFriend, 0);
    expect(res.status).toBe(422);
    expect(res.body.error.field).toBe('status');
  });

  it.each([
    [STATUS.waiting, STATUS.inMedical],
    [STATUS.notInMedical, STATUS.inMedical],
    [STATUS.inMedical, STATUS.reunited],
    [STATUS.reunited, STATUS.inMedical],
  ] as const)('stale version from %s → 409 with currentStatus', async (from, to) => {
    const creator = newStaff();
    const { id, version } = await requestIn(creator, from);
    const cookie = await cookieFor(creator);
    await api(`/api/requests/${id}`, { method: 'PATCH', json: { patch: { hair: `x${version}` }, expectedVersion: version }, cookie });
    const res = await setStatus(creator, id, to, version);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'conflict', currentStatus: from });
  });

  it('a stale PATCH on a non-Waiting row is still 409 with the current status', async () => {
    const creator = newStaff();
    const { id, version } = await requestIn(creator, STATUS.notInMedical);
    const cookie = await cookieFor(creator);
    await api(`/api/requests/${id}`, { method: 'PATCH', json: { patch: { hair: 'a' }, expectedVersion: version }, cookie });
    const res = await api(`/api/requests/${id}`, { method: 'PATCH', json: { patch: { hair: 'b' }, expectedVersion: version }, cookie });
    expect(res.status).toBe(409);
    expect(res.body.error.currentStatus).toBe(STATUS.notInMedical);
  });

  it('cancel on a non-Waiting row → 422 with the current status', async () => {
    const creator = newStaff();
    const { id, version } = await requestIn(creator, STATUS.inMedical);
    const res = await api(`/api/requests/${id}/cancel`, { json: { expectedVersion: version }, cookie: await cookieFor(creator) });
    expect(res.status).toBe(422);
    expect(res.body.error.currentStatus).toBe(STATUS.inMedical);
  });

  it('reopening a cancelled request: non-creator → 403, creator → 200', async () => {
    const creator = newStaff('GC/HX - Dispatch');
    const r = await createRequest(creator);
    const cancelled = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: r.rowVersion }, cookie: await cookieFor(creator) });
    const v = cancelled.body.request.rowVersion as number;
    const other = await setStatus(newStaff('GC/HX - Dispatch'), r.id, STATUS.waiting, v, 'reopen');
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('forbidden');
    const undo = await setStatus(creator, r.id, STATUS.waiting, v, 'undo');
    expect(undo.status).toBe(200);
    expect(undo.body.request.status).toBe(STATUS.waiting);
    expect(undo.body.request.closedAt).toBeNull();
  });

  it('validation 422 (bad status / kind / version), unknown id 404, auth 401, Origin 403', async () => {
    const staff = newStaff();
    const r = await createRequest(staff);
    const cookie = await cookieFor(staff);
    for (const json of [
      { status: 'Lost', expectedVersion: 0, kind: 'answer' },
      { status: STATUS.inMedical, expectedVersion: 0, kind: 'guess' },
      { status: STATUS.inMedical, expectedVersion: '0', kind: 'answer' },
      { status: STATUS.inMedical, kind: 'answer' },
      { status: STATUS.inMedical, expectedVersion: 0, kind: 'answer', staff: 'X · Medical' },
    ]) {
      expect((await api(`/api/requests/${r.id}/status`, { json, cookie })).status, JSON.stringify(json)).toBe(422);
    }
    const json = { status: STATUS.inMedical, expectedVersion: 0, kind: 'answer' };
    expect((await api(`/api/requests/${randomUUID()}/status`, { json, cookie })).status).toBe(404);
    expect((await api(`/api/requests/${r.id}/status`, { json })).status).toBe(401);
    const foreign = await api(`/api/requests/${r.id}/status`, { json, cookie, origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('bad_origin');
  });
});

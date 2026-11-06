// Where medical has the patient (Pending v8, Dani + Brian 2026-11-06 afternoon): patients.medical_location,
// set with PATCH {medicalLocation} through lp_update_fields (audited like any edit), exposed in the summary,
// the detail and sync, kept through status changes and other edits until someone edits it, refused on
// create, trimmed and at most 60 characters. Also: the build that is live now keeps working on the migrated
// database (its calls never touch the column). Synthetic data only; every request is closed afterwards.
import { describe, expect, it } from 'vitest';
import type { AuditEvent, RequestDetail, RequestSummary, SyncResponse } from '@/lib/api-types';
import { syncPath } from '@/lib/client/api-paths';
import { REQUEST_SUMMARY_KEYS } from '@/lib/server/mappers';
import { admin, api, cookieFor, createBody, createRequest, newStaff, psql, staffOf, withTestServer } from './harness';

withTestServer();

async function auditOf(id: string) {
  const { data, error } = await admin()
    .from('audit_events')
    .select('action_type, staff_name, previous_value, new_value')
    .eq('patient_id', id)
    .order('occurred_at', { ascending: true });
  if (error) throw new Error(error.code);
  return data as Array<{ action_type: string; staff_name: string; previous_value: unknown; new_value: unknown }>;
}

async function patch(id: string, body: Record<string, unknown>, expectedVersion: number, cookie: string) {
  return api(`/api/requests/${id}`, { method: 'PATCH', json: { patch: body, expectedVersion }, cookie });
}

async function setStatus(r: RequestSummary, status: string, kind: string, cookie: string): Promise<RequestSummary> {
  const res = await api(`/api/requests/${r.id}/status`, { json: { status, expectedVersion: r.rowVersion, kind }, cookie });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.request as RequestSummary;
}

describe('medicalLocation', () => {
  it('a new request has none: null in the create response, the detail and sync', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    expect(Object.keys(r).sort()).toEqual(REQUEST_SUMMARY_KEYS);
    expect(REQUEST_SUMMARY_KEYS).toContain('medicalLocation');
    expect(r.medicalLocation).toBeNull();
    const detail = (await api(`/api/requests/${r.id}`, { cookie })).body as RequestDetail;
    expect(detail.medicalLocation).toBeNull();
    const synced = (await api<SyncResponse>(syncPath({ ids: [r.id] }), { cookie })).body.rows[0];
    expect(synced?.medicalLocation).toBeNull();
  });

  it('PATCH sets it (trimmed), bumps the version, is audited as an edit, and shows in the detail and sync', async () => {
    const staff = newStaff();
    const medic = newStaff('Medical');
    const cookie = await cookieFor(medic);
    let r = await createRequest(staff);
    r = await setStatus(r, 'Found – Awaiting Reunion', 'answer', cookie);

    const res = await patch(r.id, { medicalLocation: '  Chair 14  ' }, r.rowVersion, cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.changed).toBe(true);
    const located = res.body.request as RequestSummary;
    expect(located).toMatchObject({ medicalLocation: 'Chair 14', rowVersion: r.rowVersion + 1, status: 'Found – Awaiting Reunion', updatedBy: staffOf(medic) });

    const audit = (await auditOf(r.id)).filter((a) => a.action_type === 'patient_updated');
    expect(audit).toEqual([
      { action_type: 'patient_updated', staff_name: staffOf(medic), previous_value: { medical_location: null }, new_value: { medical_location: 'Chair 14' } },
    ]);
    const detail = (await api(`/api/requests/${r.id}`, { cookie })).body as RequestDetail;
    expect(detail.medicalLocation).toBe('Chair 14');
    const edit = detail.audit.find((e) => e.action === 'edit') as Extract<AuditEvent, { action: 'edit' }>;
    expect(edit).toMatchObject({ staff: staffOf(medic), previous: { medicalLocation: null }, next: { medicalLocation: 'Chair 14' } });

    const synced = (await api<SyncResponse>(syncPath({ ids: [r.id] }), { cookie })).body.rows[0];
    expect(synced?.medicalLocation).toBe('Chair 14');

    // The same value again is no change (no audit row, same version).
    const again = await patch(r.id, { medicalLocation: 'Chair 14' }, located.rowVersion, cookie);
    expect(again.body).toMatchObject({ changed: false, request: { rowVersion: located.rowVersion } });

    // Edited, then cleared with null (or a blank).
    const moved = (await patch(r.id, { medicalLocation: 'Bed 3 · triage' }, located.rowVersion, cookie)).body.request as RequestSummary;
    expect(moved.medicalLocation).toBe('Bed 3 · triage');
    const cleared = (await patch(r.id, { medicalLocation: '   ' }, moved.rowVersion, cookie)).body.request as RequestSummary;
    expect(cleared.medicalLocation).toBeNull();
    await setStatus(cleared, 'Reunited – Closed', 'reunite', cookie);
  });

  it('kept until someone edits it: other edits, Undo back to Waiting, Not found in medical and Reunited leave it', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(newStaff('Medical'));
    let r = await createRequest(staff);
    r = await setStatus(r, 'Found – Awaiting Reunion', 'answer', cookie);
    r = (await patch(r.id, { medicalLocation: 'Chair 9' }, r.rowVersion, cookie)).body.request as RequestSummary;
    // An edit the build that is live now could make (it never sends medicalLocation).
    r = (await patch(r.id, { clothing: 'TEST-S blue jacket', hair: 'Red' }, r.rowVersion, cookie)).body.request as RequestSummary;
    expect(r.medicalLocation).toBe('Chair 9');
    for (const [status, kind] of [
      ['Added', 'undo'],
      ['Found – Awaiting Reunion', 'answer'],
      ['Checked – Not Found', 'change'],
      ['Found – Awaiting Reunion', 'change'],
      ['Reunited – Closed', 'reunite'],
    ] as const) {
      r = await setStatus(r, status, kind, cookie);
      expect(r.medicalLocation, status).toBe('Chair 9');
    }
  });

  it('validation: at most 60 characters (422 field medicalLocation), text only, never on create', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const long = await patch(r.id, { medicalLocation: 'x'.repeat(61) }, r.rowVersion, cookie);
    expect(long.status).toBe(422);
    expect(long.body.error).toMatchObject({ code: 'invalid', field: 'medicalLocation' });
    const number = await patch(r.id, { medicalLocation: 14 }, r.rowVersion, cookie);
    expect(number.status).toBe(422);
    // 60 characters fit exactly (code points, like char_length).
    const sixty = await patch(r.id, { medicalLocation: '🩺'.repeat(60) }, r.rowVersion, cookie);
    expect(sixty.status, JSON.stringify(sixty.body)).toBe(200);
    expect(Array.from((sixty.body.request as RequestSummary).medicalLocation ?? '')).toHaveLength(60);

    const create = await api('/api/requests', { json: createBody({ medicalLocation: 'Chair 1' }), cookie });
    expect(create.status).toBe(422);
    expect(create.body.error.code).toBe('invalid');
  });

  it('SQL: lp_create_request refuses it; lp_update_fields trims it and refuses 61 characters (rolled back)', async () => {
    const r = await createRequest(newStaff());
    const update = (value: string) => `begin;
      set local role service_role;
      select lp_update_fields(id, json_build_object('medical_location', ${value})::jsonb, row_version, 'T · Medical') -> 'row' ->> 'medical_location'
        from patients where id = '${r.id}';
      rollback;`;
    expect(psql(update(`E' \\t Chair 7 \\n'`))).toBe('Chair 7');
    expect(() => psql(update(`repeat('x', 61)`))).toThrow(/field_too_long/);
    expect(() =>
      psql(`begin;
        set local role service_role;
        select lp_create_request('{"client_mutation_id":"00000000-0000-4000-8000-00000000c0de","reporting_location":"Base","medical_location":"Chair 1"}', 'T · Medical');
        rollback;`),
    ).toThrow(/unknown_field/);
    // Nothing of it stayed.
    expect(psql(`select coalesce(medical_location, 'null') from patients where id = '${r.id}'`)).toBe('null');
  });
});

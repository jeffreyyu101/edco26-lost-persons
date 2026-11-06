// Requests: create (idempotent, concurrent), detail, patch (edit audit pairs A35, merged post rule A32),
// cancel (creator only), plus validation 422s, 409 on a stale version, auth and Origin.
import { describe, expect, it } from 'vitest';
import type { AuditEvent, RequestDetail, RequestSummary } from '@/lib/api-types';
import { REQUEST_SUMMARY_KEYS } from '@/lib/server/mappers';
import {
  admin,
  api,
  cookieFor,
  createBody,
  createRequest,
  newStaff,
  pii,
  randomUUID,
  staffOf,
  uniq,
  withTestServer,
} from './harness';

withTestServer();

async function auditOf(id: string) {
  const { data, error } = await admin().from('audit_events').select('action_type, staff_name, previous_value, new_value').eq('patient_id', id);
  if (error) throw new Error(error.code);
  return data as Array<{ action_type: string; staff_name: string; previous_value: unknown; new_value: unknown }>;
}

describe('POST /api/requests', () => {
  it('creates (201) with attribution from the session, then a retry returns the same row (200)', async () => {
    const staff = newStaff('GC/HX - Base');
    const cookie = await cookieFor(staff);
    const body = createBody({ name: pii(`TEST-S Kayla ${uniq()} Martinez`), reportingLocation: 'Other', otherLocation: 'Info booth' });
    const res = await api('/api/requests', { json: body, cookie });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const r = res.body.request as RequestSummary;
    expect(res.body.created).toBe(true);
    expect(Object.keys(r).sort()).toEqual(REQUEST_SUMMARY_KEYS);
    expect(r).toMatchObject({
      clientMutationId: body.clientMutationId,
      status: 'Added',
      createdBy: staffOf(staff),
      updatedBy: staffOf(staff),
      reportingLocation: 'Other',
      otherLocation: 'Info booth',
      postShort: 'Info booth',
      age: '22',
      gender: 'Female',
      rowVersion: 0,
      photoCount: 0,
      firstPhotoId: null,
    });
    expect(r.name).toBe(body.name);
    expect(r.lastName).toBe('Martinez');
    expect(r.caseNumber).toBeGreaterThan(1013);

    const retry = await api('/api/requests', { json: body, cookie: await cookieFor(newStaff()) });
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.request.id).toBe(r.id);
    expect(retry.body.request.caseNumber).toBe(r.caseNumber);
    expect(retry.body.request.createdBy).toBe(staffOf(staff));

    const audit = await auditOf(r.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action_type: 'patient_created', staff_name: staffOf(staff) });
  });

  it('a client-supplied createdBy / status is refused (identity comes from the session)', async () => {
    const cookie = await cookieFor(newStaff());
    for (const extra of [{ createdBy: 'Someone · Medical' }, { status: 'Reunited – Closed' }, { caseNumber: 1 }]) {
      const res = await api('/api/requests', { json: createBody(extra), cookie });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.error.code).toBe('invalid');
    }
  });

  it('concurrent identical creates → exactly 1 row and 1 audit event', async () => {
    const cookie = await cookieFor(newStaff());
    const body = createBody();
    const results = await Promise.all(Array.from({ length: 6 }, () => api('/api/requests', { json: body, cookie })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    const ids = new Set(results.map((r) => r.body.request.id));
    expect(ids.size).toBe(1);
    const { data, error } = await admin().from('patients').select('id').eq('client_mutation_id', body.clientMutationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(await auditOf([...ids][0] as string)).toHaveLength(1);
  });

  it('a non-Other post never keeps an other location', async () => {
    const r = await createRequest(newStaff(), { reportingLocation: 'Command', otherLocation: 'Gate 9' });
    expect(r.otherLocation).toBeNull();
    expect(r.postShort).toBe('Command');
  });

  it.each([
    ['missing clientMutationId', { clientMutationId: undefined }, 'clientMutationId'],
    ['bad clientMutationId', { clientMutationId: 'abc' }, 'clientMutationId'],
    ['missing post', { reportingLocation: undefined }, 'reportingLocation'],
    ['unknown post', { reportingLocation: 'FA 9' }, 'reportingLocation'],
    ['Other without where', { reportingLocation: 'Other', otherLocation: null }, 'otherLocation'],
    ['age over 40', { age: 'x'.repeat(41) }, 'age'],
    ['age as a boolean', { age: true }, 'age'],
    ['gender over 40', { gender: 'x'.repeat(41) }, 'gender'],
    ['gender as a number', { gender: 1 }, 'gender'],
    ['name over 120', { name: 'x'.repeat(121) }, 'name'],
    ['clothing over 300', { clothing: 'x'.repeat(301) }, 'clothing'],
    ['phone over 40', { contactPhone: '1'.repeat(41) }, 'contactPhone'],
    ['last seen over 1000', { lastSeen: 'x'.repeat(1001) }, 'lastSeen'],
    ['notes over 2000', { additionalNotes: 'x'.repeat(2001) }, 'additionalNotes'],
    ['unknown key', { colour: 'red' }, undefined],
  ])('validation: %s → 422', async (_label, extra, field) => {
    const body = createBody(extra);
    for (const [k, v] of Object.entries(extra)) if (v === undefined) delete body[k];
    const res = await api('/api/requests', { json: body, cookie: await cookieFor(newStaff()) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid');
    if (field) expect(res.body.error.field).toBe(field);
  });

  it('auth required (401), same-origin required (403), malformed JSON (400), over 64 KB (413)', async () => {
    expect((await api('/api/requests', { json: createBody() })).status).toBe(401);
    const cookie = await cookieFor(newStaff());
    const foreign = await api('/api/requests', { json: createBody(), cookie, origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('bad_origin');
    const noOrigin = await api('/api/requests', { json: createBody(), cookie, origin: null });
    expect(noOrigin.status).toBe(403);
    expect((await api('/api/requests', { body: '{', cookie, headers: { 'content-type': 'application/json' } })).status).toBe(400);
    const big = await api('/api/requests', { json: createBody({ additionalNotes: 'x'.repeat(70_000) }), cookie });
    expect(big.status).toBe(413);
  });
});

describe('GET /api/requests/:id', () => {
  it('returns the detail: summary + photos + audit (oldest first)', async () => {
    const staff = newStaff();
    const r = await createRequest(staff, { reportingLocation: 'FA 4 – Oasis' });
    const res = await api(`/api/requests/${r.id}`, { cookie: await cookieFor(staff) });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const d = res.body as RequestDetail;
    expect(d.id).toBe(r.id);
    expect(d.photos).toEqual([]);
    expect(d.audit).toHaveLength(1);
    expect(d.audit[0]).toMatchObject({
      action: 'created',
      staff: staffOf(staff),
      previous: null,
      next: { reportingLocation: 'FA 4 – Oasis', otherLocation: null },
    });
  });

  it('normalises Jeffrey\'s legacy audit formats (seed LP-0997, LP-0996, LP-1005)', async () => {
    const cookie = await cookieFor(newStaff());
    const lp997 = (await api(`/api/requests/5eed0000-0000-4000-8000-000000000997`, { cookie })).body as RequestDetail;
    const actions = lp997.audit.map((e) => e.action);
    expect(actions).toEqual(['created', 'legacy_search_not_found', 'legacy_check', 'edit', 'legacy_search_found', 'status']);
    const search = lp997.audit[1] as Extract<AuditEvent, { action: 'legacy_search_not_found' }>;
    expect(search.next.status).toBe('Checked – Not Found');
    expect(search.notes).toBe('Checked all three tents');
    const check = lp997.audit[2] as Extract<AuditEvent, { action: 'legacy_check' }>;
    expect(check.previous.status).toBe('Checked – Not Found');
    expect(check.notes).toBe('Rechecked after 20 minutes');
    const edit = lp997.audit[3] as Extract<AuditEvent, { action: 'edit' }>;
    // Jeffrey's full-row blobs are diffed to the changed editable keys only.
    expect(edit.previous).toEqual({ clothing: 'Tie-dye shirt, jeans', lastSeen: 'Info booth' });
    expect(edit.next).toEqual({ clothing: 'Tie-dye shirt', lastSeen: 'Near the info booth by the main gate' });
    const status = lp997.audit[5] as Extract<AuditEvent, { action: 'status' }>;
    expect(status.previous.status).toBe('Found – Awaiting Reunion');
    expect(status.next).toEqual({ status: 'Reunited – Closed', kind: null });
    const created = lp997.audit[0] as Extract<AuditEvent, { action: 'created' }>;
    expect(created.next).toEqual({ reportingLocation: 'Other', otherLocation: 'Info booth' });
    // Legacy columns never leak through the allowlist.
    expect(Object.keys(lp997).sort()).toEqual([...REQUEST_SUMMARY_KEYS, 'audit', 'photos'].sort());

    const lp996 = (await api(`/api/requests/5eed0000-0000-4000-8000-000000000996`, { cookie })).body as RequestDetail;
    // The inactive photo is never shown; the legacy one reads 'unsure' with no thumbnail.
    expect(lp996.photos).toHaveLength(1);
    expect(lp996.photos[0]).toMatchObject({ timing: 'unsure', hasThumb: false });
    expect(lp996.photoCount).toBe(1);
    // (Two of its events share a timestamp, so compare as a set.)
    expect(lp996.audit.map((e) => e.action).sort()).toEqual(['created', 'legacy_search_found', 'photo', 'status', 'status']);
    expect(lp996.audit.find((e) => e.action === 'photo')).toMatchObject({ next: { timing: 'unsure' } });

    const lp1005 = (await api(`/api/requests/5eed0000-0000-4000-8000-000000001005`, { cookie })).body as RequestDetail;
    expect(lp1005.status).toBe('Bring friend to medical');
    expect(lp1005.photos.map((p) => p.timing)).toEqual(['older', 'unsure']);
    const s = lp1005.audit.find((e) => e.action === 'status') as Extract<AuditEvent, { action: 'status' }>;
    expect(s.previous.status).toBe('Added');
    expect(s.next.status).toBe('Bring friend to medical');
  });

  it('unknown id → 404, non-UUID id → 404, auth required', async () => {
    const cookie = await cookieFor(newStaff());
    expect((await api(`/api/requests/${randomUUID()}`, { cookie })).status).toBe(404);
    const bad = await api('/api/requests/not-a-uuid', { cookie });
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('not_found');
    expect((await api(`/api/requests/${randomUUID()}`)).status).toBe(401);
  });
});

describe('PATCH /api/requests/:id', () => {
  it('saves changed keys, records the edit with whole name / post pairs (A35), bumps rowVersion', async () => {
    const staff = newStaff();
    const editor = newStaff('Medical');
    const r = await createRequest(staff, { name: pii(`TEST-S Dana ${uniq()} Kim`), reportingLocation: 'Other', otherLocation: 'Gate' });
    const newName = `${r.firstName} Lee`;
    const res = await api(`/api/requests/${r.id}`, {
      method: 'PATCH',
      json: { patch: { name: newName, otherLocation: 'Gate 2', hair: 'Blond', clothing: r.clothing }, expectedVersion: r.rowVersion },
      cookie: await cookieFor(editor),
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    const updated = res.body.request as RequestSummary;
    expect(updated.rowVersion).toBe(r.rowVersion + 1);
    expect(updated).toMatchObject({ lastName: 'Lee', otherLocation: 'Gate 2', postShort: 'Gate 2', hair: 'Blond', updatedBy: staffOf(editor) });
    expect(updated.createdBy).toBe(staffOf(staff));

    const detail = (await api(`/api/requests/${r.id}`, { cookie: await cookieFor(staff) })).body as RequestDetail;
    const edit = detail.audit.find((e) => e.action === 'edit') as Extract<AuditEvent, { action: 'edit' }>;
    expect(edit.staff).toBe(staffOf(editor));
    expect(edit.previous).toEqual({ firstName: r.firstName, lastName: 'Kim', reportingLocation: 'Other', otherLocation: 'Gate', hair: null });
    expect(edit.next).toEqual({ firstName: r.firstName, lastName: 'Lee', reportingLocation: 'Other', otherLocation: 'Gate 2', hair: 'Blond' });
  });

  it('nothing changed → 200 {changed: false}, no audit, same rowVersion', async () => {
    const staff = newStaff();
    const r = await createRequest(staff);
    const res = await api(`/api/requests/${r.id}`, {
      method: 'PATCH',
      json: { patch: { clothing: r.clothing, age: r.age }, expectedVersion: r.rowVersion },
      cookie: await cookieFor(staff),
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.request.rowVersion).toBe(r.rowVersion);
    expect((await auditOf(r.id)).filter((a) => a.action_type === 'patient_updated')).toHaveLength(0);
  });

  it('clears with null, keeps omitted keys', async () => {
    const staff = newStaff();
    const r = await createRequest(staff, { hair: 'Red' });
    const res = await api(`/api/requests/${r.id}`, {
      method: 'PATCH',
      json: { patch: { hair: null }, expectedVersion: r.rowVersion },
      cookie: await cookieFor(staff),
    });
    expect(res.body.request.hair).toBeNull();
    expect(res.body.request.clothing).toBe(r.clothing);
  });

  it('stale expectedVersion → 409 conflict with the current status', async () => {
    const staff = newStaff();
    const r = await createRequest(staff);
    const cookie = await cookieFor(staff);
    await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { hair: 'A' }, expectedVersion: r.rowVersion }, cookie });
    const stale = await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { hair: 'B' }, expectedVersion: r.rowVersion }, cookie });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'conflict', currentStatus: 'Added' });
  });

  it('merged post rule: Other with no where → 422 field otherLocation (A32)', async () => {
    const staff = newStaff();
    const r = await createRequest(staff, { reportingLocation: 'Command' });
    const cookie = await cookieFor(staff);
    const res = await api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: { reportingLocation: 'Other' }, expectedVersion: r.rowVersion }, cookie });
    expect(res.status).toBe(422);
    expect(res.body.error.field).toBe('otherLocation');
    const explicit = await api(`/api/requests/${r.id}`, {
      method: 'PATCH',
      json: { patch: { reportingLocation: 'Other', otherLocation: '' }, expectedVersion: r.rowVersion },
      cookie,
    });
    expect(explicit.status).toBe(422);
    expect(explicit.body.error.field).toBe('otherLocation');
    // Moving off Other clears the other location.
    const o = await createRequest(staff, { reportingLocation: 'Other', otherLocation: 'Gate 4' });
    const moved = await api(`/api/requests/${o.id}`, { method: 'PATCH', json: { patch: { reportingLocation: 'Base' }, expectedVersion: o.rowVersion }, cookie });
    expect(moved.status).toBe(200);
    expect(moved.body.request).toMatchObject({ reportingLocation: 'Base', otherLocation: null, postShort: 'Base' });
  });

  it('validation 422s: empty patch, status in the patch, bad expectedVersion', async () => {
    const staff = newStaff();
    const r = await createRequest(staff);
    const cookie = await cookieFor(staff);
    for (const json of [
      { patch: {}, expectedVersion: 0 },
      { patch: { status: 'Cancelled' }, expectedVersion: 0 },
      { patch: { createdBy: 'X · Medical' }, expectedVersion: 0 },
      { patch: { hair: 'x' }, expectedVersion: -1 },
      { patch: { hair: 'x' } },
    ]) {
      const res = await api(`/api/requests/${r.id}`, { method: 'PATCH', json, cookie });
      expect(res.status, JSON.stringify(json)).toBe(422);
    }
  });

  it('unknown id → 404; auth 401; Origin 403', async () => {
    const cookie = await cookieFor(newStaff());
    const json = { patch: { hair: 'x' }, expectedVersion: 0 };
    expect((await api(`/api/requests/${randomUUID()}`, { method: 'PATCH', json, cookie })).status).toBe(404);
    expect((await api(`/api/requests/${randomUUID()}`, { method: 'PATCH', json })).status).toBe(401);
    expect((await api(`/api/requests/${randomUUID()}`, { method: 'PATCH', json, cookie, origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('POST /api/requests/:id/cancel', () => {
  it('the creator can cancel while Waiting; a repeat is {changed: false}', async () => {
    const staff = newStaff('GC/HX - Dispatch');
    const r = await createRequest(staff);
    // The creator check is canonical: a legacy alias team ("Dispatch") matches.
    const sameCanon = await cookieFor({ staffName: `  ${staff.staffName.toLowerCase()} `, team: 'Dispatch' });
    const res = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: r.rowVersion }, cookie: sameCanon });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.request.status).toBe('Cancelled');
    expect(res.body.request.closedAt).not.toBeNull();
    const again = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: r.rowVersion }, cookie: await cookieFor(staff) });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    const detail = (await api(`/api/requests/${r.id}`, { cookie: await cookieFor(staff) })).body as RequestDetail;
    expect(detail.audit.map((e) => e.action)).toEqual(['created', 'cancelled']);
    expect(detail.audit[1]).toMatchObject({ previous: { status: 'Added' }, next: { status: 'Cancelled' } });
  });

  it('cancel by a non-creator → 403', async () => {
    const r = await createRequest(newStaff());
    const res = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: r.rowVersion }, cookie: await cookieFor(newStaff()) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('cancel when not Waiting → 422; stale version → 409', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const answered = await api(`/api/requests/${r.id}/status`, {
      json: { status: 'Checked – Not Found', expectedVersion: r.rowVersion, kind: 'answer' },
      cookie,
    });
    expect(answered.status).toBe(200);
    const res = await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: answered.body.request.rowVersion }, cookie });
    expect(res.status).toBe(422);
    const r2 = await createRequest(staff);
    await api(`/api/requests/${r2.id}`, { method: 'PATCH', json: { patch: { hair: 'x' }, expectedVersion: r2.rowVersion }, cookie });
    const stale = await api(`/api/requests/${r2.id}/cancel`, { json: { expectedVersion: r2.rowVersion }, cookie });
    expect(stale.status).toBe(409);
  });

  it('validation 422, unknown id 404, auth 401, Origin 403', async () => {
    const cookie = await cookieFor(newStaff());
    const r = await createRequest(newStaff());
    expect((await api(`/api/requests/${r.id}/cancel`, { json: {}, cookie })).status).toBe(422);
    expect((await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: 'x' }, cookie })).status).toBe(422);
    expect((await api(`/api/requests/${randomUUID()}/cancel`, { json: { expectedVersion: 0 }, cookie })).status).toBe(404);
    expect((await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: 0 } })).status).toBe(401);
    expect((await api(`/api/requests/${r.id}/cancel`, { json: { expectedVersion: 0 }, cookie, origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('free-text age and gender (Jeffrey, 2026-11-06 10:31)', () => {
  it('creates with age "mid-20s" or "24" and any gender; create, detail and sync return them as typed', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const a = await createRequest(staff, { age: ' mid-20s ', gender: ' Non-binary ' });
    expect(a).toMatchObject({ age: 'mid-20s', gender: 'Non-binary' });
    const b = await createRequest(staff, { age: '24', gender: 'male' });
    expect(b).toMatchObject({ age: '24', gender: 'male' });
    // The old values still work, and a request queued by an older client (age as a number) is stored as text.
    const c = await createRequest(staff, { age: 24, gender: 'Male' });
    expect(c).toMatchObject({ age: '24', gender: 'Male' });
    const blank = await createRequest(staff, { age: '   ', gender: '' });
    expect(blank).toMatchObject({ age: null, gender: null });
    const longest = await createRequest(staff, { age: 'x'.repeat(40), gender: 'y'.repeat(40) });
    expect(longest).toMatchObject({ age: 'x'.repeat(40), gender: 'y'.repeat(40) });

    const detail = (await api(`/api/requests/${a.id}`, { cookie })).body as RequestDetail;
    expect(detail).toMatchObject({ age: 'mid-20s', gender: 'Non-binary' });
    const sync = await api(`/api/sync?ids=${[a.id, b.id, c.id].join(',')}`, { cookie });
    expect(sync.status).toBe(200);
    const byId = new Map((sync.body.rows as RequestSummary[]).map((row) => [row.id, row]));
    expect([a.id, b.id, c.id].map((id) => byId.get(id)?.age)).toEqual(['mid-20s', '24', '24']);
    const { data, error } = await admin().from('patients').select('id, age').in('id', [a.id, c.id]);
    expect(error).toBeNull();
    expect(new Map((data as Array<{ id: string; age: string }>).map((row) => [row.id, row.age]))).toEqual(
      new Map([[a.id, 'mid-20s'], [c.id, '24']]),
    );
  });

  it('edits age between "mid-20s" and "24" and gender to free text, audited; the same age as a number is no change', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff, { age: 'mid-20s', gender: 'Female' });
    const patch = (p: Record<string, unknown>, expectedVersion: number) =>
      api(`/api/requests/${r.id}`, { method: 'PATCH', json: { patch: p, expectedVersion }, cookie });

    const first = await patch({ age: '24', gender: 'woman' }, r.rowVersion);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ changed: true, request: { age: '24', gender: 'woman' } });
    const v1 = first.body.request.rowVersion as number;
    const same = await patch({ age: 24 }, v1);
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ changed: false, request: { age: '24', rowVersion: v1 } });
    const back = await patch({ age: ' mid-20s ' }, v1);
    expect(back.body).toMatchObject({ changed: true, request: { age: 'mid-20s', gender: 'woman' } });
    const cleared = await patch({ age: null, gender: '' }, back.body.request.rowVersion);
    expect(cleared.body).toMatchObject({ changed: true, request: { age: null, gender: null } });
    const tooLong = await patch({ age: 'x'.repeat(41) }, cleared.body.request.rowVersion);
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.field).toBe('age');

    const detail = (await api(`/api/requests/${r.id}`, { cookie })).body as RequestDetail;
    const edits = detail.audit.filter((e): e is Extract<AuditEvent, { action: 'edit' }> => e.action === 'edit');
    expect(edits.map((e) => [e.previous, e.next])).toEqual([
      [{ age: 'mid-20s', gender: 'Female' }, { age: '24', gender: 'woman' }],
      [{ age: '24' }, { age: 'mid-20s' }],
      [{ age: 'mid-20s', gender: 'woman' }, { age: null, gender: null }],
    ]);
  });

  it('a row saved with a numeric age before the change reads back as text (seed LP-1013, age 24)', async () => {
    const cookie = await cookieFor(newStaff());
    const res = await api('/api/requests/5eed0000-0000-4000-8000-000000001013', { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ caseNumber: 1013, age: '24', gender: 'Male' });
    // Jeffrey's audit blobs hold age as a number; they never show a phantom age change.
    const lp997 = (await api('/api/requests/5eed0000-0000-4000-8000-000000000997', { cookie })).body as RequestDetail;
    expect(lp997.age).toBe('30');
    for (const e of lp997.audit) if (e.action === 'edit') expect('age' in e.next, JSON.stringify(e.next)).toBe(false);
  });
});

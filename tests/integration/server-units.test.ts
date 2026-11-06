// Pure server helpers (no HTTP server needed): CSV escaping with every injection prefix, the allowlist
// mappers and legacy audit normalisation, error mapping, Origin / IP / body helpers, magic bytes, logging.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildCsv, csvCell, csvFilename, needsFormulaGuard } from '@/lib/server/csv';
import { ApiFailure, fieldFromDetail, isDefinitiveRejection, mapDbError, snakeToCamel } from '@/lib/server/errors';
import { assertSameOrigin, clientIp, expectedOrigins, readBodyLimited } from '@/lib/server/http';
import { logRequest, newErrorId } from '@/lib/server/log';
import { REQUEST_SUMMARY_KEYS, createPayload, editChanges, mapAudit, mapPhoto, mapRow, mapSync, patchPayload } from '@/lib/server/mappers';
import { contentHash, isObjectAlreadyExists, photoPaths, sniffImage } from '@/lib/server/photos';
import { createRequestSchema, requestPatchSchema } from '@/lib/validation';

describe('CSV injection guard', () => {
  it.each([
    ['=1+1', true],
    ['+1', true],
    ['-1', true],
    ['@SUM(A1)', true],
    ['＝1', true],
    ['＋1', true],
    ['－1', true],
    ['＠x', true],
    [' =1', true],
    [' 　=1', true],
    ['\u0007=1', true],
    ['\u200b@x', true],
    ['\ufeff=1', true],
    ['\t=1', true],
    ['\tplain', true],
    ['\rplain', true],
    ['\nplain', true],
    ['plain', false],
    ['a=b', false],
    ['Blue - red', false],
    ['', false],
    ['(407) 555-0100', false],
    ['  plain', false],
  ])('%j → guarded %s', (value, guarded) => {
    expect(needsFormulaGuard(value)).toBe(guarded);
    expect(csvCell(value)).toBe(`"${guarded ? "'" : ''}${value.replace(/"/g, '""')}"`);
  });

  it('quotes everything and doubles quotes; null / numbers', () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(22)).toBe('"22"');
    expect(csvCell('=x"y')).toBe('"\'=x""y"');
  });

  it('builds BOM + header + rows newest first with CRLF, times in the event timezone', () => {
    const base = mapRow({ id: 'a', case_number: 1, reporting_location: 'FA 4 – Oasis', status: 'Found – Awaiting Reunion', created_at: '2026-11-07T03:10:00+00:00', updated_at: '2026-11-07T03:10:00+00:00' });
    const older = { ...base, id: 'b', caseNumber: 2, createdAt: '2026-11-06T03:10:00+00:00' };
    const csv = buildCsv([older, base], 'America/New_York');
    expect(csv.startsWith('\ufeff"Case number","Name"')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(4); // header, 2 rows, trailing empty
    expect(lines[1]).toContain('"LP-0001"');
    expect(lines[1]).toContain('"In medical · friend coming"');
    expect(lines[1]).toContain('"2026-11-06 22:10"');
    expect(lines[2]).toContain('"LP-0002"');
    expect(csvFilename(new Date('2026-11-07T03:30:00Z'), 'America/New_York')).toBe('lost-persons-2026-11-06.csv');
  });
});

describe('mappers', () => {
  it('mapRow: exactly the RequestSummary keys; legacy columns dropped; derived fields', () => {
    const row = mapRow({
      id: 'x', case_number: 997, first_name: 'Q.T.', last_name: '', reporting_location: 'Other', other_location: 'Info booth',
      status: 'Reunited – Closed', row_version: '4', photo_count: 2, checked_in_at: '2026-11-06T00:00:00Z', secret_column: 'no',
    });
    expect(Object.keys(row).sort()).toEqual(REQUEST_SUMMARY_KEYS);
    expect(row).toMatchObject({ name: 'Q.T.', postShort: 'Info booth', rowVersion: 4, photoCount: 2, age: null, firstPhotoId: null });
    expect('checkedInAt' in row || 'checked_in_at' in row || 'secretColumn' in row).toBe(false);
  });

  it('mapPhoto: legacy / unknown timing → unsure', () => {
    expect(mapPhoto({ id: 'p', photo_timing: 'unsure', has_thumb: false }).timing).toBe('unsure');
    expect(mapPhoto({ id: 'p', photo_timing: 'yesterday' }).timing).toBe('unsure');
    expect(mapPhoto({ id: 'p', photo_timing: 'older', has_thumb: true })).toMatchObject({ timing: 'older', hasThumb: true });
  });

  it('mapSync passes cursors verbatim (microseconds and offset kept)', () => {
    const s = mapSync({ serverTime: '2026-11-06T23:10:04.123456+00:00', rows: [], hasMore: true, next: { at: '2026-11-06T23:10:05.000001+00:00', id: 'i' }, versions: [['a', 3]] });
    expect(s).toEqual({ serverTime: '2026-11-06T23:10:04.123456+00:00', rows: [], hasMore: true, next: { at: '2026-11-06T23:10:05.000001+00:00', id: 'i' }, versions: [['a', 3]] });
  });

  it('create / patch payloads: name split at the last space, camel → snake, omitted keys omitted', () => {
    const create = createRequestSchema.parse({ clientMutationId: '5eed0000-0000-4000-8000-000000000001', reportingLocation: 'Base', name: ' Mary  Ann Lee ', age: 3, hair: '' });
    expect(createPayload(create)).toEqual({ client_mutation_id: '5eed0000-0000-4000-8000-000000000001', reporting_location: 'Base', other_location: null, first_name: 'Mary Ann', last_name: 'Lee', age: 3, hair: null });
    const patch = requestPatchSchema.parse({ name: 'Dana', contactPhone: null });
    expect(patchPayload(patch)).toEqual({ first_name: 'Dana', last_name: null, contact_phone: null });
  });
});

describe('audit normalisation', () => {
  const base = { id: 'e', staff_name: 'Rae Chen · Medical', occurred_at: '2026-11-06T10:00:00+00:00', notes: null };
  it.each([
    ['patient_created (new)', { action_type: 'patient_created', new_value: { reporting_location: 'Other', other_location: 'Gate' } }, { action: 'created', previous: null, next: { reportingLocation: 'Other', otherLocation: 'Gate' } }],
    ['patient_created (full row)', { action_type: 'patient_created', new_value: { first_name: 'X', reporting_location: 'FA 3 – Kinetic', created_by: 'A · B' } }, { action: 'created', next: { reportingLocation: 'FA 3 – Kinetic', otherLocation: null } }],
    ['status_changed (new)', { action_type: 'status_changed', previous_value: { status: 'Added', found_at: null }, new_value: { status: 'Found – Awaiting Reunion', kind: 'answer' } }, { action: 'status', previous: { status: 'Added' }, next: { status: 'Found – Awaiting Reunion', kind: 'answer' } }],
    ['status_changed (full row)', { action_type: 'status_changed', previous_value: { status: 'Added', first_name: 'X' }, new_value: { status: 'Reunited – Closed', updated_by: 'A · B' } }, { action: 'status', next: { status: 'Reunited – Closed', kind: null } }],
    ['status_changed without a status', { action_type: 'status_changed', new_value: {} }, { action: 'other', next: { actionType: 'status_changed' } }],
    ['photo_uploaded', { action_type: 'photo_uploaded', new_value: { photo_id: 'p', photo_timing: 'unsure' } }, { action: 'photo', next: { photoId: 'p', timing: 'unsure' } }],
    ['cancelled', { action_type: 'cancelled', previous_value: { status: 'Added' }, new_value: { status: 'Cancelled' } }, { action: 'cancelled', previous: { status: 'Added' }, next: { status: 'Cancelled' } }],
    ['medical_search not found', { action_type: 'medical_search', new_value: { outcome: 'not_found', notes: 'Tents 1-3' } }, { action: 'legacy_search_not_found', notes: 'Tents 1-3', next: { status: 'Checked – Not Found' } }],
    ['medical_search other outcome', { action_type: 'medical_search', new_value: { outcome: 'pending' } }, { action: 'other', next: { actionType: 'medical_search' } }],
    ['medical_search_found', { action_type: 'medical_search_found', new_value: {} }, { action: 'legacy_search_found', next: { status: 'Found – Awaiting Reunion' } }],
    ['check_completed', { action_type: 'check_completed', previous_value: { status: 'Checked – Not Found' }, new_value: { status: 'Checked – Not Found' }, notes: 'Again' }, { action: 'legacy_check', notes: 'Again', previous: { status: 'Checked – Not Found' }, next: { status: 'Checked – Not Found' } }],
    ['requester_checkin (unknown)', { action_type: 'requester_checkin', new_value: { phone: '407' } }, { action: 'other', previous: null, next: { actionType: 'requester_checkin' } }],
  ])('%s', (_label, event, expected) => {
    expect(mapAudit({ ...base, ...event })).toMatchObject({ id: 'e', staff: 'Rae Chen · Medical', at: base.occurred_at, ...expected });
  });

  it('edit (new format): passes whole name / post pairs through (A35)', () => {
    expect(editChanges({ first_name: 'Dana', last_name: 'Kim' }, { first_name: 'Dana', last_name: 'Lee' })).toEqual({
      previous: { firstName: 'Dana', lastName: 'Kim' },
      next: { firstName: 'Dana', lastName: 'Lee' },
    });
    expect(editChanges({ reporting_location: 'Other', other_location: 'Gate' }, { reporting_location: 'Other', other_location: 'Gate 2' })).toEqual({
      previous: { reportingLocation: 'Other', otherLocation: 'Gate' },
      next: { reportingLocation: 'Other', otherLocation: 'Gate 2' },
    });
    expect(editChanges({ hair: null, age: 20 }, { hair: 'Red', age: 21 })).toEqual({ previous: { age: 20, hair: null }, next: { age: 21, hair: 'Red' } });
  });

  it("edit (Jeffrey's format): full old row + patch → only changed editable keys, pairs completed from the old row", () => {
    const oldRow = { id: 'x', status: 'Added', first_name: 'Kayla', last_name: 'M', clothing: 'Red', hair: 'Blond', reporting_location: 'FA 3 – Kinetic', other_location: null, created_by: 'A · B' };
    const patch = { updated_by: 'A · B', updated_at: '2026-11-06T10:00:00Z', clothing: 'Red', hair: 'Brown', last_name: 'Martinez', status: 'Added' };
    expect(editChanges(oldRow, patch)).toEqual({
      previous: { hair: 'Blond', firstName: 'Kayla', lastName: 'M' },
      next: { hair: 'Brown', firstName: 'Kayla', lastName: 'Martinez' },
    });
    // '' and null are the same; non-editable keys are ignored; a missing previous value is null.
    expect(editChanges({ contact_notes: '' }, { contact_notes: null, updated_by: 'x' })).toEqual({ previous: {}, next: {} });
    expect(editChanges(null, { hair: 'Red' })).toEqual({ previous: { hair: null }, next: { hair: 'Red' } });
  });

  it('mapAudit edit uses editChanges', () => {
    expect(mapAudit({ ...base, action_type: 'patient_updated', previous_value: { hair: null }, new_value: { hair: 'Blond' } })).toMatchObject({
      action: 'edit', previous: { hair: null }, next: { hair: 'Blond' },
    });
  });
});

describe('error mapping', () => {
  it.each([
    [{ code: 'P0409', hint: 'Added' }, 'default', 409, 'conflict', { currentStatus: 'Added' }],
    [{ code: 'P0422', message: 'invalid_field', details: 'field:other_location' }, 'default', 422, 'invalid', { field: 'otherLocation' }],
    [{ code: 'P0422', message: 'illegal_transition', hint: 'Cancelled' }, 'default', 422, 'invalid', { currentStatus: 'Cancelled' }],
    [{ code: 'P0403', message: 'creator_only' }, 'default', 403, 'forbidden', {}],
    [{ code: 'P0429', hint: '125' }, 'login', 429, 'rate_limited', { retryAfterSeconds: 125 }],
    [{ code: 'P0429', details: 'field:photo' }, 'photo', 422, 'photo_limit', { field: 'photo' }],
    [{ code: 'P0002' }, 'default', 404, 'not_found', {}],
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'default', 503, 'unavailable', {}],
    [{ code: '23514', message: 'new row violates check', details: 'Failing row contains (Kayla, Martinez)' }, 'default', 503, 'unavailable', {}],
    [{ message: 'TypeError: fetch failed' }, 'default', 503, 'unavailable', {}],
  ] as const)('%j (%s) → %i %s', (error, context, status, code, extra) => {
    const f = mapDbError(error, context);
    expect(f.status).toBe(status);
    expect(f.code).toBe(code);
    expect(f.body().error).toMatchObject(extra);
    // Never echoes database text.
    expect(JSON.stringify(f.body())).not.toMatch(/Kayla|timeout|fetch failed|check/);
    if (status === 503) expect(f.body().error.id).toMatch(/^[0-9a-f]{10}$/);
    else expect(f.body().error.id).toBeUndefined();
  });

  it('login 429 carries Retry-After; definitive photo rejections', () => {
    expect(mapDbError({ code: 'P0429', hint: '61' }, 'login').headers).toEqual({ 'Retry-After': '61' });
    expect(mapDbError({ code: 'P0429', hint: '61' }, 'login').message).toBe('Too many attempts. Try again in 2 min');
    for (const code of ['P0429', 'P0422', 'P0403', 'P0002']) expect(isDefinitiveRejection(mapDbError({ code }, 'photo'))).toBe(true);
    expect(isDefinitiveRejection(mapDbError({ code: '57014' }, 'photo'))).toBe(false);
    expect(isDefinitiveRejection(new ApiFailure('unavailable'))).toBe(false);
  });

  it('field names from DETAIL are camelCased and sanitised', () => {
    expect(fieldFromDetail('field:client_mutation_id')).toBe('clientMutationId');
    expect(fieldFromDetail('field:Bad Field')).toBeUndefined();
    expect(fieldFromDetail(null)).toBeUndefined();
    expect(snakeToCamel('reporting_location')).toBe('reportingLocation');
  });
});

describe('http helpers', () => {
  const req = (headers: Record<string, string>, url = 'http://127.0.0.1:3101/api/requests') => new Request(url, { method: 'POST', headers });

  it('expected origins from x-forwarded-host / host and x-forwarded-proto', () => {
    expect(expectedOrigins(req({ host: 'lp.example.com', 'x-forwarded-proto': 'https' }))).toEqual(['https://lp.example.com']);
    expect(expectedOrigins(req({ host: 'internal:3000', 'x-forwarded-host': 'lp.example.com', 'x-forwarded-proto': 'https' }))).toEqual(['https://lp.example.com', 'https://internal:3000']);
    expect(expectedOrigins(req({ host: 'lp.example.com:443', 'x-forwarded-proto': 'https' }))).toEqual(['https://lp.example.com']);
  });

  it('assertSameOrigin accepts the exact origin only', () => {
    const ok = req({ host: 'lp.example.com', 'x-forwarded-proto': 'https', origin: 'https://lp.example.com' });
    expect(() => assertSameOrigin(ok)).not.toThrow();
    for (const origin of ['http://lp.example.com', 'https://evil.example', 'https://lp.example.com.evil.example', 'null', '']) {
      const bad = req({ host: 'lp.example.com', 'x-forwarded-proto': 'https', ...(origin ? { origin } : {}) });
      expect(() => assertSameOrigin(bad), origin).toThrow(ApiFailure);
    }
  });

  it('clientIp: Vercel header, then x-real-ip, then leftmost x-forwarded-for, then 0.0.0.0; junk ignored', () => {
    expect(clientIp(new Headers({ 'x-vercel-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8', 'x-forwarded-for': '9.9.9.9' }))).toBe('1.2.3.4');
    expect(clientIp(new Headers({ 'x-real-ip': '5.6.7.8', 'x-forwarded-for': '9.9.9.9' }))).toBe('5.6.7.8');
    expect(clientIp(new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('9.9.9.9');
    expect(clientIp(new Headers({ 'x-forwarded-for': '2001:DB8::1' }))).toBe('2001:db8::1');
    expect(clientIp(new Headers({ 'x-vercel-forwarded-for': '<script>', 'x-real-ip': '5.6.7.8' }))).toBe('5.6.7.8');
    expect(clientIp(new Headers())).toBe('0.0.0.0');
  });

  it('readBodyLimited: under / over the limit, declared or streamed', async () => {
    expect((await readBodyLimited(new Request('http://x/', { method: 'POST', body: 'abc' }), 3)).byteLength).toBe(3);
    await expect(readBodyLimited(new Request('http://x/', { method: 'POST', body: 'abcd' }), 3)).rejects.toMatchObject({ code: 'too_large' });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(2));
        c.enqueue(new Uint8Array(2));
        c.close();
      },
    });
    await expect(readBodyLimited(new Request('http://x/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), 3)).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('photos and logging', () => {
  it('sniffs JPEG / PNG / WebP by magic bytes only', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg');
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImage(new Uint8Array([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImage(new Uint8Array([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WAVE')]))).toBeNull();
    expect(sniffImage(new Uint8Array(Buffer.from('GIF89a')))).toBeNull();
    expect(sniffImage(new Uint8Array(Buffer.from('<svg')))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it('object paths are content-addressed: a path names exactly one content (A44)', () => {
    const a = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const b = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 4]);
    const hashA = createHash('sha256').update(a).digest('hex');
    const hashB = createHash('sha256').update(b).digest('hex');
    expect(contentHash(a)).toBe(hashA);
    expect(photoPaths('p', 'f', a, b)).toEqual({ full: `p/f-${hashA}.jpg`, thumb: `p/f-${hashB}_thumb.jpg` });
    expect(photoPaths('p', 'f', a, null)).toEqual({ full: `p/f-${hashA}.jpg`, thumb: null });
    // Same bytes → same path (retries find their objects); other bytes → another path (never overwritten).
    expect(photoPaths('p', 'f', a.slice(), null).full).toBe(photoPaths('p', 'f', a, null).full);
    expect(photoPaths('p', 'f', b, null).full).not.toBe(photoPaths('p', 'f', a, null).full);
    expect(contentHash(a.subarray(3))).toBe(contentHash(new Uint8Array([1, 2, 3])));
    // Within lp_add_photo's 200-character limit for real ids.
    const uuid = '00000000-0000-4000-8000-000000000000';
    const longest = photoPaths(uuid, uuid, a, a).thumb as string;
    expect(longest.length).toBeLessThanOrEqual(200);
  });

  it('classifies "object already exists" (upsert: false) (A44)', () => {
    // Local storage answers HTTP 400 with statusCode "409"; hosted storage may answer HTTP 409.
    expect(isObjectAlreadyExists({ status: 400, statusCode: '409' })).toBe(true);
    expect(isObjectAlreadyExists({ status: 409, statusCode: '409' })).toBe(true);
    expect(isObjectAlreadyExists({ status: 409 })).toBe(true);
    expect(isObjectAlreadyExists({ status: 400, statusCode: '404' })).toBe(false);
    expect(isObjectAlreadyExists({ status: 500, statusCode: '500' })).toBe(false);
    expect(isObjectAlreadyExists({})).toBe(false);
    expect(isObjectAlreadyExists(null)).toBe(false);
  });

  it('log lines carry only route, status, codes, error id and timing — sanitised', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      logRequest({ route: 'GET /api/sync', status: 200, ms: 12 });
      expect(warn).not.toHaveBeenCalled();
      logRequest({ route: 'POST /api/requests', status: 422, code: 'invalid', ms: 3.4 });
      expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toEqual({ lp: 'api', route: 'POST /api/requests', status: 422, code: 'invalid', ms: 3 });
      logRequest({ route: 'POST /api/requests', status: 503, code: 'unavailable', errorId: newErrorId(), dbCode: 'Kayla "Martinez" 407-555', ms: 1 });
      const line = error.mock.calls[0]?.[0] as string;
      expect(line).not.toMatch(/Kayla Martinez|"Martinez"/);
      expect(JSON.parse(line).dbCode).toBe('KaylaMartinez407-555');
      expect(info).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
    }
  });
});

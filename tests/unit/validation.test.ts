import { describe, expect, it } from 'vitest';
import {
  cancelSchema,
  createRequestSchema,
  idParamsSchema,
  photoFieldsSchema,
  photoQuerySchema,
  requestPatchSchema,
  searchParamsToObject,
  setStatusSchema,
  signInSchema,
  syncQuerySchema,
  updateRequestSchema,
} from '@/lib/validation';

const CMID = '0b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d';
const ID = '5eed0000-0000-4000-8000-000000001012';

describe('createRequestSchema', () => {
  it('accepts a minimal request and nulls omitted fields only when given', () => {
    const r = createRequestSchema.parse({ clientMutationId: CMID, reportingLocation: 'FA 3 – Kinetic', name: 'T.R.' });
    expect(r).toEqual({ clientMutationId: CMID, reportingLocation: 'FA 3 – Kinetic', name: 'T.R.', otherLocation: null });
  });

  it('trims, turns blanks into null and collapses the name', () => {
    const r = createRequestSchema.parse({
      clientMutationId: CMID,
      reportingLocation: 'Base',
      name: '  Kayla   Martinez ',
      clothing: '   ',
      lastSeen: ' kineticFIELD ',
      gender: '',
      age: null,
    });
    expect(r.name).toBe('Kayla Martinez');
    expect(r.clothing).toBeNull();
    expect(r.lastSeen).toBe('kineticFIELD');
    expect(r.gender).toBeNull();
    expect(r.age).toBeNull();
  });

  it('requires a valid uuid client mutation id and a post', () => {
    expect(createRequestSchema.safeParse({ reportingLocation: 'Base' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ clientMutationId: 'nope', reportingLocation: 'Base' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ clientMutationId: CMID }).success).toBe(false);
    expect(createRequestSchema.safeParse({ clientMutationId: CMID, reportingLocation: 'FA 3' }).success).toBe(false);
  });

  it('Other needs a location; other posts drop it', () => {
    expect(createRequestSchema.safeParse({ clientMutationId: CMID, reportingLocation: 'Other' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ clientMutationId: CMID, reportingLocation: 'Other', otherLocation: '  ' }).success).toBe(false);
    const ok = createRequestSchema.parse({ clientMutationId: CMID, reportingLocation: 'Other', otherLocation: ' Info booth ' });
    expect(ok.otherLocation).toBe('Info booth');
    const dropped = createRequestSchema.parse({ clientMutationId: CMID, reportingLocation: 'Command', otherLocation: 'x' });
    expect(dropped.otherLocation).toBeNull();
  });

  it('enforces the limits in code points', () => {
    const base = { clientMutationId: CMID, reportingLocation: 'Base' as const };
    expect(createRequestSchema.safeParse({ ...base, clothing: 'x'.repeat(300) }).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...base, clothing: 'x'.repeat(301) }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, clothing: '😀'.repeat(300) }).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...base, lastSeen: 'x'.repeat(1001) }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, physicalDescription: 'x'.repeat(2000) }).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...base, additionalNotes: 'x'.repeat(2001) }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, contactPhone: '1'.repeat(41) }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, contactName: 'x'.repeat(121) }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, name: 'x'.repeat(121) }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, reportingLocation: 'Other', otherLocation: 'x'.repeat(81) }).success).toBe(false);
  });

  it('age is free text (Jeffrey, 2026-11-06): trimmed, blank → null, ≤40; a number becomes its text', () => {
    const base = { clientMutationId: CMID, reportingLocation: 'Base' as const };
    const age = (v: unknown) => createRequestSchema.parse({ ...base, age: v }).age;
    expect(age('mid-20s')).toBe('mid-20s');
    expect(age('  24 ')).toBe('24');
    expect(age('early 30s, maybe 35')).toBe('early 30s, maybe 35');
    expect(age('   ')).toBeNull();
    expect(age('')).toBeNull();
    expect(age(null)).toBeNull();
    // Older clients (and requests already queued on a phone) send a number.
    expect(age(24)).toBe('24');
    expect(age(0)).toBe('0');
    expect(age(121)).toBe('121');
    expect(age('x'.repeat(40))).toBe('x'.repeat(40));
    expect(createRequestSchema.safeParse({ ...base, age: 'x'.repeat(41) }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, age: '😀'.repeat(40) }).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...base, age: true }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, age: ['24'] }).success).toBe(false);
    expect(requestPatchSchema.parse({ age: 'mid-20s' })).toEqual({ age: 'mid-20s' });
    expect(requestPatchSchema.parse({ age: 24 })).toEqual({ age: '24' });
    expect(requestPatchSchema.parse({ age: null })).toEqual({ age: null });
    expect(requestPatchSchema.safeParse({ age: 'x'.repeat(41) }).success).toBe(false);
  });

  it('gender is free text: trimmed, blank → null, ≤40; the old Male / Female / Other still work', () => {
    const base = { clientMutationId: CMID, reportingLocation: 'Base' as const };
    const gender = (v: unknown) => createRequestSchema.parse({ ...base, gender: v }).gender;
    for (const g of ['Male', 'Female', 'Other']) expect(gender(g)).toBe(g);
    expect(gender('female')).toBe('female');
    expect(gender(' Non-binary ')).toBe('Non-binary');
    expect(gender('')).toBeNull();
    expect(gender(null)).toBeNull();
    expect(gender('x'.repeat(40))).toBe('x'.repeat(40));
    expect(createRequestSchema.safeParse({ ...base, gender: 'x'.repeat(41) }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, gender: 1 }).success).toBe(false);
    expect(requestPatchSchema.parse({ gender: 'woman' })).toEqual({ gender: 'woman' });
  });

  it('phone is never rejected for its format, only for its length', () => {
    const base = { clientMutationId: CMID, reportingLocation: 'Base' as const };
    for (const phone of ['555', 'ask at FA 4', '+44 20 7946 0958 ext 2', 'none']) {
      expect(createRequestSchema.parse({ ...base, contactPhone: phone }).contactPhone).toBe(phone);
    }
  });

  it('rejects unknown and server-owned keys', () => {
    const base = { clientMutationId: CMID, reportingLocation: 'Base' as const };
    expect(createRequestSchema.safeParse({ ...base, status: 'Cancelled' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, createdBy: 'x' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...base, first_name: 'x' }).success).toBe(false);
  });
});

describe('requestPatchSchema / updateRequestSchema', () => {
  it('keeps omitted keys omitted and explicit null as clear', () => {
    const r = requestPatchSchema.parse({ hair: null, clothing: ' Red hoodie ' });
    expect(r).toEqual({ hair: null, clothing: 'Red hoodie' });
    expect('lastSeen' in r).toBe(false);
  });

  it('needs at least one key', () => {
    expect(requestPatchSchema.safeParse({}).success).toBe(false);
  });

  it('rejects only an explicit clear of the location with Other; omitted is left to the merged-row check', () => {
    expect(requestPatchSchema.safeParse({ reportingLocation: 'Other', otherLocation: null }).success).toBe(false);
    expect(requestPatchSchema.safeParse({ reportingLocation: 'Other', otherLocation: '  ' }).success).toBe(false);
    // Omitted = unchanged: the row may already have an other_location (lp_update_fields checks the merged row).
    expect(requestPatchSchema.parse({ reportingLocation: 'Other' })).toEqual({ reportingLocation: 'Other' });
    expect(requestPatchSchema.safeParse({ reportingLocation: 'Other', otherLocation: 'Gate' }).success).toBe(true);
    expect(requestPatchSchema.safeParse({ otherLocation: 'Gate' }).success).toBe(true);
    expect(requestPatchSchema.safeParse({ otherLocation: null }).success).toBe(true);
  });

  it('never accepts status or identity fields', () => {
    expect(requestPatchSchema.safeParse({ status: 'Added' }).success).toBe(false);
    expect(requestPatchSchema.safeParse({ caseNumber: 1 }).success).toBe(false);
    expect(requestPatchSchema.safeParse({ reportingLocation: null }).success).toBe(false);
  });

  it('wraps the patch with an expected version', () => {
    expect(updateRequestSchema.safeParse({ patch: { hair: 'Blond' }, expectedVersion: 3 }).success).toBe(true);
    expect(updateRequestSchema.safeParse({ patch: { hair: 'Blond' } }).success).toBe(false);
    expect(updateRequestSchema.safeParse({ patch: { hair: 'Blond' }, expectedVersion: -1 }).success).toBe(false);
    expect(updateRequestSchema.safeParse({ patch: { hair: 'Blond' }, expectedVersion: 1.5 }).success).toBe(false);
  });
});

describe('medicalLocation (Pending v8, Dani + Brian 2026-11-06 afternoon)', () => {
  it('a patch takes it: trimmed, blank → null (clear), at most 60 characters', () => {
    expect(requestPatchSchema.parse({ medicalLocation: '  Chair 14 ' })).toEqual({ medicalLocation: 'Chair 14' });
    expect(requestPatchSchema.parse({ medicalLocation: '   ' })).toEqual({ medicalLocation: null });
    expect(requestPatchSchema.parse({ medicalLocation: null })).toEqual({ medicalLocation: null });
    expect(requestPatchSchema.parse({ medicalLocation: 'x'.repeat(60) }).medicalLocation).toHaveLength(60);
    // Code points, like SQL char_length: 60 emoji are 60 characters.
    expect(requestPatchSchema.safeParse({ medicalLocation: '🩺'.repeat(60) }).success).toBe(true);
    expect(requestPatchSchema.safeParse({ medicalLocation: 'x'.repeat(61) }).success).toBe(false);
    expect(requestPatchSchema.safeParse({ medicalLocation: 'Bed \u0000' }).success).toBe(false);
    expect(requestPatchSchema.safeParse({ medicalLocation: 14 }).success).toBe(false);
    expect(updateRequestSchema.parse({ patch: { medicalLocation: 'Bed 3 · triage' }, expectedVersion: 4 })).toEqual({
      patch: { medicalLocation: 'Bed 3 · triage' },
      expectedVersion: 4,
    });
  });

  it('a new request never carries one (only set once medical has them)', () => {
    const res = createRequestSchema.safeParse({ clientMutationId: CMID, reportingLocation: 'Base', medicalLocation: 'Chair 1' });
    expect(res.success).toBe(false);
  });
});

describe('setStatusSchema / cancelSchema', () => {
  it('accepts settable statuses and kinds', () => {
    expect(setStatusSchema.safeParse({ status: 'Found – Awaiting Reunion', expectedVersion: 0, kind: 'answer' }).success).toBe(true);
    expect(setStatusSchema.safeParse({ status: 'Added', expectedVersion: 4, kind: 'undo' }).success).toBe(true);
  });

  it('rejects Cancelled, the legacy value and unknown kinds', () => {
    expect(setStatusSchema.safeParse({ status: 'Cancelled', expectedVersion: 0, kind: 'change' }).success).toBe(false);
    expect(setStatusSchema.safeParse({ status: 'Bring friend to medical', expectedVersion: 0, kind: 'answer' }).success).toBe(false);
    expect(setStatusSchema.safeParse({ status: 'Added', expectedVersion: 0, kind: 'recheck' }).success).toBe(false);
  });

  it('cancel needs only the version', () => {
    expect(cancelSchema.safeParse({ expectedVersion: 2 }).success).toBe(true);
    expect(cancelSchema.safeParse({ expectedVersion: 2, staff: 'x' }).success).toBe(false);
  });
});

describe('signInSchema', () => {
  it('resolves a card team', () => {
    expect(signInSchema.parse({ staffName: '  Dana   Kim ', team: 'GC/HX - Dispatch', password: 'pw' })).toEqual({
      staffName: 'Dana Kim',
      team: 'GC/HX - Dispatch',
      password: 'pw',
    });
  });

  it('resolves Other to the custom team text, canonicalising known aliases', () => {
    const team = (otherTeam: string) => signInSchema.parse({ staffName: 'Sam Lee', team: 'Other', otherTeam, password: 'pw' }).team;
    expect(team(' Info   booth ')).toBe('Info booth');
    expect(team('dispatch')).toBe('GC/HX - Dispatch');
    expect(team('Dispatch')).toBe('GC/HX - Dispatch');
    expect(team('gchx base')).toBe('GC/HX - Base');
    expect(team('Transport')).toBe('GC/HX - Special Operations/Med Transpo');
    expect(team('prevent')).toBe('Prevent');
    expect(team('MEDICAL')).toBe('Medical');
    expect(signInSchema.safeParse({ staffName: 'Sam Lee', team: 'Other', password: 'pw' }).success).toBe(false);
    expect(signInSchema.safeParse({ staffName: 'Sam Lee', team: 'Other', otherTeam: 'x', password: 'pw' }).success).toBe(false);
  });

  it('checks name length, the separator and the password', () => {
    expect(signInSchema.safeParse({ staffName: 'D', team: 'Medical', password: 'pw' }).success).toBe(false);
    expect(signInSchema.safeParse({ staffName: 'x'.repeat(61), team: 'Medical', password: 'pw' }).success).toBe(false);
    expect(signInSchema.safeParse({ staffName: 'Dana · Kim', team: 'Medical', password: 'pw' }).success).toBe(false);
    expect(signInSchema.safeParse({ staffName: 'Dana Kim', team: 'Medical', password: '' }).success).toBe(false);
    expect(signInSchema.safeParse({ staffName: 'Dana Kim', team: 'Prevent', password: 'pw' }).success).toBe(false);
  });
});

describe('syncQuerySchema', () => {
  const q = (s: string) => syncQuerySchema.safeParse(searchParamsToObject(new URLSearchParams(s)));

  it('accepts a full fetch, a delta with microseconds, reconcile and paging', () => {
    expect(q('').success).toBe(true);
    expect(q('since=2026-11-06T23:10:04.123456%2B00:00&reconcile=1').success).toBe(true);
    expect(q(`since=2026-11-06T23:10:04Z&afterAt=2026-11-06T23:10:05.5%2B00:00&afterId=${ID}&limit=200`).success).toBe(true);
  });

  it('accepts ids alone (≤200)', () => {
    const r = q(`ids=${ID},${ID}`);
    expect(r.success && r.data.ids).toEqual([ID, ID]);
    expect(q(`ids=${Array(201).fill(ID).join(',')}`).success).toBe(false);
    expect(q(`ids=${ID}&since=2026-11-06T23:10:04Z`).success).toBe(false);
  });

  it('rejects bad cursors', () => {
    expect(q('since=yesterday').success).toBe(false);
    expect(q(`afterId=${ID}`).success).toBe(false);
    expect(q('reconcile=yes').success).toBe(false);
    expect(q('limit=0').success).toBe(false);
    expect(q('extra=1').success).toBe(false);
  });
});

describe('photo and id schemas', () => {
  it('photo fields', () => {
    expect(photoFieldsSchema.safeParse({ photoId: CMID, timing: 'today' }).success).toBe(true);
    expect(photoFieldsSchema.safeParse({ photoId: CMID, timing: 'unsure' }).success).toBe(false);
    expect(photoFieldsSchema.safeParse({ photoId: 'x', timing: 'older' }).success).toBe(false);
  });

  it('photo size defaults to full', () => {
    expect(photoQuerySchema.parse({})).toEqual({ size: 'full' });
    expect(photoQuerySchema.parse({ size: 'thumb' })).toEqual({ size: 'thumb' });
    expect(photoQuerySchema.safeParse({ size: 'huge' }).success).toBe(false);
  });

  it('route ids', () => {
    expect(idParamsSchema.safeParse({ id: ID }).success).toBe(true);
    expect(idParamsSchema.safeParse({ id: '1012' }).success).toBe(false);
  });
});

describe('text PostgreSQL cannot store (NUL, unpaired surrogates)', () => {
  const base = { clientMutationId: CMID, reportingLocation: 'Base' as const };
  const NUL = 'a\u0000b';
  const LONE = ['\uD83D', 'x\uD83Dy', '\uDE00', 'x\uDE00', '\uD83D😀', '\uDE00\uD83D'];
  const issue = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
    r.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  it('refuses them in every request text field, with a clear message on that field', () => {
    for (const bad of [NUL, ...LONE]) {
      for (const key of ['name', 'age', 'gender', 'clothing', 'lastSeen', 'hair', 'contactName', 'contactPhone', 'additionalNotes']) {
        const r = createRequestSchema.safeParse({ ...base, [key]: bad });
        expect(r.success, `${key}=${JSON.stringify(bad)}`).toBe(false);
        expect(issue(r)).toContain(`${key}: Contains a character that cannot be saved`);
        expect(requestPatchSchema.safeParse({ [key]: bad }).success).toBe(false);
      }
      expect(createRequestSchema.safeParse({ ...base, reportingLocation: 'Other', otherLocation: `Gate${bad}` }).success).toBe(false);
      expect(updateRequestSchema.safeParse({ patch: { otherLocation: `Gate${bad}` }, expectedVersion: 0 }).success).toBe(false);
    }
  });

  it('refuses them in the staff name and Other team', () => {
    const r = signInSchema.safeParse({ staffName: 'Dana\u0000Kim', team: 'Medical', password: 'pw' });
    expect(issue(r)).toContain('staffName: Name: contains a character that cannot be saved');
    expect(signInSchema.safeParse({ staffName: 'Dana \uD83D', team: 'Medical', password: 'pw' }).success).toBe(false);
    expect(signInSchema.safeParse({ staffName: 'Sam Lee', team: 'Other', otherTeam: 'Gate\u0000', password: 'pw' }).success).toBe(false);
    expect(signInSchema.safeParse({ staffName: 'Sam Lee', team: 'Other', otherTeam: 'Gate \uDE00', password: 'pw' }).success).toBe(false);
  });

  it('still accepts paired surrogates (emoji) and other control-free text', () => {
    const r = createRequestSchema.parse({ ...base, name: 'Kayla 😀', clothing: '🎧 pink hat\ttab', hair: 'é ñ 中' });
    expect(r.name).toBe('Kayla 😀');
    expect(r.clothing).toBe('🎧 pink hat\ttab');
    expect(signInSchema.safeParse({ staffName: 'Dana 😀', team: 'Medical', password: 'pw' }).success).toBe(true);
  });
});

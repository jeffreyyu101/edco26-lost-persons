// Request form rules (components/request-form/form-logic.ts): validation mapping, changed-keys diff,
// the 409 review, the duplicate hint, chip append, photo intake and the create-outcome toasts.
// Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { EMPTY_FORM_VALUES, toPatch, type RequestFormValues } from '@/lib/client/form-values';
import { LIMITS, STATUS, isUuid } from '@/lib/domain';
import {
  MORE_FIELDS,
  QUEUED_TOAST_TITLE,
  canSaveEdit,
  changedKeys,
  createOutcomeToast,
  findDuplicate,
  lastSeenWithChip,
  moreFieldsFor,
  moreStartsOpen,
  nameKey,
  newUuid,
  photoIntake,
  rebaseOnConflict,
  sameDuplicate,
  sanitizeAge,
  visibleErrors,
} from '@/components/request-form/form-logic';

const v = (patch: Partial<RequestFormValues> = {}): RequestFormValues => ({ ...EMPTY_FORM_VALUES, ...patch });

let n = 0;
function row(patch: Partial<RequestSummary> = {}): RequestSummary {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    clientMutationId: null,
    caseNumber: 1000 + n,
    firstName: null,
    lastName: null,
    age: null,
    gender: null,
    heightBuild: null,
    hair: null,
    identifyingFeatures: null,
    physicalDescription: null,
    lastSeen: null,
    clothing: null,
    additionalNotes: null,
    reportingLocation: 'FA 3 – Kinetic',
    otherLocation: null,
    contactName: null,
    contactPhone: null,
    contactRelationship: null,
    contactNotes: null,
    status: STATUS.waiting,
    createdBy: 'TEST-F Sam · Medical',
    updatedBy: 'TEST-F Sam · Medical',
    createdAt: '2026-11-06T23:00:00.000000+00:00',
    updatedAt: '2026-11-06T23:00:00.000000+00:00',
    foundAt: null,
    reunionStartedAt: null,
    closedAt: null,
    rowVersion: 0,
    firstPhotoId: null,
    photoCount: 0,
    name: '',
    postShort: 'FA 3',
    ...patch,
  };
}

describe('sections and More details', () => {
  it('shows every More field for create / all, the person ones for person, none for friend', () => {
    expect(moreFieldsFor('all')).toEqual(MORE_FIELDS);
    expect(moreFieldsFor('person')).toEqual(['hair', 'heightBuild', 'identifyingFeatures', 'physicalDescription', 'additionalNotes']);
    expect(moreFieldsFor('friend')).toEqual([]);
  });

  it('opens More details when one of its fields holds text in that section', () => {
    expect(moreStartsOpen(v(), 'all')).toBe(false);
    expect(moreStartsOpen(v({ hair: '  ' }), 'all')).toBe(false);
    expect(moreStartsOpen(v({ hair: 'Blond' }), 'person')).toBe(true);
    expect(moreStartsOpen(v({ contactNotes: 'Call after 11' }), 'all')).toBe(true);
    // Contact notes live in the Friend group for the friend section, not behind More details.
    expect(moreStartsOpen(v({ contactNotes: 'Call after 11' }), 'person')).toBe(false);
  });
});

describe('validation mapping', () => {
  it('keeps digits only in Age, at most 3', () => {
    expect(sanitizeAge('19')).toBe('19');
    expect(sanitizeAge(' ~2O yrs')).toBe('2');
    expect(sanitizeAge('1234')).toBe('123');
    expect(sanitizeAge('')).toBe('');
  });

  it('flags an age outside 0–120', () => {
    expect(visibleErrors(undefined, v({ age: '121' }), null)).toEqual({ age: '0–120' });
    expect(visibleErrors(undefined, v({ age: '120' }), null)).toEqual({});
    expect(visibleErrors(undefined, v({ age: '0' }), null)).toEqual({});
  });

  it('shows a server error only while the rejected value is unchanged', () => {
    const rejected = v({ name: 'TEST-F Kayla', clothing: 'Red hoodie' });
    const errors = { name: 'Must be 120 characters or fewer' };
    expect(visibleErrors(errors, rejected, rejected)).toEqual(errors);
    expect(visibleErrors(errors, { ...rejected, clothing: 'Blue' }, rejected)).toEqual(errors);
    expect(visibleErrors(errors, { ...rejected, name: 'TEST-F K.' }, rejected)).toEqual({});
  });

  it('treats the post as one field for server errors', () => {
    const rejected = v({ reportingLocation: 'Other', otherLocation: '' });
    const errors = { otherLocation: 'Say where (Other post)' };
    expect(visibleErrors(errors, rejected, rejected)).toEqual(errors);
    expect(visibleErrors(errors, { ...rejected, otherLocation: 'Gate 2' }, rejected)).toEqual({});
    expect(visibleErrors(errors, { ...rejected, reportingLocation: 'Base' }, rejected)).toEqual({});
  });

  it('allows saving an edit only when something changed and it is valid', () => {
    const base = v({ name: 'TEST-F Kayla', age: '19', reportingLocation: 'FA 3 – Kinetic' });
    expect(canSaveEdit(base, base)).toBe(false);
    expect(canSaveEdit(base, { ...base, name: '  TEST-F   Kayla ' })).toBe(false); // same after normalising
    expect(canSaveEdit(base, { ...base, hair: 'Blond' })).toBe(true);
    expect(canSaveEdit(base, { ...base, hair: 'Blond', age: '200' })).toBe(false);
    expect(canSaveEdit(base, { ...base, reportingLocation: 'Other', otherLocation: '' })).toBe(false);
    expect(canSaveEdit(base, { ...base, reportingLocation: 'Other', otherLocation: 'Gate 2' })).toBe(true);
    // A legacy post ('' in the form) does not block editing other fields.
    const legacy = v({ name: 'TEST-F Old', reportingLocation: '' });
    expect(canSaveEdit(legacy, { ...legacy, contactPhone: '407 555 0100' })).toBe(true);
  });
});

describe('changed keys (edit sends only what changed)', () => {
  const base = v({
    name: 'TEST-F Kayla Martinez',
    age: '19',
    gender: 'Female',
    reportingLocation: 'FA 3 – Kinetic',
    clothing: 'Pink cowboy hat',
    contactPhone: '(407) 555-0142',
  });

  it('lists nothing when nothing changed', () => {
    expect(changedKeys(base, base)).toEqual([]);
    expect(changedKeys(base, { ...base, clothing: 'Pink cowboy hat  ' })).toEqual([]);
  });

  it('lists only the edited keys', () => {
    expect(changedKeys(base, { ...base, contactPhone: '(407) 555-0199' })).toEqual(['contactPhone']);
    expect(changedKeys(base, { ...base, age: '', gender: '' }).sort()).toEqual(['age', 'gender']);
    expect(toPatch(base, { ...base, age: '', gender: '' })).toEqual({ age: null, gender: null });
  });

  it('sends both post keys when the post changes', () => {
    const next = { ...base, reportingLocation: 'Other' as const, otherLocation: 'Info booth' };
    expect(changedKeys(base, next).sort()).toEqual(['otherLocation', 'reportingLocation']);
    expect(toPatch(base, next)).toEqual({ reportingLocation: 'Other', otherLocation: 'Info booth' });
  });

  it('clears a field with null', () => {
    expect(toPatch(base, { ...base, clothing: '' })).toEqual({ clothing: null });
  });
});

describe('409 review (rebaseOnConflict)', () => {
  const started = v({ name: 'TEST-F Kayla', clothing: 'Pink hat', hair: '', contactPhone: '407 555 0142', reportingLocation: 'FA 3 – Kinetic' });

  it('keeps my edits, takes theirs for fields I did not touch, and lists their changes', () => {
    const mine = { ...started, clothing: 'Pink cowboy hat, fringe top' };
    const latest = { ...started, hair: 'Blond, two braids', contactPhone: '407 555 0199' };
    const review = rebaseOnConflict(started, mine, latest, 'all');
    expect(review.values).toEqual({ ...latest, clothing: 'Pink cowboy hat, fringe top' });
    expect(review.theirs).toEqual([
      { key: 'hair', label: 'Hair', value: 'Blond, two braids', overlaps: false },
      { key: 'contactPhone', label: 'Phone', value: '407 555 0199', overlaps: false },
    ]);
    // Saving again against the latest data sends only my edit: their change is never reverted.
    expect(toPatch(latest, review.values)).toEqual({ clothing: 'Pink cowboy hat, fringe top' });
  });

  it('marks a field both of us changed, keeping my value', () => {
    const mine = { ...started, clothing: 'Mine' };
    const latest = { ...started, clothing: 'Theirs' };
    const review = rebaseOnConflict(started, mine, latest, 'person');
    expect(review.values.clothing).toBe('Mine');
    expect(review.theirs).toEqual([{ key: 'clothing', label: 'Wearing', value: 'Theirs', overlaps: true }]);
  });

  it('reports a cleared field as null and lists only fields of the section', () => {
    const latest = { ...started, clothing: '', contactPhone: '407 555 0100' };
    expect(rebaseOnConflict(started, started, latest, 'person').theirs).toEqual([
      { key: 'clothing', label: 'Wearing', value: null, overlaps: false },
    ]);
    expect(rebaseOnConflict(started, started, latest, 'friend').theirs).toEqual([
      { key: 'contactPhone', label: 'Phone', value: '407 555 0100', overlaps: false },
    ]);
  });

  it('merges the post into one entry and keeps my post as a pair', () => {
    const mine = { ...started, reportingLocation: 'Other' as const, otherLocation: 'Gate 2' };
    const latest = { ...started, reportingLocation: 'Base' as const };
    const review = rebaseOnConflict(started, mine, latest, 'all');
    expect(review.values.reportingLocation).toBe('Other');
    expect(review.values.otherLocation).toBe('Gate 2');
    expect(review.theirs).toEqual([{ key: 'post', label: 'Post', value: 'Base', overlaps: true }]);
  });

  it('lists nothing when only the status or photos changed', () => {
    expect(rebaseOnConflict(started, started, started, 'all')).toEqual({ values: started, theirs: [] });
  });
});

describe('duplicate hint', () => {
  it('matches an open request by name, case- and space-insensitively', () => {
    const kayla = row({ name: 'TEST-F Kayla  Martinez', status: STATUS.waiting });
    expect(findDuplicate([kayla], ' test-f kayla martinez ')).toEqual({ id: kayla.id, caseNumber: kayla.caseNumber });
    expect(nameKey('  T.R. ')).toBe('t.r.');
  });

  it('ignores answered and closed requests, and an empty name', () => {
    const rows = [
      row({ name: 'TEST-F A.N.', status: STATUS.notInMedical }),
      row({ name: 'TEST-F A.N.', status: STATUS.reunited }),
      row({ name: 'TEST-F A.N.', status: STATUS.cancelled }),
      row({ name: 'TEST-F A.N.', status: STATUS.discharged }),
    ];
    expect(findDuplicate(rows, 'TEST-F A.N.')).toBeNull();
    expect(findDuplicate([row({ name: '' })], '')).toBeNull();
    expect(findDuplicate([row({ name: '' })], '   ')).toBeNull();
  });

  it('counts In medical, including the legacy Bring-friend status, as open', () => {
    const a = row({ name: 'TEST-F J.D.', status: STATUS.inMedical });
    const b = row({ name: 'TEST-F M.P.', status: STATUS.legacyBringFriend });
    expect(findDuplicate([a], 'TEST-F J.D.')?.id).toBe(a.id);
    expect(findDuplicate([b], 'TEST-F M.P.')?.id).toBe(b.id);
  });

  it('skips the request itself and prefers the newest LP number', () => {
    const older = row({ name: 'TEST-F Dup', caseNumber: 1200 });
    const newer = row({ name: 'TEST-F Dup', caseNumber: 1201, clientMutationId: '11111111-1111-4111-8111-111111111111' });
    expect(findDuplicate([older, newer], 'TEST-F Dup')?.caseNumber).toBe(1201);
    expect(findDuplicate([older, newer], 'TEST-F Dup', { id: newer.id })?.caseNumber).toBe(1200);
    expect(findDuplicate([older, newer], 'TEST-F Dup', { clientMutationId: newer.clientMutationId })?.caseNumber).toBe(1200);
  });

  it('compares refs by value', () => {
    expect(sameDuplicate(null, null)).toBe(true);
    expect(sameDuplicate({ id: 'a', caseNumber: 1 }, { id: 'a', caseNumber: 1 })).toBe(true);
    expect(sameDuplicate({ id: 'a', caseNumber: 1 }, null)).toBe(false);
    expect(sameDuplicate({ id: 'a', caseNumber: 1 }, { id: 'b', caseNumber: 1 })).toBe(false);
  });
});

describe('stage chips', () => {
  it('appends with ", " when the field is not empty', () => {
    expect(lastSeenWithChip('', 'kineticFIELD', LIMITS.lastSeen)).toBe('kineticFIELD');
    expect(lastSeenWithChip('   ', 'kineticFIELD', LIMITS.lastSeen)).toBe('kineticFIELD');
    expect(lastSeenWithChip('rail, ~10:30', 'kineticFIELD', LIMITS.lastSeen)).toBe('rail, ~10:30, kineticFIELD');
    expect(lastSeenWithChip('neonGARDEN', 'Taken to medical', LIMITS.lastSeen)).toBe('neonGARDEN, Taken to medical');
  });

  it('does not double a trailing separator the user already typed', () => {
    expect(lastSeenWithChip('near the bridge, ', 'kineticFIELD', LIMITS.lastSeen)).toBe('near the bridge, kineticFIELD');
    expect(lastSeenWithChip('near the bridge,', 'kineticFIELD', LIMITS.lastSeen)).toBe('near the bridge, kineticFIELD');
  });

  it('ignores a tap that would pass the field limit', () => {
    const full = 'x'.repeat(LIMITS.lastSeen - 3);
    expect(lastSeenWithChip(full, 'neonGARDEN', LIMITS.lastSeen)).toBe(full);
  });
});

describe('photo intake (max 3)', () => {
  it('takes what fits and reports the rest', () => {
    expect(photoIntake(0, 1)).toEqual({ take: 1, dropped: 0 });
    expect(photoIntake(0, 5)).toEqual({ take: 3, dropped: 2 });
    expect(photoIntake(2, 2)).toEqual({ take: 1, dropped: 1 });
    expect(photoIntake(3, 1)).toEqual({ take: 0, dropped: 1 });
    expect(photoIntake(1, 0)).toEqual({ take: 0, dropped: 0 });
  });
});

describe('create outcome toasts (A13)', () => {
  it('says "LP-1014 saved" when sent and the queued copy when saved on the phone', () => {
    expect(createOutcomeToast({ outcome: 'sent', request: row({ caseNumber: 1014 }) })).toMatchObject({ tone: 'green', icon: 'check', title: 'LP-1014 saved' });
    expect(createOutcomeToast({ outcome: 'queued', mutationId: newUuid() })).toMatchObject({ icon: 'cloud-off', title: QUEUED_TOAST_TITLE });
    expect(QUEUED_TOAST_TITLE).toBe('Saved on this phone · sends when back online');
  });

  it('leaves needs-attention and not-saved to the form', () => {
    expect(createOutcomeToast({ outcome: 'needs_attention', mutationId: newUuid(), message: 'x' })).toBeNull();
    expect(createOutcomeToast({ outcome: 'not_saved', message: 'x' })).toBeNull();
  });
});

describe('newUuid', () => {
  it('returns a v4 UUID, with or without crypto.randomUUID', () => {
    expect(isUuid(newUuid())).toBe(true);
    const real = globalThis.crypto;
    // An insecure context (plain http on a LAN address) has getRandomValues but no randomUUID.
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(b: T) => real.getRandomValues(b as never) as T });
    try {
      const ids = new Set(Array.from({ length: 50 }, () => newUuid()));
      expect(ids.size).toBe(50);
      for (const id of ids) {
        expect(isUuid(id)).toBe(true);
        expect(id[14]).toBe('4');
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(globalThis.crypto).toBe(real);
  });
});

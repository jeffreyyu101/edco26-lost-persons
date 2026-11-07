// Request form rules (components/request-form/form-logic.ts): sections, free-text age and gender (the
// gender chips), validation mapping, changed-keys diff, the 409 review, the duplicate hint, chip append,
// photo intake, the keyboard helpers and ids. Synthetic data only.
import { describe, expect, it, vi } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { EMPTY_FORM_VALUES, formValuesFromRequest, toPatch, type RequestFormValues } from '@/lib/client/form-values';
import { LIMITS, STATUS, isUuid } from '@/lib/domain';
import {
  GENDER_CHIPS,
  MORE_FIELDS,
  canSaveEdit,
  changedKeys,
  findDuplicate,
  genderAfterChip,
  genderChipFor,
  lastSeenWithChip,
  legacyPostOf,
  moreFieldsFor,
  nameKey,
  newUuid,
  onlyOutsideFormChanged,
  photoIntake,
  rebaseOnConflict,
  revealDelta,
  sameDuplicate,
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
  it('More details holds the person extras, in order, with the person (all, person) and not for friend', () => {
    expect(MORE_FIELDS).toEqual(['hair', 'heightBuild', 'identifyingFeatures', 'physicalDescription', 'additionalNotes']);
    expect(moreFieldsFor('all')).toEqual(MORE_FIELDS);
    expect(moreFieldsFor('person')).toEqual(MORE_FIELDS);
    expect(moreFieldsFor('friend')).toEqual([]);
  });

  it('contact notes belong to Friend or family, never to More details', () => {
    expect(MORE_FIELDS).not.toContain('contactNotes');
  });
});

describe('free-text age and gender', () => {
  it('offers Male, Female and Other as quick fills', () => {
    expect(GENDER_CHIPS).toEqual(['Male', 'Female', 'Other']);
  });

  it('turns on the chip the typed gender matches, ignoring case and outer spaces', () => {
    expect(genderChipFor('Female')).toBe('Female');
    expect(genderChipFor('  male ')).toBe('Male');
    expect(genderChipFor('OTHER')).toBe('Other');
    expect(genderChipFor('Non-binary')).toBeNull();
    expect(genderChipFor('Fem')).toBeNull();
    expect(genderChipFor('')).toBeNull();
  });

  it('a chip writes its word, replacing what was typed; tapping the chip that is on clears it', () => {
    expect(genderAfterChip('', 'Female')).toBe('Female');
    expect(genderAfterChip('Non-binary', 'Other')).toBe('Other');
    expect(genderAfterChip('Male', 'Female')).toBe('Female');
    expect(genderAfterChip('Female', 'Female')).toBe('');
    expect(genderAfterChip('female', 'Female')).toBe('');
  });

  it('never flags an age or a gender on the phone, and saves an edit with any age text', () => {
    for (const age of ['mid-20s', '24', '121', 'early 30s', '18–21', '~40']) {
      expect(visibleErrors(undefined, v({ age }), null)).toEqual({});
    }
    expect(visibleErrors(undefined, v({ gender: 'Non-binary' }), null)).toEqual({});
    const base = v({ name: 'TEST-F Kayla', age: '24', reportingLocation: 'FA 3 – Kinetic' });
    expect(canSaveEdit(base, { ...base, age: 'mid-20s' })).toBe(true);
    expect(canSaveEdit(base, { ...base, gender: 'Non-binary' })).toBe(true);
    expect(changedKeys(base, { ...base, age: ' mid-20s ', gender: 'Female' })).toEqual(['age', 'gender']);
  });
});

describe('validation mapping', () => {
  it('shows a server error on age while the rejected text is unchanged', () => {
    const rejected = v({ age: 'mid-20s' });
    const errors = { age: 'Must be 40 characters or fewer' };
    expect(visibleErrors(errors, rejected, rejected)).toEqual(errors);
    expect(visibleErrors(errors, { ...rejected, age: '25' }, rejected)).toEqual({});
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
    // Age is free text: nothing typed there blocks saving the rest.
    expect(canSaveEdit(base, { ...base, hair: 'Blond', age: '200' })).toBe(true);
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

describe('edit carries on silently past changes outside the form (A10, onlyOutsideFormChanged)', () => {
  // Edit opened from the phone's cache at v3; the first sync then brings a newer version.
  const cached = row({ name: 'TEST-F Dana Kim', firstName: 'TEST-F Dana', lastName: 'Kim', clothing: 'Red hoodie', rowVersion: 3 });
  const base = formValuesFromRequest(cached);
  const legacy = legacyPostOf(cached);

  it('a liaison answer, a reunion or a photo is not a reason to review', () => {
    const answered = { ...cached, status: STATUS.inMedical, foundAt: '2026-11-06T23:05:00Z', reunionStartedAt: '2026-11-06T23:05:00Z', updatedBy: 'TEST-F Rae · Medical', rowVersion: 4 };
    expect(onlyOutsideFormChanged(base, legacy, answered)).toBe(true);
    expect(onlyOutsideFormChanged(base, legacy, { ...answered, status: STATUS.reunited, closedAt: '2026-11-06T23:20:00Z', rowVersion: 5 })).toBe(true);
    expect(onlyOutsideFormChanged(base, legacy, { ...cached, firstPhotoId: '11111111-1111-4111-8111-111111111111', photoCount: 1, rowVersion: 4 })).toBe(true);
  });

  it('any field the form holds is reviewed, the post and a legacy post included', () => {
    expect(onlyOutsideFormChanged(base, legacy, { ...cached, clothing: 'Blue hoodie', rowVersion: 4 })).toBe(false);
    expect(onlyOutsideFormChanged(base, legacy, { ...cached, contactPhone: '407 555 0100', rowVersion: 4 })).toBe(false);
    expect(onlyOutsideFormChanged(base, legacy, { ...cached, reportingLocation: 'Other', otherLocation: 'Gate 9', rowVersion: 4 })).toBe(false);
    const old = row({ reportingLocation: 'FA 3', postShort: 'FA 3' });
    expect(legacyPostOf(old)).toBe('FA 3');
    // Legacy 'FA 3' → canonical FA 3 – Kinetic: the form shows a different post now.
    expect(onlyOutsideFormChanged(formValuesFromRequest(old), legacyPostOf(old), { ...old, reportingLocation: 'FA 3 – Kinetic' })).toBe(false);
    expect(onlyOutsideFormChanged(formValuesFromRequest(old), legacyPostOf(old), { ...old, status: STATUS.notInMedical })).toBe(true);
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

describe('the on-screen keyboard', () => {
  // Whether a keyboard is up: tests/unit/client/visual-viewport.test.ts (keyboardBox, shared with the sheets).
  it('scrolls the focused row into view with a margin, never past its top', () => {
    const view = { top: 60, bottom: 440 };
    // Already in view.
    expect(revealDelta(view, { top: 100, bottom: 200 }, 12)).toBe(0);
    // Below the keyboard edge: down just enough to show its bottom.
    expect(revealDelta(view, { top: 420, bottom: 500 }, 12)).toBe(72);
    // Above the top: up to show its top.
    expect(revealDelta(view, { top: 20, bottom: 80 }, 12)).toBe(-52);
    // Taller than the view (Last seen with its chips on a short screen): its top lands at the top.
    expect(revealDelta(view, { top: 300, bottom: 900 }, 12)).toBe(228);
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

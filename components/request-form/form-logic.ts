// Pure helpers behind the request form (new / edit / needs-attention editor). No React, no I/O, so the
// rules are unit-tested in node (tests/unit/request-form/form-logic.test.ts).
import type { RequestSummary } from '@/lib/api-types';
import { hasPost, parseAge, toPatch, type RequestFormValues } from '@/lib/client/form-values';
import {
  AGE_MAX,
  AGE_MIN,
  FIELD_LABELS,
  MAX_PHOTOS,
  OTHER_POST,
  appendChip,
  postFull,
  statusBucket,
  type EditSection,
} from '@/lib/domain';

export type FormKey = keyof RequestFormValues;
export type FormErrors = Partial<Record<FormKey, string>>;

// ---------------------------------------------------------------------------------------------------
// Sections (v2.1 A24) and "More details"
// ---------------------------------------------------------------------------------------------------

/** Behind "More details", in the mockup's order: Hair, Build, Features, Description, Contact notes, Other notes. */
export const MORE_FIELDS = [
  'hair',
  'heightBuild',
  'identifyingFeatures',
  'physicalDescription',
  'contactNotes',
  'additionalNotes',
] as const satisfies readonly FormKey[];
export type MoreField = (typeof MORE_FIELDS)[number];

/**
 * Which "More details" rows a section shows. Person: everything about the person (no contact notes).
 * Friend: none (contact notes sit in the Friend or family group instead, so a 4-field edit has no
 * disclosure row). All / create / outbox: all six.
 */
export function moreFieldsFor(section: EditSection): readonly MoreField[] {
  if (section === 'friend') return [];
  if (section === 'person') return MORE_FIELDS.filter((k) => k !== 'contactNotes');
  return MORE_FIELDS;
}

/** "More details" starts open when any of its fields already holds text (edit prefill, restored draft). */
export function moreStartsOpen(values: RequestFormValues, section: EditSection): boolean {
  return moreFieldsFor(section).some((k) => values[k].trim() !== '');
}

// ---------------------------------------------------------------------------------------------------
// Validation shown on the form
// ---------------------------------------------------------------------------------------------------

/** Age keeps digits only (the keypad is numeric, but paste and hardware keyboards are not), at most 3. */
export function sanitizeAge(input: string): string {
  return input.replace(/\D/g, '').slice(0, 3);
}

/**
 * Errors to show: server errors (needs-attention item, 422) on fields still holding the rejected value,
 * plus the local age range check. A server error disappears as soon as its field is edited.
 */
export function visibleErrors(
  serverErrors: FormErrors | undefined,
  values: RequestFormValues,
  rejected: RequestFormValues | null,
): FormErrors {
  const out: FormErrors = {};
  if (serverErrors) {
    for (const [key, message] of Object.entries(serverErrors) as Array<[FormKey, string | undefined]>) {
      if (!message) continue;
      const postKey = key === 'reportingLocation' || key === 'otherLocation';
      const unchanged = rejected
        ? postKey
          ? values.reportingLocation === rejected.reportingLocation && values.otherLocation === rejected.otherLocation
          : values[key] === rejected[key]
        : true;
      if (unchanged) out[key] = message;
    }
  }
  if (parseAge(values.age) === 'invalid') out.age = `${AGE_MIN}–${AGE_MAX}`;
  return out;
}

/** Edit: something changed, age is valid, and Other still says where (a legacy post may stay as it is). */
export function canSaveEdit(base: RequestFormValues, values: RequestFormValues): boolean {
  if (parseAge(values.age) === 'invalid') return false;
  if (values.reportingLocation === OTHER_POST && !hasPost(values)) return false;
  return toPatch(base, values) !== null;
}

// ---------------------------------------------------------------------------------------------------
// Changed keys (edit sends only what changed, A10) and the 409 review
// ---------------------------------------------------------------------------------------------------

/** Form keys that differ between two value sets, with the server's normalisation (toPatch). */
export function changedKeys(base: RequestFormValues, values: RequestFormValues): FormKey[] {
  const patch = toPatch(base, values);
  if (!patch) return [];
  return Object.keys(patch) as FormKey[];
}

export interface TheirChange {
  key: 'name' | 'age' | 'gender' | 'post' | MoreField | 'clothing' | 'lastSeen' | 'contactName' | 'contactPhone' | 'contactRelationship';
  label: string;
  /** The value now saved (display form); null = cleared. */
  value: string | null;
  /** The user also edited this field: their own value is kept in the form. */
  overlaps: boolean;
}

export interface ConflictReview {
  /** The latest data with the user's own edits laid back on top (nothing is sent until they save again). */
  values: RequestFormValues;
  /** What the other person changed, for the review list (only fields this section shows). */
  theirs: TheirChange[];
}

const SECTION_KEYS: Readonly<Record<EditSection, ReadonlySet<string>>> = {
  person: new Set(['name', 'age', 'gender', 'clothing', 'lastSeen', 'hair', 'heightBuild', 'identifyingFeatures', 'physicalDescription', 'additionalNotes']),
  friend: new Set(['contactName', 'contactPhone', 'contactRelationship', 'contactNotes']),
  all: new Set([
    'name', 'age', 'gender', 'reportingLocation', 'otherLocation', 'clothing', 'lastSeen', 'hair', 'heightBuild',
    'identifyingFeatures', 'physicalDescription', 'additionalNotes', 'contactName', 'contactPhone', 'contactRelationship', 'contactNotes',
  ]),
};

const blankToNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/**
 * A 409 on edit (A10): no automatic rebase and nothing is resent. The form shows the latest data, with the
 * fields the user changed (versus the version they started from) kept as they typed them, and lists what
 * the other person changed. Saving again diffs against `latest`, so only the user's own edits are sent and
 * the other person's changes are never reverted.
 */
export function rebaseOnConflict(
  started: RequestFormValues,
  mine: RequestFormValues,
  latest: RequestFormValues,
  section: EditSection,
): ConflictReview {
  const mineChanged = new Set<string>(changedKeys(started, mine));
  const values: RequestFormValues = { ...latest };
  for (const key of mineChanged) {
    if (key === 'reportingLocation' || key === 'otherLocation') {
      values.reportingLocation = mine.reportingLocation;
      values.otherLocation = mine.otherLocation;
    } else {
      (values as unknown as Record<string, string>)[key] = mine[key as FormKey];
    }
  }

  const shown = SECTION_KEYS[section];
  const theirs: TheirChange[] = [];
  let postDone = false;
  for (const key of changedKeys(started, latest)) {
    if (!shown.has(key)) continue;
    if (key === 'reportingLocation' || key === 'otherLocation') {
      if (postDone) continue;
      postDone = true;
      theirs.push({
        key: 'post',
        label: FIELD_LABELS.post,
        value: latest.reportingLocation ? postFull(latest.reportingLocation, latest.otherLocation) : null,
        overlaps: mineChanged.has('reportingLocation') || mineChanged.has('otherLocation'),
      });
      continue;
    }
    const k = key as TheirChange['key'];
    theirs.push({
      key: k,
      label: FIELD_LABELS[k as keyof typeof FIELD_LABELS],
      value: blankToNull(latest[key as FormKey]),
      overlaps: mineChanged.has(key),
    });
  }
  return { values, theirs };
}

// ---------------------------------------------------------------------------------------------------
// Duplicate hint (spec §8): an OPEN request with the same name, case-insensitive
// ---------------------------------------------------------------------------------------------------

export function nameKey(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface DuplicateRef {
  id: string;
  caseNumber: number;
}

/** The newest open request with the same name, skipping the request being edited / sent itself. */
export function findDuplicate(
  rows: Iterable<RequestSummary>,
  name: string,
  exclude: { id?: string | null; clientMutationId?: string | null } = {},
): DuplicateRef | null {
  const key = nameKey(name);
  if (!key) return null;
  let best: RequestSummary | null = null;
  for (const row of rows) {
    if (statusBucket(row.status) !== 'open') continue;
    if (exclude.id && row.id === exclude.id) continue;
    if (exclude.clientMutationId && row.clientMutationId === exclude.clientMutationId) continue;
    if (nameKey(row.name) !== key) continue;
    if (!best || row.caseNumber > best.caseNumber) best = row;
  }
  return best ? { id: best.id, caseNumber: best.caseNumber } : null;
}

export const sameDuplicate = (a: DuplicateRef | null, b: DuplicateRef | null): boolean =>
  a === b || (!!a && !!b && a.id === b.id && a.caseNumber === b.caseNumber);

// ---------------------------------------------------------------------------------------------------
// Stage chips (spec §8): tap appends, with ", " when the field isn't empty
// ---------------------------------------------------------------------------------------------------

/** Last seen after a chip tap. Never exceeds the field limit (the tap is ignored instead). */
export function lastSeenWithChip(current: string, chip: string, max: number): string {
  const next = appendChip(current, chip);
  return Array.from(next).length <= max ? next : current;
}

// ---------------------------------------------------------------------------------------------------
// Photos (max 3)
// ---------------------------------------------------------------------------------------------------

/** How many of `picked` files can be added next to `current` photos, and how many were dropped. */
export function photoIntake(current: number, picked: number): { take: number; dropped: number } {
  const room = Math.max(0, MAX_PHOTOS - current);
  const take = Math.min(room, Math.max(0, picked));
  return { take, dropped: Math.max(0, picked) - take };
}

// ---------------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------------

/** A v4 UUID. crypto.randomUUID needs a secure context; fall back to getRandomValues elsewhere. */
export function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

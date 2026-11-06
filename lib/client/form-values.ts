// The request form's values (strings, as typed) and their conversion to API bodies. Shared by the form
// (components/request-form), the store and the outbox editor. Pure.
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones.
import type { RequestSummary } from '../api-types';
import {
  AGE_MAX,
  AGE_MIN,
  FIELD_COLUMNS,
  GENDERS,
  OTHER_POST,
  TEXT_FIELDS,
  isPostValue,
  isUuid,
  joinName,
  type Gender,
  type PostValue,
  type TextField,
} from '../domain';
import type { CreateRequestBody, RequestPatch } from '../validation';

export interface RequestFormValues {
  name: string;
  /** Digits as typed ("" = not given). */
  age: string;
  gender: Gender | '';
  reportingLocation: PostValue | '';
  otherLocation: string;
  clothing: string;
  lastSeen: string;
  hair: string;
  heightBuild: string;
  identifyingFeatures: string;
  physicalDescription: string;
  additionalNotes: string;
  contactName: string;
  contactPhone: string;
  contactRelationship: string;
  contactNotes: string;
}

export const EMPTY_FORM_VALUES: Readonly<RequestFormValues> = Object.freeze({
  name: '',
  age: '',
  gender: '',
  reportingLocation: '',
  otherLocation: '',
  clothing: '',
  lastSeen: '',
  hair: '',
  heightBuild: '',
  identifyingFeatures: '',
  physicalDescription: '',
  additionalNotes: '',
  contactName: '',
  contactPhone: '',
  contactRelationship: '',
  contactNotes: '',
});

/** Prefill for edit mode. */
export function formValuesFromRequest(row: RequestSummary): RequestFormValues {
  const gender: Gender | '' = (GENDERS as readonly string[]).includes(row.gender ?? '') ? (row.gender as Gender) : '';
  const values: RequestFormValues = {
    ...EMPTY_FORM_VALUES,
    name: row.name,
    age: row.age === null ? '' : String(row.age),
    gender,
    reportingLocation: isPostValue(row.reportingLocation) ? row.reportingLocation : '',
    otherLocation: row.otherLocation ?? '',
  };
  for (const key of TEXT_FIELDS) values[key] = row[key] ?? '';
  return values;
}

const clean = (s: string): string | null => (s.trim() === '' ? null : s.trim());
const cleanName = (s: string): string | null => s.trim().replace(/\s+/g, ' ') || null;

/** "" → null; a whole number 0–120 → number; anything else → 'invalid'. */
export function parseAge(input: string): number | null | 'invalid' {
  const t = input.trim();
  if (t === '') return null;
  if (!/^\d{1,3}$/.test(t)) return 'invalid';
  const n = Number(t);
  return n >= AGE_MIN && n <= AGE_MAX ? n : 'invalid';
}

/** Any detail about the person or the friend (the post is not a detail). A photo counts. */
export function hasAnyDetail(values: RequestFormValues, photoCount = 0): boolean {
  if (photoCount > 0) return true;
  if (clean(values.name) || clean(values.age) || values.gender) return true;
  return TEXT_FIELDS.some((key) => clean(values[key]) !== null);
}

/** The post is chosen (and Other says where). */
export function hasPost(values: RequestFormValues): boolean {
  if (!values.reportingLocation) return false;
  return values.reportingLocation !== OTHER_POST || clean(values.otherLocation) !== null;
}

/** "Send request" is enabled once any detail is filled in (a photo counts), the post is set, and age is valid. */
export function canSend(values: RequestFormValues, photoCount = 0): boolean {
  return hasAnyDetail(values, photoCount) && hasPost(values) && parseAge(values.age) !== 'invalid';
}

/** The POST /api/requests body. Call only when canSend() is true. */
export function toCreateBody(values: RequestFormValues, clientMutationId: string): CreateRequestBody {
  const age = parseAge(values.age);
  const body: CreateRequestBody = {
    clientMutationId,
    reportingLocation: values.reportingLocation as PostValue,
    otherLocation: values.reportingLocation === OTHER_POST ? clean(values.otherLocation) : null,
    name: cleanName(values.name),
    age: age === 'invalid' ? null : age,
    gender: values.gender || null,
  };
  for (const key of TEXT_FIELDS) body[key] = clean(values[key]);
  return body;
}

/**
 * Only the changed keys, for PATCH (edit sends only what changed). Values are compared after the same
 * normalisation the server applies. A post change always sends both reportingLocation and otherLocation.
 * Returns null when nothing changed.
 */
export function toPatch(base: RequestFormValues, values: RequestFormValues): RequestPatch | null {
  const patch: RequestPatch = {};
  if (cleanName(base.name) !== cleanName(values.name)) patch.name = cleanName(values.name);
  const baseAge = parseAge(base.age);
  const age = parseAge(values.age);
  if (age !== 'invalid' && age !== baseAge) patch.age = age;
  if ((base.gender || null) !== (values.gender || null)) patch.gender = values.gender || null;
  const other = (v: RequestFormValues) => (v.reportingLocation === OTHER_POST ? clean(v.otherLocation) : null);
  if (values.reportingLocation && (base.reportingLocation !== values.reportingLocation || other(base) !== other(values))) {
    patch.reportingLocation = values.reportingLocation;
    patch.otherLocation = other(values);
  }
  for (const key of TEXT_FIELDS as readonly TextField[]) {
    if (clean(base[key]) !== clean(values[key])) patch[key] = clean(values[key]);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Jeffrey's name split, as found on his offline queue items. */
interface LegacyNameFields {
  first_name?: unknown;
  last_name?: unknown;
}

const legacyText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Prefill for the needs-attention editor (`?outbox=<mutationId>`, RequestForm mode 'outbox'): the inverse
 * of toCreateBody, so formValuesFromCreateBody(toCreateBody(v, id)) gives back v as the server would store
 * it (trimmed, blank → ''). When the payload has no `name` but still carries a legacy first_name /
 * last_name, they are joined into name (same rule as joinName). A reportingLocation that is not a valid
 * post reads as '' so the user has to choose one; otherLocation is kept only for Other.
 */
export function formValuesFromCreateBody(payload: CreateRequestBody): RequestFormValues {
  const legacy = payload as CreateRequestBody & LegacyNameFields;
  const name = payload.name ?? (joinName(legacyText(legacy.first_name), legacyText(legacy.last_name)) || null);
  const gender: Gender | '' = (GENDERS as readonly string[]).includes(payload.gender ?? '') ? (payload.gender as Gender) : '';
  const post = isPostValue(payload.reportingLocation) ? payload.reportingLocation : '';
  const values: RequestFormValues = {
    ...EMPTY_FORM_VALUES,
    name: name ?? '',
    age: typeof payload.age === 'number' ? String(payload.age) : '',
    gender,
    reportingLocation: post,
    otherLocation: post === OTHER_POST ? (payload.otherLocation ?? '') : '',
  };
  for (const key of TEXT_FIELDS) values[key] = payload[key] ?? '';
  return values;
}

/**
 * One item of Jeffrey's legacy `localStorage['edc_pending_queue']` (snake_case, the name split into
 * first_name / last_name, age a number or null) → the CreateRequestBody of an outbox job with source
 * 'legacy', keeping its client_mutation_id. first_name and last_name are joined into `name`. Null when the
 * item is not an object or has no valid client_mutation_id (nothing to deduplicate on).
 * An unknown reporting_location is passed through unchanged: the server rejects it (definitive 4xx), the
 * job becomes "Needs attention", and the editor (formValuesFromCreateBody) asks for a post. Nothing is lost.
 */
export function createBodyFromLegacyQueueItem(item: unknown): CreateRequestBody | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const raw = item as Record<string, unknown>;
  const clientMutationId = raw['client_mutation_id'];
  if (typeof clientMutationId !== 'string' || !isUuid(clientMutationId)) return null;
  const location = typeof raw['reporting_location'] === 'string' ? raw['reporting_location'] : '';
  const age = raw['age'];
  const gender = raw['gender'];
  const body: CreateRequestBody = {
    clientMutationId,
    reportingLocation: location as PostValue,
    otherLocation: location === OTHER_POST ? legacyText(raw['other_location']) : null,
    name: cleanName(joinName(legacyText(raw['first_name']), legacyText(raw['last_name']))),
    age: typeof age === 'number' && Number.isInteger(age) && age >= AGE_MIN && age <= AGE_MAX ? age : null,
    gender: typeof gender === 'string' && (GENDERS as readonly string[]).includes(gender) ? (gender as Gender) : null,
  };
  for (const key of TEXT_FIELDS) {
    const v = legacyText(raw[FIELD_COLUMNS[key]]);
    body[key] = v === null ? null : v.trim();
  }
  return body;
}

// The request form's values (strings, as typed) and their conversion to API bodies. Shared by the form
// (components/request-form), the store and the outbox editor. Pure.
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones. One contract change
// since (Jeffrey, 2026-11-06 10:31): age and gender are free text, sent trimmed with '' → null, like every
// other text field; the form no longer checks an age range or a gender list.
import type { RequestSummary } from '../api-types';
import type { FriendInMedical } from '../domain';
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
  /** Free text as typed: "24", "mid-20s" ("" = not given). */
  age: string;
  /** Free text as typed, or a quick-fill chip's word (Male / Female / Other); "" = not given. */
  gender: string;
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
  /** (Companion) "Is a friend already with them in medical?" No · Yes · Not sure (default). Create only. */
  friendInMedical?: FriendInMedical;
  /** (Companion) Their name, optional, kept only with Yes. */
  friendInMedicalName?: string;
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
  const values: RequestFormValues = {
    ...EMPTY_FORM_VALUES,
    name: row.name,
    // String(): a row cached on the phone before age became text can still hold a number.
    age: row.age === null || row.age === undefined ? '' : String(row.age),
    gender: row.gender ?? '',
    reportingLocation: isPostValue(row.reportingLocation) ? row.reportingLocation : '',
    otherLocation: row.otherLocation ?? '',
  };
  for (const key of TEXT_FIELDS) values[key] = row[key] ?? '';
  return values;
}

const clean = (s: string): string | null => (s.trim() === '' ? null : s.trim());
const cleanName = (s: string): string | null => s.trim().replace(/\s+/g, ' ') || null;

/**
 * "" → null; a whole number 0–120 → number; anything else → 'invalid'. The form no longer uses it (age is
 * free text since 2026-11-06); kept because this module's exports are frozen.
 */
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
  if (clean(values.name) || clean(values.age) || clean(values.gender)) return true;
  return TEXT_FIELDS.some((key) => clean(values[key]) !== null);
}

/** The post is chosen (and Other says where). */
export function hasPost(values: RequestFormValues): boolean {
  if (!values.reportingLocation) return false;
  return values.reportingLocation !== OTHER_POST || clean(values.otherLocation) !== null;
}

/** "Send request" is enabled once any detail is filled in (a photo counts) and the post is set. */
export function canSend(values: RequestFormValues, photoCount = 0): boolean {
  return hasAnyDetail(values, photoCount) && hasPost(values);
}

/** The POST /api/requests body. Call only when canSend() is true. */
export function toCreateBody(values: RequestFormValues, clientMutationId: string): CreateRequestBody {
  const body: CreateRequestBody = {
    clientMutationId,
    reportingLocation: values.reportingLocation as PostValue,
    otherLocation: values.reportingLocation === OTHER_POST ? clean(values.otherLocation) : null,
    name: cleanName(values.name),
    age: clean(values.age),
    gender: clean(values.gender),
  };
  for (const key of TEXT_FIELDS) body[key] = clean(values[key]);
  // (Companion) Sent only when answered: the server stores 'unsure' by default.
  if (values.friendInMedical === 'yes' || values.friendInMedical === 'no') body.friendInMedical = values.friendInMedical;
  if (values.friendInMedical === 'yes') {
    const name = cleanName(values.friendInMedicalName ?? '');
    if (name) body.friendInMedicalName = name.slice(0, 60);
  }
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
  if (clean(base.age) !== clean(values.age)) patch.age = clean(values.age);
  if (clean(base.gender) !== clean(values.gender)) patch.gender = clean(values.gender);
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

const FORM_KEYS: ReadonlySet<string> = new Set(Object.keys(EMPTY_FORM_VALUES));

/**
 * Field-level errors for RequestForm `errors` from a server rejection: an ApiError's `field` (camelCase)
 * or OutboxItem.lastError.field. firstName / lastName point at the single Name input. A field the form
 * doesn't show (expectedVersion, clientMutationId, …) or no field at all gives {} (show `message` as a
 * notice instead).
 */
export function formErrorsFromField(
  field: string | null | undefined,
  message: string,
): Partial<Record<keyof RequestFormValues, string>> {
  if (!field) return {};
  const key = field === 'firstName' || field === 'lastName' ? 'name' : field;
  return FORM_KEYS.has(key) ? { [key as keyof RequestFormValues]: message } : {};
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
  const post = isPostValue(payload.reportingLocation) ? payload.reportingLocation : '';
  const values: RequestFormValues = {
    ...EMPTY_FORM_VALUES,
    name: name ?? '',
    // Text, or a number from a job queued before age became text (and from Jeffrey's legacy queue).
    age: payload.age === null || payload.age === undefined ? '' : String(payload.age),
    gender: payload.gender ?? '',
    reportingLocation: post,
    otherLocation: post === OTHER_POST ? (payload.otherLocation ?? '') : '',
  };
  for (const key of TEXT_FIELDS) values[key] = payload[key] ?? '';
  if (payload.friendInMedical === 'yes' || payload.friendInMedical === 'no') values.friendInMedical = payload.friendInMedical;
  if (payload.friendInMedicalName) values.friendInMedicalName = payload.friendInMedicalName;
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

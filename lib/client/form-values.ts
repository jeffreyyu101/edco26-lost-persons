// The request form's values (strings, as typed) and their conversion to API bodies. Shared by the form
// (components/request-form), the store and the outbox editor. Pure.
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones.
import type { RequestSummary } from '../api-types';
import {
  AGE_MAX,
  AGE_MIN,
  GENDERS,
  OTHER_POST,
  TEXT_FIELDS,
  isPostValue,
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

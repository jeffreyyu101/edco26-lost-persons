// Database JSON (snake_case, built by SQL lp_row / lp_detail / lp_sync) → API DTOs (camelCase, A1), and
// validated API bodies → the snake_case payloads the lp_* functions take. Every field is copied through
// an EXPLICIT allowlist, so legacy columns never leak to the client. Pure (no I/O); server only.
import 'server-only';
import type { AuditEvent, AuditFieldValues, AuditHold, PhotoInfo, RequestDetail, RequestSummary, SyncResponse } from '../api-types';
import {
  FIELD_COLUMNS,
  STATUS,
  STATUS_KINDS,
  joinName,
  postShort,
  splitName,
  type EditableField,
  type PhotoTimingAny,
  type StatusKind,
} from '../domain';
import type { CreateRequestInput, RequestPatchInput } from '../validation';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const reqStr = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const reqNum = (v: unknown): number => num(v) ?? 0;
/** Free text that may arrive as a number (an age saved before it became text): 24 → "24". */
const text = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v));
const id = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

// ---------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------

/** lp_row JSON → RequestSummary (every known column, camelCased, plus the derived name / postShort). */
export function mapRow(raw: unknown): RequestSummary {
  const r = isObject(raw) ? raw : {};
  const firstName = str(r.first_name);
  const lastName = str(r.last_name);
  const reportingLocation = reqStr(r.reporting_location);
  const otherLocation = str(r.other_location);
  return {
    id: id(r.id),
    clientMutationId: str(r.client_mutation_id),
    caseNumber: reqNum(r.case_number),
    firstName,
    lastName,
    age: text(r.age),
    gender: str(r.gender),
    heightBuild: str(r.height_build),
    hair: str(r.hair),
    identifyingFeatures: str(r.identifying_features),
    physicalDescription: str(r.physical_description),
    lastSeen: str(r.last_seen),
    clothing: str(r.clothing),
    additionalNotes: str(r.additional_notes),
    reportingLocation,
    otherLocation,
    contactName: str(r.contact_name),
    contactPhone: str(r.contact_phone),
    contactRelationship: str(r.contact_relationship),
    contactNotes: str(r.contact_notes),
    status: reqStr(r.status),
    createdBy: reqStr(r.created_by),
    updatedBy: reqStr(r.updated_by),
    createdAt: reqStr(r.created_at),
    updatedAt: reqStr(r.updated_at),
    foundAt: str(r.found_at),
    reunionStartedAt: str(r.reunion_started_at),
    closedAt: str(r.closed_at),
    rowVersion: reqNum(r.row_version),
    firstPhotoId: str(r.first_photo_id),
    photoCount: reqNum(r.photo_count),
    name: joinName(firstName, lastName),
    postShort: postShort(reportingLocation, otherLocation),
    medicalLocation: str(r.medical_location),
    // (F5) The "Not found yet" hold. A database without step 1d sends neither: not held, no checks.
    recheckAt: str(r.recheck_at),
    notFoundChecks: reqNum(r.not_found_checks),
  };
}

/** The keys of a RequestSummary, for tests that assert the allowlist. */
export const REQUEST_SUMMARY_KEYS = Object.keys(mapRow({})).sort();

// ---------------------------------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------------------------------

/** Legacy / unknown timings read back as 'unsure' ("Timing unknown"). */
export function photoTiming(value: unknown): PhotoTimingAny {
  return value === 'today' || value === 'older' ? value : 'unsure';
}

/** {id, photo_timing, uploaded_by, created_at, has_thumb} → PhotoInfo. */
export function mapPhoto(raw: unknown): PhotoInfo {
  const p = isObject(raw) ? raw : {};
  return {
    id: id(p.id),
    timing: photoTiming(p.photo_timing),
    createdAt: reqStr(p.created_at),
    uploadedBy: reqStr(p.uploaded_by),
    hasThumb: p.has_thumb === true,
  };
}

// ---------------------------------------------------------------------------------------------------
// Audit (A1 normalisation of Jeffrey's legacy formats; see the AuditEvent doc in lib/api-types.ts)
// ---------------------------------------------------------------------------------------------------

const COLUMN_TO_FIELD: ReadonlyMap<string, EditableField> = new Map(
  (Object.entries(FIELD_COLUMNS) as Array<[EditableField, string]>).map(([field, column]) => [column, field]),
);
/** Editable columns in a stable display order. */
const EDITABLE_COLUMNS: readonly string[] = Object.values(FIELD_COLUMNS);
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['first_name', 'last_name'],
  ['reporting_location', 'other_location'],
];

/** An editable value: strings and numbers as they are; anything else (objects, booleans) → null. */
function fieldValue(v: unknown): string | number | null {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

/** Equal for display purposes: '' and null are the same, numbers compare by text. */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    const f = fieldValue(v);
    return f === null || f === '' ? null : String(f);
  };
  return norm(a) === norm(b);
}

const has = (o: Json, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * previous_value / new_value of a patient_updated event → the changed editable fields (camelCase).
 * Works for both formats:
 *   * new (lp_update_fields): both sides hold exactly the changed keys, and a merged display field
 *     (name, post) is recorded whole (A35) — passed through as pairs.
 *   * Jeffrey's: new_value is the patch (plus updated_by / updated_at), previous_value the full old row —
 *     only editable keys present in new_value whose value differs are kept. When half of a merged field
 *     changed, the other half is filled from the old row on both sides, so the pair is whole too.
 */
export function editChanges(previousValue: unknown, newValue: unknown): { previous: AuditFieldValues; next: AuditFieldValues } {
  const prev = isObject(previousValue) ? previousValue : {};
  const next = isObject(newValue) ? newValue : {};
  const changed = new Set(EDITABLE_COLUMNS.filter((c) => has(next, c) && !sameValue(prev[c], next[c])));
  const keep = new Set(changed);
  for (const [a, b] of PAIRS) {
    if (changed.has(a) || changed.has(b)) {
      keep.add(a);
      keep.add(b);
    }
  }
  const out = { previous: {} as AuditFieldValues, next: {} as AuditFieldValues };
  for (const column of EDITABLE_COLUMNS) {
    if (!keep.has(column)) continue;
    const field = COLUMN_TO_FIELD.get(column);
    if (!field) continue;
    const nextValue = has(next, column) ? fieldValue(next[column]) : fieldValue(prev[column]);
    const prevValue = has(prev, column) ? fieldValue(prev[column]) : changed.has(column) ? null : nextValue;
    out.previous[field] = prevValue;
    out.next[field] = nextValue;
  }
  return out;
}

function statusOf(v: unknown): string | null {
  return isObject(v) && typeof v.status === 'string' ? v.status : null;
}

function kindOf(v: unknown): StatusKind | null {
  const k = isObject(v) ? v.kind : null;
  return typeof k === 'string' && (STATUS_KINDS as readonly string[]).includes(k) ? (k as StatusKind) : null;
}

/** (F5) The "Not found yet" hold a status_changed side records ({recheck_at, not_found_checks}), or null. */
function holdOf(v: unknown): AuditHold | null {
  if (!isObject(v) || typeof v.recheck_at !== 'string' || v.recheck_at === '') return null;
  return { recheckAt: v.recheck_at, checks: reqNum(v.not_found_checks) };
}

/** One lp_detail event {id, action_type, staff_name, previous_value, new_value, notes, occurred_at} → AuditEvent. */
export function mapAudit(raw: unknown): AuditEvent {
  const e = isObject(raw) ? raw : {};
  const actionType = reqStr(e.action_type);
  const prev = e.previous_value;
  const next = e.new_value;
  const base = { id: id(e.id), at: reqStr(e.occurred_at), staff: reqStr(e.staff_name), notes: str(e.notes) };
  const other = (): AuditEvent => ({ ...base, action: 'other', previous: null, next: { actionType: actionType.slice(0, 60) } });

  switch (actionType) {
    case 'patient_created': {
      const n = isObject(next) ? next : {};
      return {
        ...base,
        action: 'created',
        previous: null,
        next: { reportingLocation: str(n.reporting_location), otherLocation: str(n.other_location) },
      };
    }
    case 'status_changed': {
      const to = statusOf(next);
      if (to === null) return other();
      // (F5) Hold details only when there are any, so every older event maps exactly as before.
      const before = holdOf(prev);
      const after = holdOf(next);
      const held = isObject(next) && next.held === true;
      return {
        ...base,
        action: 'status',
        previous: { status: statusOf(prev), ...(before ? { hold: before } : {}) },
        next: { status: to, kind: kindOf(next), ...(held ? { held } : {}), ...(after ? { hold: after } : {}) },
      };
    }
    case 'patient_updated': {
      const { previous, next: changedNext } = editChanges(prev, next);
      return { ...base, action: 'edit', previous, next: changedNext };
    }
    case 'photo_uploaded': {
      const n = isObject(next) ? next : {};
      const timing = n.photo_timing;
      return {
        ...base,
        action: 'photo',
        previous: null,
        next: {
          photoId: str(n.photo_id),
          timing: timing === 'today' || timing === 'older' || timing === 'unsure' ? timing : null,
        },
      };
    }
    case 'cancelled':
      return { ...base, action: 'cancelled', previous: { status: statusOf(prev) }, next: { status: STATUS.cancelled } };
    case 'medical_search': {
      const n = isObject(next) ? next : {};
      if (n.outcome !== 'not_found') return other();
      // Jeffrey's app kept the search notes in new_value.notes and showed them on the timeline.
      return {
        ...base,
        notes: base.notes ?? str(n.notes),
        action: 'legacy_search_not_found',
        previous: null,
        next: { status: STATUS.notInMedical },
      };
    }
    case 'medical_search_found':
      return { ...base, action: 'legacy_search_found', previous: null, next: { status: STATUS.inMedical } };
    case 'check_completed':
      return { ...base, action: 'legacy_check', previous: { status: statusOf(prev) }, next: { status: STATUS.notInMedical } };
    default:
      return other();
  }
}

/** lp_detail JSON {row, photos, events} → RequestDetail (photos and audit oldest first). */
export function mapDetail(raw: unknown): RequestDetail {
  const d = isObject(raw) ? raw : {};
  const photos = Array.isArray(d.photos) ? d.photos.map(mapPhoto) : [];
  const audit = Array.isArray(d.events) ? d.events.map(mapAudit) : [];
  return { ...mapRow(d.row), photos, audit };
}

/** lp_sync JSON → SyncResponse. serverTime / next.at are passed through VERBATIM (microseconds kept). */
export function mapSync(raw: unknown): SyncResponse {
  const s = isObject(raw) ? raw : {};
  const out: SyncResponse = {
    serverTime: reqStr(s.serverTime),
    rows: Array.isArray(s.rows) ? s.rows.map(mapRow) : [],
    hasMore: s.hasMore === true,
    next: isObject(s.next) ? { at: reqStr(s.next.at), id: id(s.next.id) } : null,
  };
  if (Array.isArray(s.versions)) {
    out.versions = s.versions
      .filter((v): v is [unknown, unknown] => Array.isArray(v) && v.length === 2)
      .map(([vid, version]) => [id(vid), reqNum(version)] as [string, number]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Request bodies → lp_* payloads
// ---------------------------------------------------------------------------------------------------

type FieldInput = Partial<Omit<CreateRequestInput, 'clientMutationId'>>;

/** camelCase editable fields → snake_case columns. `name` becomes first_name + last_name (both). */
function toColumns(input: FieldInput): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'name') {
      const { firstName, lastName } = splitName(value as string | null);
      out.first_name = firstName;
      out.last_name = lastName;
      continue;
    }
    const column = (FIELD_COLUMNS as Record<string, string>)[key];
    if (column && key !== 'firstName' && key !== 'lastName') out[column] = value;
  }
  return out;
}

/** createRequestSchema output → the `p` of lp_create_request. */
export function createPayload(input: CreateRequestInput): Json {
  const { clientMutationId, ...fields } = input;
  return { client_mutation_id: clientMutationId, ...toColumns(fields) };
}

/** requestPatchSchema output → the `p_patch` of lp_update_fields. */
export function patchPayload(patch: RequestPatchInput): Json {
  return toColumns(patch as FieldInput);
}

// zod schemas for every API body and query (spec §6). Shared by the server routes and the client form.
// FROZEN after Phase 1a: later phases may ADD schemas, never change existing ones.
//
// Text rules (spec §4): strings are trimmed; empty strings become null. In a PATCH an omitted key means
// "unchanged" and an explicit null means "clear". Lengths count Unicode code points, like SQL char_length.
// Age and gender are free text (Jeffrey, 2026-11-06 10:31; design/DECISIONS.md "New request: free text").
import { z } from 'zod';
import {
  LIMITS,
  OTHER_LOCATION_MIN,
  OTHER_POST,
  OTHER_TEAM,
  OTHER_TEAM_MAX,
  OTHER_TEAM_MIN,
  PHOTO_TIMINGS,
  POST_VALUES,
  SETTABLE_STATUSES,
  STAFF_FORBIDDEN_CHARS,
  STAFF_NAME_MAX,
  STAFF_NAME_MIN,
  STATUS,
  STATUS_KINDS,
  TEAM_VALUES,
  canonicalTeam,
} from './domain';

const codePoints = (s: string) => Array.from(s).length;

// PostgreSQL text and jsonb cannot hold NUL (22P05) or an unpaired UTF-16 surrogate (22P02), so every text
// that reaches the database is checked here and refused with a fixable 422 instead of failing as a 503.
// (No lookbehind: older Safari lacks it.)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const storable = (s: string) => !s.includes('\u0000') && !LONE_SURROGATE.test(s);
const UNSTORABLE = 'Contains a character that cannot be saved';

/** Optional free text: trimmed, '' → null, at most `max` code points, no NUL or unpaired surrogate. */
export function optionalText(max: number) {
  return z
    .union([z.string(), z.null()])
    .transform((v) => (v === null ? null : v.trim() === '' ? null : v.trim()))
    .refine((v) => v === null || codePoints(v) <= max, { message: `Must be ${max} characters or fewer` })
    .refine((v) => v === null || storable(v), { message: UNSTORABLE });
}

/** The single Name field: whitespace collapsed (the server splits it at the last space). */
const nameField = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null ? null : v.trim().replace(/\s+/g, ' ') || null))
  .refine((v) => v === null || codePoints(v) <= LIMITS.name, { message: `Must be ${LIMITS.name} characters or fewer` })
  .refine((v) => v === null || storable(v), { message: UNSTORABLE });

/**
 * Age as people say it: free text ("24", "mid-20s"), trimmed, '' → null, at most LIMITS.age (Jeffrey,
 * 2026-11-06). A number is still accepted and kept as its text (24 → "24"), so a request queued on a phone
 * by an older client still sends.
 */
const ageField = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .pipe(optionalText(LIMITS.age));

/** Free text (trimmed, '' → null, at most LIMITS.gender); Male / Female / Other are quick-fill options. */
const genderField = optionalText(LIMITS.gender);

const postField = z.enum(POST_VALUES);
const otherLocationField = optionalText(LIMITS.otherLocation);

export const uuidSchema = z.uuid();
export const expectedVersionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Editable fields shared by create and patch (all optional at this level). */
const fieldShape = {
  name: nameField.optional(),
  age: ageField.optional(),
  gender: genderField.optional(),
  clothing: optionalText(LIMITS.clothing).optional(),
  lastSeen: optionalText(LIMITS.lastSeen).optional(),
  hair: optionalText(LIMITS.hair).optional(),
  heightBuild: optionalText(LIMITS.heightBuild).optional(),
  identifyingFeatures: optionalText(LIMITS.identifyingFeatures).optional(),
  physicalDescription: optionalText(LIMITS.physicalDescription).optional(),
  additionalNotes: optionalText(LIMITS.additionalNotes).optional(),
  contactName: optionalText(LIMITS.contactName).optional(),
  contactPhone: optionalText(LIMITS.contactPhone).optional(),
  contactRelationship: optionalText(LIMITS.contactRelationship).optional(),
  contactNotes: optionalText(LIMITS.contactNotes).optional(),
  otherLocation: otherLocationField.optional(),
};

type PostFields = { reportingLocation?: string | undefined; otherLocation?: string | null | undefined };

const otherLocationTooShort = (v: PostFields, ctx: z.RefinementCtx) => {
  if (v.otherLocation && codePoints(v.otherLocation) < OTHER_LOCATION_MIN) {
    ctx.addIssue({ code: 'custom', path: ['otherLocation'], message: 'Say where (Other post)' });
  }
};

/** Create: there is no existing row, so Other always needs its location in the body. */
const otherNeedsLocation = (v: PostFields, ctx: z.RefinementCtx) => {
  if (v.reportingLocation === OTHER_POST && (v.otherLocation === undefined || v.otherLocation === null)) {
    ctx.addIssue({ code: 'custom', path: ['otherLocation'], message: 'Say where (Other post)' });
  }
  otherLocationTooShort(v, ctx);
};

/**
 * Patch: an omitted otherLocation means "unchanged", so `{reportingLocation: 'Other'}` alone is valid here
 * and the merged row is checked by lp_update_fields (P0422 field:other_location when the row has none).
 * Only an explicit clear (null, or '' which becomes null) together with Other is rejected up front.
 */
const patchOtherNeedsLocation = (v: PostFields, ctx: z.RefinementCtx) => {
  if (v.reportingLocation === OTHER_POST && v.otherLocation === null) {
    ctx.addIssue({ code: 'custom', path: ['otherLocation'], message: 'Say where (Other post)' });
  }
  otherLocationTooShort(v, ctx);
};

/**
 * POST /api/requests. Omitted fields are stored as null. A post that is not Other never keeps an
 * other location (it is dropped).
 */
export const createRequestSchema = z
  .strictObject({
    clientMutationId: uuidSchema,
    reportingLocation: postField,
    ...fieldShape,
  })
  .superRefine(otherNeedsLocation)
  .transform((v) => (v.reportingLocation === OTHER_POST ? v : { ...v, otherLocation: null }));

export type CreateRequestBody = z.input<typeof createRequestSchema>;
export type CreateRequestInput = z.output<typeof createRequestSchema>;

/**
 * Where medical has the patient ("Chair 14", "Bed 3 · triage"): free text, trimmed, '' → null, at most
 * LIMITS.medicalLocation (Dani + Brian, 2026-11-06 afternoon). Edit only: a new request has none yet.
 */
export const medicalLocationField = optionalText(LIMITS.medicalLocation);

/**
 * The `patch` of PATCH /api/requests/:id: only the keys being changed; at least one. Omitted = unchanged,
 * null = clear. The "Other needs a location" rule applies to the MERGED row (lp_update_fields); here only
 * an explicit clear of otherLocation with reportingLocation 'Other' is rejected. `medicalLocation` is
 * accepted here only (never on create).
 */
export const requestPatchSchema = z
  .strictObject({
    reportingLocation: postField.optional(),
    ...fieldShape,
    medicalLocation: medicalLocationField.optional(),
  })
  .superRefine(patchOtherNeedsLocation)
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export type RequestPatch = z.input<typeof requestPatchSchema>;
export type RequestPatchInput = z.output<typeof requestPatchSchema>;

/** PATCH /api/requests/:id */
export const updateRequestSchema = z.strictObject({
  patch: requestPatchSchema,
  expectedVersion: expectedVersionSchema,
});
export type UpdateRequestBody = z.input<typeof updateRequestSchema>;

/** POST /api/requests/:id/status (Cancelled only through /cancel). */
export const setStatusSchema = z.strictObject({
  status: z.enum(SETTABLE_STATUSES),
  expectedVersion: expectedVersionSchema,
  kind: z.enum(STATUS_KINDS),
});
export type SetStatusBody = z.input<typeof setStatusSchema>;

/** POST /api/requests/:id/cancel */
export const cancelSchema = z.strictObject({ expectedVersion: expectedVersionSchema });
export type CancelBody = z.input<typeof cancelSchema>;

const staffText = (min: number, max: number, label: string) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .refine((v) => codePoints(v) >= min && codePoints(v) <= max, { message: `${label}: ${min}–${max} characters` })
    .refine((v) => !STAFF_FORBIDDEN_CHARS.test(v), { message: `${label}: remove the "·" character` })
    .refine(storable, { message: `${label}: ${UNSTORABLE.toLowerCase()}` });

/**
 * POST /api/session. `team` is a card value or "Other" with `otherTeam` (2–80 characters).
 * Output: {staffName, team, password}. `team` is always canonical (spec §4 "Data stores the canonical
 * value"): a card value as is, and the Other text through domain.canonicalTeam(), so a known alias typed
 * there ("dispatch", "gchx base", "prevent") becomes its canonical team; anything else stays as typed
 * (whitespace collapsed).
 */
export const signInSchema = z
  .strictObject({
    staffName: staffText(STAFF_NAME_MIN, STAFF_NAME_MAX, 'Name'),
    team: z.union([z.enum(TEAM_VALUES), z.literal(OTHER_TEAM)]),
    otherTeam: z.union([staffText(OTHER_TEAM_MIN, OTHER_TEAM_MAX, 'Team'), z.literal(''), z.null()]).optional(),
    password: z.string().min(1).max(200),
  })
  .superRefine((v, ctx) => {
    if (v.team === OTHER_TEAM && !v.otherTeam) {
      ctx.addIssue({ code: 'custom', path: ['otherTeam'], message: 'Enter your team' });
    }
  })
  .transform((v) => ({
    staffName: v.staffName,
    team: v.team === OTHER_TEAM ? canonicalTeam(v.otherTeam as string) : v.team,
    password: v.password,
  }));
export type SignInBody = z.input<typeof signInSchema>;
export type SignInInput = z.output<typeof signInSchema>;

/** A database timestamp cursor (any sub-second precision, with offset). */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * A sync cursor read from a query string (`since`, `afterAt`). Every cursor the database returns carries a
 * '+' offset ("…04.123456+00:00"). A client that interpolates it into the URL without encoding sends a raw
 * '+', which URLSearchParams decodes as a space ("…04.123456 00:00"). That form is restored to '+' here, so
 * such a poll still works instead of failing with 400 on every delta. Clients should still encode cursors
 * (lib/client/api-paths.ts syncPath()). The result must then be a valid isoDateTimeSchema value.
 */
export const syncCursorSchema = z
  .string()
  .transform((s) => s.replace(/ (\d{2}:?\d{2})$/, '+$1'))
  .pipe(isoDateTimeSchema);

/**
 * GET /api/sync query. Either `ids` (≤200, comma-separated) alone, or `since` (absent = full fetch) with
 * optional `reconcile`, and `afterAt` + `afterId` together for the next page. `since` and `afterAt` go
 * through syncCursorSchema (an unencoded '+' that arrived as a space is restored).
 */
export const syncQuerySchema = z
  .strictObject({
    since: syncCursorSchema.optional(),
    reconcile: z.enum(['0', '1']).optional(),
    afterAt: syncCursorSchema.optional(),
    afterId: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    ids: z
      .string()
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(uuidSchema).min(1).max(200))
      .optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.afterAt === undefined) !== (v.afterId === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['afterAt'], message: 'afterAt and afterId go together' });
    }
    if (v.ids && (v.since || v.reconcile || v.afterAt || v.afterId || v.limit)) {
      ctx.addIssue({ code: 'custom', path: ['ids'], message: 'ids cannot be combined with other parameters' });
    }
  });
export type SyncQuery = z.output<typeof syncQuerySchema>;

/** Multipart text fields of POST /api/requests/:id/photos (the files are checked separately). */
export const photoFieldsSchema = z.strictObject({
  photoId: uuidSchema,
  timing: z.enum(PHOTO_TIMINGS),
});
export type PhotoFields = z.output<typeof photoFieldsSchema>;

/** GET /api/photos/:id?size=thumb|full */
export const photoQuerySchema = z.strictObject({
  size: z.enum(['thumb', 'full']).default('full'),
});

/** Route params `:id`. */
export const idParamsSchema = z.strictObject({ id: uuidSchema });

/** Statuses accepted in the `status=` navigation filter (any database value, including legacy). */
export const statusFilterSchema = z.enum([
  STATUS.waiting,
  STATUS.notInMedical,
  STATUS.inMedical,
  STATUS.reunited,
  STATUS.discharged,
  STATUS.cancelled,
  STATUS.legacyBringFriend,
]);

/** Converts a URLSearchParams to a plain object for the query schemas (repeated keys: last wins). */
export function searchParamsToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

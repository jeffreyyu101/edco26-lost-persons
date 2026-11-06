// zod schemas for every API body and query (spec §6). Shared by the server routes and the client form.
// FROZEN after Phase 1a: later phases may ADD schemas, never change existing ones.
//
// Text rules (spec §4): strings are trimmed; empty strings become null. In a PATCH an omitted key means
// "unchanged" and an explicit null means "clear". Lengths count Unicode code points, like SQL char_length.
import { z } from 'zod';
import {
  AGE_MAX,
  AGE_MIN,
  GENDERS,
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
} from './domain';

const codePoints = (s: string) => Array.from(s).length;

/** Optional free text: trimmed, '' → null, at most `max` code points. */
export function optionalText(max: number) {
  return z
    .union([z.string(), z.null()])
    .transform((v) => (v === null ? null : v.trim() === '' ? null : v.trim()))
    .refine((v) => v === null || codePoints(v) <= max, { message: `Must be ${max} characters or fewer` });
}

/** The single Name field: whitespace collapsed (the server splits it at the last space). */
const nameField = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null ? null : v.trim().replace(/\s+/g, ' ') || null))
  .refine((v) => v === null || codePoints(v) <= LIMITS.name, { message: `Must be ${LIMITS.name} characters or fewer` });

const ageField = z.union([z.number().int().min(AGE_MIN).max(AGE_MAX), z.null()]);

const genderField = z
  .union([z.enum(GENDERS), z.literal(''), z.null()])
  .transform((v) => (v === '' ? null : v));

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

const otherNeedsLocation = (
  v: { reportingLocation?: string | undefined; otherLocation?: string | null | undefined },
  ctx: z.RefinementCtx,
) => {
  if (v.reportingLocation === OTHER_POST && (v.otherLocation === undefined || v.otherLocation === null)) {
    ctx.addIssue({ code: 'custom', path: ['otherLocation'], message: 'Say where (Other post)' });
  }
  if (v.otherLocation && codePoints(v.otherLocation) < OTHER_LOCATION_MIN) {
    ctx.addIssue({ code: 'custom', path: ['otherLocation'], message: 'Say where (Other post)' });
  }
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

/** The `patch` of PATCH /api/requests/:id: only the keys being changed; at least one. */
export const requestPatchSchema = z
  .strictObject({
    reportingLocation: postField.optional(),
    ...fieldShape,
  })
  .superRefine(otherNeedsLocation)
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
    .refine((v) => !STAFF_FORBIDDEN_CHARS.test(v), { message: `${label}: remove the "·" character` });

/**
 * POST /api/session. `team` is a card value or "Other" with `otherTeam` (2–80 characters).
 * Output: {staffName, team (resolved: canonical value or the custom text), password}.
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
    team: v.team === OTHER_TEAM ? (v.otherTeam as string) : v.team,
    password: v.password,
  }));
export type SignInBody = z.input<typeof signInSchema>;
export type SignInInput = z.output<typeof signInSchema>;

/** A database timestamp cursor (any sub-second precision, with offset). */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * GET /api/sync query. Either `ids` (≤200, comma-separated) alone, or `since` (absent = full fetch) with
 * optional `reconcile`, and `afterAt` + `afterId` together for the next page.
 */
export const syncQuerySchema = z
  .strictObject({
    since: isoDateTimeSchema.optional(),
    reconcile: z.enum(['0', '1']).optional(),
    afterAt: isoDateTimeSchema.optional(),
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

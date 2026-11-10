// zod schemas for every API body and query (spec §6). Shared by the server routes and the client form.
// FROZEN after Phase 1a: later phases may ADD schemas, never change existing ones.
//
// Text rules (spec §4): strings are trimmed; empty strings become null. In a PATCH an omitted key means
// "unchanged" and an explicit null means "clear". Lengths count Unicode code points, like SQL char_length.
// Age and gender are free text (Jeffrey, 2026-11-06 10:31; design/DECISIONS.md "New request: free text").
import { z } from 'zod';
import {
  FRIEND_IN_MEDICAL,
  LIMITS,
  OTHER_LOCATION_MIN,
  OTHER_POST,
  OTHER_TEAM,
  OTHER_TEAM_MAX,
  OTHER_TEAM_MIN,
  PHOTO_TIMINGS,
  SETTABLE_STATUSES,
  STAFF_FORBIDDEN_CHARS,
  SWAP_PLACES,
  STAFF_NAME_MAX,
  STAFF_NAME_MIN,
  STATUS,
  STATUS_KINDS,
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

// (Events) Which posts are valid is the event's (lp_clean_fields(p_event, …) refuses anything else with 422
// field reportingLocation); here only its shape.
const postField = z.string().min(1).max(40).refine((v) => v === v.trim() && v !== '', { message: 'Choose a post' });
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
  /** (Companion) "Is a friend already with them in medical?" (default unsure) and, when yes, an optional name. */
  friendInMedical: z.enum(FRIEND_IN_MEDICAL).optional(),
  friendInMedicalName: optionalText(LIMITS.friendInMedicalName).optional(),
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

/**
 * (Companion) POST /api/requests/:id/swap: request a friend swap, approve it at the request's tent ('fa') or Main
 * Med ('mm'), decline it, or withdraw it (the requester's Undo: nobody is told).
 */
export const swapSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('request'), expectedVersion: expectedVersionSchema }),
  z.strictObject({ action: z.literal('approve'), place: z.enum(SWAP_PLACES), expectedVersion: expectedVersionSchema }),
  z.strictObject({ action: z.literal('decline'), expectedVersion: expectedVersionSchema }),
  z.strictObject({ action: z.literal('withdraw'), expectedVersion: expectedVersionSchema }),
  z.strictObject({ action: z.literal('cancel'), expectedVersion: expectedVersionSchema }),
  // (Post-event) The Undo of the caller's own Cancel swap / Decline / Swap at … (lp_swap 'restore').
  z.strictObject({ action: z.literal('restore'), expectedVersion: expectedVersionSchema }),
]);
export type SwapBody = z.input<typeof swapSchema>;

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

/** What POST /api/session signs in with: the event password, or the team join link's code (J1). */
export type SignInCredential = { password: string } | { invite: string };

/**
 * POST /api/session. `team` is a card value or "Other" with `otherTeam` (2–80 characters), and exactly one
 * of `password` (the event password) or `invite` (the team join link's code, J1).
 * Output: {staffName, team, password} or {staffName, team, invite}. `team`: a card value as is, the Other text as
 * typed (whitespace collapsed). (Events) The route then spells it as the matched event does when it is one of that
 * event's teams (by label, case-insensitive); anything else stays Other text.
 */
export const signInSchema = z
  .strictObject({
    staffName: staffText(STAFF_NAME_MIN, STAFF_NAME_MAX, 'Name'),
    // (Events) A team is one of the event's sign-in teams (checked by the route once it knows the event) or "Other"
    // with free text; the card values are no longer a fixed list here.
    team: z.union([z.literal(OTHER_TEAM), staffText(OTHER_TEAM_MIN, OTHER_TEAM_MAX, 'Team')]),
    otherTeam: z.union([staffText(OTHER_TEAM_MIN, OTHER_TEAM_MAX, 'Team'), z.literal(''), z.null()]).optional(),
    password: z.string().min(1).max(200).optional(),
    invite: z.string().min(1).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.team === OTHER_TEAM && !v.otherTeam) {
      ctx.addIssue({ code: 'custom', path: ['otherTeam'], message: 'Enter your team' });
    }
    if (v.password === undefined && v.invite === undefined) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'Enter the event password' });
    } else if (v.password !== undefined && v.invite !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['invite'], message: 'Send the password or the team link, not both' });
    }
  })
  .transform((v): { staffName: string; team: string } & SignInCredential => {
    const identity = { staffName: v.staffName, team: v.team === OTHER_TEAM ? canonicalTeam(v.otherTeam as string) : v.team };
    return v.invite !== undefined ? { ...identity, invite: v.invite } : { ...identity, password: v.password as string };
  });
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
    /**
     * (Events) The event config version the client holds (sync's `event.version`, verbatim; '' when it has none). With
     * it, the answer carries `event` whenever the event's version differs; without it (an older client) never, so an
     * empty delta stays about 100 bytes.
     */
    ev: z.string().max(64).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.afterAt === undefined) !== (v.afterId === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['afterAt'], message: 'afterAt and afterId go together' });
    }
    if (v.ids && (v.since || v.reconcile || v.afterAt || v.afterId || v.limit || v.ev !== undefined)) {
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

// ---------------------------------------------------------------------------------------------------
// Web Push and Activity (F4, spec §18 A54–A57)
// ---------------------------------------------------------------------------------------------------

const base64Url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, { message: 'Must be base64url' });

/** A push endpoint: https, at most 1024 characters (which push services are allowed is the server's call). */
export const pushEndpointField = z
  .string()
  .max(1024)
  .refine((s) => s.startsWith('https://'), { message: 'Must be an https URL' })
  .pipe(z.url({ protocol: /^https$/ }));

/** POST /api/push/subscribe: this device's PushSubscription (its toJSON()), and the endpoint it replaces. */
export const pushSubscribeSchema = z.strictObject({
  endpoint: pushEndpointField,
  keys: z.strictObject({ p256dh: base64Url(16, 200), auth: base64Url(8, 100) }),
  oldEndpoint: pushEndpointField.nullable().optional(),
  /** The phone's old "Alerts" bell: the default for New requests when the staff member has no switches yet. */
  bell: z.boolean().optional(),
});
export type PushSubscribeBody = z.input<typeof pushSubscribeSchema>;

/** DELETE /api/push/subscribe and POST /api/push/test. */
export const pushEndpointSchema = z.strictObject({ endpoint: pushEndpointField });

/** POST /api/push/prefs: change a switch (or none: read them, created with the defaults on first use). */
export const pushPrefsSchema = z.strictObject({
  newRequests: z.boolean().optional(),
  myUpdates: z.boolean().optional(),
  bell: z.boolean().optional(),
});
export type PushPrefsBody = z.input<typeof pushPrefsSchema>;

/** POST /api/activity/read: one request (it was opened), or Mark all read. */
export const activityReadSchema = z.union([z.strictObject({ requestId: uuidSchema }), z.strictObject({ all: z.literal(true) })]);
export type ActivityReadBody = z.input<typeof activityReadSchema>;

/** POST /api/activity/unread: Undo of Mark all read. */
export const activityUnreadSchema = z.strictObject({ requestIds: z.array(uuidSchema).min(1).max(100) });
export type ActivityUnreadBody = z.input<typeof activityUnreadSchema>;

/** Converts a URLSearchParams to a plain object for the query schemas (repeated keys: last wins). */
export function searchParamsToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Messages and en route (F3, spec §18 A53–A58)
// ---------------------------------------------------------------------------------------------------

/** A message body: trimmed, 1–500 code points, storable. Plain text (never rendered as HTML). */
export const messageBodySchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, { message: 'Type a message' })
  .refine((v) => codePoints(v) <= 500, { message: 'Must be 500 characters or fewer' })
  .refine((v) => storable(v), { message: UNSTORABLE });

/** POST /api/requests/:id/messages. `clientMutationId` makes a retried send land once. */
export const postMessageSchema = z.strictObject({
  clientMutationId: uuidSchema,
  body: messageBodySchema,
});
export type PostMessageBody = z.input<typeof postMessageSchema>;

/** POST /api/requests/:id/messages/read: up to the newest message on screen (absent = everything until now). */
export const markReadSchema = z.strictObject({
  upto: isoDateTimeSchema.optional(),
});

/** GET /api/requests/:id/messages: `beforeAt` + `beforeId` together page back ("Earlier messages"). */
export const threadQuerySchema = z
  .strictObject({
    beforeAt: syncCursorSchema.optional(),
    beforeId: uuidSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.beforeAt === undefined) !== (v.beforeId === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['beforeAt'], message: 'beforeAt and beforeId go together' });
    }
  });

/** Route params `:id` + `:messageId`. */
export const messageParamsSchema = z.strictObject({ id: uuidSchema, messageId: uuidSchema });

/**
 * POST /api/requests/:id/enroute.
 *   set:    etaMinutes 0 (Now) / 5 / 10 / 15 or null (no ETA), or etaAt (the exact ETA back, the Undo of a
 *           cancel). `queuedMs`: how long ago the tap was (a queued tap keeps its ETA), 0–6 h.
 *   cancel / arrive: nothing else.
 */
export const enrouteSchema = z
  .strictObject({
    action: z.enum(['set', 'cancel', 'arrive']),
    etaMinutes: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.null()]).optional(),
    etaAt: isoDateTimeSchema.nullable().optional(),
    queuedMs: z.number().int().min(0).max(6 * 3_600_000).optional(),
  })
  .superRefine((v, ctx) => {
    const hasEta = (v.etaMinutes !== undefined && v.etaMinutes !== null) || (v.etaAt !== undefined && v.etaAt !== null);
    if (v.action !== 'set' && hasEta) {
      ctx.addIssue({ code: 'custom', path: ['etaMinutes'], message: 'Only en route takes an ETA' });
    }
  });
export type EnrouteBody = z.input<typeof enrouteSchema>;

// ---------------------------------------------------------------------------------------------------
// (Events) Lead routes: event settings, staff password, join link, lead passcode
// ---------------------------------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD' }).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), { message: 'Not a date' });
const listId = z.string().regex(/^[a-z0-9_-]{1,24}$/);
const listLabel = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .refine((v) => v.length >= 1 && v.length <= max, { message: `1–${max} characters` })
    .refine((v) => v.toLowerCase() !== 'other', { message: '"Other" is always there' })
    .refine(storable, { message: UNSTORABLE });

/** "FA 3 – Kinetic" → "fa-3-kinetic" (an id for a post or team that came without one). */
export function listIdFrom(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'item';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`.slice(0, 24);
  return id;
}

function withIds<T extends { id?: string; label: string }>(items: T[]): Array<T & { id: string }> {
  const taken = new Set<string>(items.flatMap((i) => (i.id ? [i.id] : [])));
  return items.map((i) => {
    if (i.id) return i as T & { id: string };
    const id = listIdFrom(i.label, taken);
    taken.add(id);
    return { ...i, id };
  });
}

const uniqueBy = <T>(items: T[], key: (t: T) => string) => new Set(items.map(key)).size === items.length;

export const eventPostsSchema = z
  .array(z.strictObject({ id: listId.optional(), label: listLabel(40), short: z.string().trim().min(1).max(16).optional() }))
  .max(12)
  .transform((items) => withIds(items).map((p) => ({ id: p.id, label: p.label, short: p.short ?? p.label })))
  .refine((items) => uniqueBy(items, (p) => p.label.toLowerCase()) && uniqueBy(items, (p) => p.id), { message: 'Each post once' });

export const eventTeamsSchema = z
  .array(
    z.strictObject({
      id: listId.optional(),
      label: listLabel(80).refine((v) => v.length >= 2 && !STAFF_FORBIDDEN_CHARS.test(v), { message: 'Team: 2–80 characters, no "·"' }),
      short: z.string().trim().min(1).max(24).optional(),
      medical: z.boolean().optional(),
    }),
  )
  .max(12)
  .transform((items) => withIds(items).map((t) => ({ id: t.id, label: t.label, short: t.short ?? t.label, medical: t.medical === true })))
  .refine((items) => uniqueBy(items, (t) => t.label.toLowerCase()) && uniqueBy(items, (t) => t.id), { message: 'Each team once' })
  .refine((items) => items.filter((t) => t.medical).length <= 1, { message: 'Only one medical team' });

const eventFields = {
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, { message: '2–40 lowercase letters, digits or dashes' }),
  name: z.string().transform((v) => v.trim().replace(/\s+/g, ' ')).refine((v) => v.length >= 1 && v.length <= 80, { message: '1–80 characters' }).refine(storable, { message: UNSTORABLE }),
  startsOn: isoDate,
  endsOn: isoDate,
  timezone: z.string().min(1).max(64).refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, { message: 'Not a time zone' }),
  dayStartHour: z.number().int().min(0).max(23),
  posts: eventPostsSchema,
  mainMedical: z.string().transform((v) => v.trim()).refine((v) => v.length >= 1 && v.length <= 40, { message: '1–40 characters' }),
  teams: eventTeamsSchema,
  lastSeen: z.array(z.string().transform((v) => v.trim()).refine((v) => v.length >= 1 && v.length <= 40)).max(12),
};

const datesInOrder = (v: { startsOn?: string; endsOn?: string }) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn;

/** POST /api/events: slug, name and dates are required; the rest has defaults (America/New_York, 06:00, Main Med). */
export const eventCreateSchema = z
  .strictObject({
    slug: eventFields.slug,
    name: eventFields.name,
    startsOn: eventFields.startsOn,
    endsOn: eventFields.endsOn,
    timezone: eventFields.timezone.optional(),
    dayStartHour: eventFields.dayStartHour.optional(),
    posts: eventFields.posts.optional(),
    mainMedical: eventFields.mainMedical.optional(),
    teams: eventFields.teams.optional(),
    lastSeen: eventFields.lastSeen.optional(),
  })
  .refine(datesInOrder, { message: 'The last day is before the first', path: ['endsOn'] });

/** PATCH /api/events/:id: any of the settings. */
export const eventPatchSchema = z
  .strictObject({
    slug: eventFields.slug.optional(),
    name: eventFields.name.optional(),
    startsOn: eventFields.startsOn.optional(),
    endsOn: eventFields.endsOn.optional(),
    timezone: eventFields.timezone.optional(),
    dayStartHour: eventFields.dayStartHour.optional(),
    posts: eventFields.posts.optional(),
    mainMedical: eventFields.mainMedical.optional(),
    teams: eventFields.teams.optional(),
    lastSeen: eventFields.lastSeen.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' })
  .refine(datesInOrder, { message: 'The last day is before the first', path: ['endsOn'] });

export type EventSettingsInput = z.output<typeof eventPatchSchema>;

/** A staff password or the lead passcode: 8–200 characters. */
export const secretSchema = z.string().min(8, { message: 'At least 8 characters' }).max(200);
export const eventPasswordSchema = z.strictObject({ password: secretSchema });
export const leadPasscodeSchema = z.strictObject({ passcode: secretSchema });
/** POST /api/events/:id/join-link: an optional expiry (default: two days after the last show day). */
export const joinLinkSchema = z.strictObject({ expiresAt: z.iso.datetime({ offset: true }).optional() });
/** POST /api/session/event: a lead opens an event (null: back to the Events list). */
export const openEventSchema = z.strictObject({ eventId: z.uuid().nullable() });

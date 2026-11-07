// The single source of domain truth (spec §4, v2.1 A3/A4). Pure and isomorphic: no I/O, no React.
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones.
//
// Things that must stay identical to SQL in supabase/migrations/20261106000000_rework.sql (unit tests
// compare them): TRANSITIONS (lp_set_status), TEAM_ALIASES + canonStaff (lp_canon_staff), postShort
// (lp_stats), the field limits (lp_clean_fields), RECHECK_MINUTES (lp_stages_recheck_minutes).

import { formatClockAmPm } from './format';

/** RFC 9562 UUID (versions 1–8, variant 10xx), like Jeffrey's isUuid. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------------

/** Database status values. The database values never change; only the UI labels are new. */
export const STATUS = {
  waiting: 'Added',
  notInMedical: 'Checked – Not Found',
  inMedical: 'Found – Awaiting Reunion',
  reunited: 'Reunited – Closed',
  discharged: 'Found – Discharged',
  cancelled: 'Cancelled',
  /** Legacy: never written by this app. Treated like In medical everywhere in the UI and in stats. */
  legacyBringFriend: 'Bring friend to medical',
} as const;

/** Every value the status CHECK allows, in the constraint's order. */
export const STATUSES = [
  STATUS.waiting,
  STATUS.notInMedical,
  STATUS.inMedical,
  STATUS.reunited,
  STATUS.discharged,
  STATUS.legacyBringFriend,
  STATUS.cancelled,
] as const;

export type Status = (typeof STATUSES)[number];

/** A status read from the database: a known Status, or an older legacy value (e.g. 'Found – Transported'). */
export type StatusValue = Status | (string & {});

/** Statuses this app may write through lp_set_status (Cancelled only through cancel). */
export const SETTABLE_STATUSES = [
  STATUS.waiting,
  STATUS.notInMedical,
  STATUS.inMedical,
  STATUS.reunited,
  STATUS.discharged,
] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

/**
 * v2.1 A3. Dimming and Reopen apply to `closed` only. v2.2 (Jeffrey, 2026-11-06 09:11): Not found in medical (then
 * "Not in medical") counts as closed and is greyed out, so there is no separate `answered` bucket any more.
 */
export type StatusBucket = 'open' | 'closed';

/** Radix colour name used for the status label text and the status block background. */
export type StatusTone = 'blue' | 'amber' | 'green' | 'gray';

/** Which status glyph to draw (components/ui/StatusGlyph ports the mockup SVG for each). */
export type GlyphKind =
  | 'waiting' // empty ring, blue
  | 'notInMedical' // filled circle with ×, grey (closed, v2.2)
  | 'inMedical' // ring with a ¾ pie, green
  | 'closed' // filled check, grey
  | 'queued' // dashed ring, grey (outbox item, not sent yet)
  | 'logged'; // empty ring, gray-10 (audit trail "Logged")

export interface StatusMeta {
  /** Full UI label, e.g. "In medical · friend coming". */
  label: string;
  /** Short label for compact places (audit "from → to", alerts), e.g. "In medical". */
  shortLabel: string;
  /**
   * An even shorter label for the log's status cell on a narrow phone (under 400 px), where the short one
   * would take the name's room: "Waiting", "Not found" (the glyph says the rest). Absent: the short label
   * fits everywhere. The row's sentence always says the full status.
   */
  narrowLabel?: string;
  tone: StatusTone;
  glyph: GlyphKind;
  bucket: StatusBucket;
}

/**
 * The answer buttons (the Pending cards, the profile, the Change answer menu): "Not found" and "In medical"
 * (Brian, 2026-11-06 18:00). The status itself reads "Not found in medical" (STATUS_META); the database value
 * stays 'Checked – Not Found'.
 */
export const ANSWER_LABEL = {
  notFound: 'Not found',
  inMedical: 'In medical',
} as const;

export const STATUS_META: Readonly<Record<Status, StatusMeta>> = {
  [STATUS.waiting]: { label: 'Waiting for check', shortLabel: 'Waiting for check', narrowLabel: 'Waiting', tone: 'blue', glyph: 'waiting', bucket: 'open' },
  [STATUS.notInMedical]: {
    label: 'Not found in medical',
    shortLabel: 'Not found in medical',
    narrowLabel: ANSWER_LABEL.notFound,
    tone: 'gray',
    glyph: 'notInMedical',
    bucket: 'closed',
  },
  [STATUS.inMedical]: { label: 'In medical · friend coming', shortLabel: 'In medical', tone: 'green', glyph: 'inMedical', bucket: 'open' },
  [STATUS.reunited]: { label: 'Reunited', shortLabel: 'Reunited', tone: 'gray', glyph: 'closed', bucket: 'closed' },
  [STATUS.discharged]: { label: 'Discharged', shortLabel: 'Discharged', tone: 'gray', glyph: 'closed', bucket: 'closed' },
  [STATUS.cancelled]: { label: 'Cancelled', shortLabel: 'Cancelled', tone: 'gray', glyph: 'closed', bucket: 'closed' },
  [STATUS.legacyBringFriend]: { label: 'In medical · friend coming', shortLabel: 'In medical', tone: 'green', glyph: 'inMedical', bucket: 'open' },
};

/**
 * Metadata for any status value. An unknown legacy value is shown verbatim, grey, as closed, with no
 * actions (the database rejects every transition from it).
 */
export function statusMeta(status: string): StatusMeta {
  if (isStatus(status)) return STATUS_META[status];
  return { label: status, shortLabel: status, tone: 'gray', glyph: 'closed', bucket: 'closed' };
}

export function statusBucket(status: string): StatusBucket {
  return statusMeta(status).bucket;
}

/** In medical, including the legacy 'Bring friend to medical'. */
export function isInMedical(status: string): boolean {
  return status === STATUS.inMedical || status === STATUS.legacyBringFriend;
}

/** CSS colour for a glyph or bar in a given tone (Radix step 9). */
export function toneColorVar(tone: StatusTone): string {
  return `var(--${tone}-9)`;
}

// ---------------------------------------------------------------------------------------------------
// Transitions (enforced by lp_set_status; the client only offers what makes sense now)
// ---------------------------------------------------------------------------------------------------

/** Labels for audit entries: answer, change, reunite, discharge, undo, reopen. */
export const STATUS_KINDS = ['answer', 'change', 'reunite', 'discharge', 'undo', 'reopen'] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

/** Allowed status → status moves through lp_set_status. MUST match the SQL CASE (unit-tested). */
export const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  [STATUS.waiting]: [STATUS.notInMedical, STATUS.inMedical],
  [STATUS.notInMedical]: [STATUS.inMedical, STATUS.waiting],
  [STATUS.inMedical]: [STATUS.reunited, STATUS.notInMedical, STATUS.discharged, STATUS.waiting],
  [STATUS.reunited]: [STATUS.inMedical],
  [STATUS.discharged]: [STATUS.inMedical],
  [STATUS.cancelled]: [STATUS.waiting],
  [STATUS.legacyBringFriend]: [STATUS.reunited, STATUS.discharged, STATUS.notInMedical],
};

export function canTransition(from: string, to: string): boolean {
  return isStatus(from) && isStatus(to) && TRANSITIONS[from].includes(to);
}

/** Cancelled → Added (Reopen or Undo of a cancel) is creator-only, like cancel itself. */
export function isCreatorOnlyTransition(from: string, to: string): boolean {
  return from === STATUS.cancelled && to === STATUS.waiting;
}

/** The status an Undo sends the request back to (never back to the legacy Bring-friend value). */
export function undoTarget(previous: string): Status | null {
  if (previous === STATUS.legacyBringFriend) return STATUS.inMedical;
  return isStatus(previous) ? previous : null;
}

export type StatusActionId =
  | 'notInMedical'
  | 'inMedical'
  | 'changeToNotInMedical'
  | 'changeToInMedical'
  | 'reunited'
  | 'discharge'
  | 'reopen';

export interface StatusAction {
  id: StatusActionId;
  label: string;
  to: SettableStatus;
  kind: StatusKind;
  /** Answer taps (Not found, In medical, Reunited, Change answer) get the 10 s Undo snackbar. */
  undoable: boolean;
  /** Only the request's creator may do it (server-checked; the UI hides it for others). */
  creatorOnly: boolean;
}

const ACTION: Readonly<Record<StatusActionId, Omit<StatusAction, 'creatorOnly'> & { creatorOnly?: boolean }>> = {
  notInMedical: { id: 'notInMedical', label: ANSWER_LABEL.notFound, to: STATUS.notInMedical, kind: 'answer', undoable: true },
  inMedical: { id: 'inMedical', label: ANSWER_LABEL.inMedical, to: STATUS.inMedical, kind: 'answer', undoable: true },
  changeToNotInMedical: { id: 'changeToNotInMedical', label: 'Change answer', to: STATUS.notInMedical, kind: 'change', undoable: true },
  changeToInMedical: { id: 'changeToInMedical', label: 'Change answer', to: STATUS.inMedical, kind: 'change', undoable: true },
  reunited: { id: 'reunited', label: 'Reunited', to: STATUS.reunited, kind: 'reunite', undoable: true },
  discharge: { id: 'discharge', label: 'Mark discharged', to: STATUS.discharged, kind: 'discharge', undoable: false },
  reopen: { id: 'reopen', label: 'Reopen', to: STATUS.inMedical, kind: 'reopen', undoable: false },
};

function action(id: StatusActionId, overrides: Partial<StatusAction> = {}): StatusAction {
  return { creatorOnly: false, ...ACTION[id], ...overrides };
}

/** (F5) An action's button label ("Not found", "In medical"), for surfaces that name it outside a button. */
export function actionLabel(id: StatusActionId): string {
  return ACTION[id].label;
}

/**
 * The sticky action bar on the profile / the Pending cards (spec §8):
 *   Waiting → Not found, In medical · In medical → Change answer, Reunited ·
 *   Not found in medical → Change answer · closed / unknown → none.
 */
export function primaryActions(status: string): StatusAction[] {
  switch (status) {
    case STATUS.waiting:
      return [action('notInMedical'), action('inMedical')];
    case STATUS.inMedical:
    case STATUS.legacyBringFriend:
      return [action('changeToNotInMedical'), action('reunited')];
    case STATUS.notInMedical:
      return [action('changeToInMedical')];
    default:
      return [];
  }
}

/**
 * The profile ⋯ menu status items (Edit details and Cancel request are not status moves):
 *   Mark discharged only while In medical; Reopen only when closed (Cancelled → Waiting is creator-only).
 */
export function menuActions(status: string, isCreator: boolean): StatusAction[] {
  if (isInMedical(status)) return [action('discharge')];
  if (status === STATUS.reunited || status === STATUS.discharged) return [action('reopen')];
  if (status === STATUS.cancelled) {
    return isCreator ? [action('reopen', { to: STATUS.waiting, creatorOnly: true })] : [];
  }
  return [];
}

/** "Cancel request": creator only (canonical created_by match, v2.1 A18), only while Waiting. */
export function canCancel(status: string, createdBy: string, sessionStaff: string | null | undefined): boolean {
  return status === STATUS.waiting && sameStaff(createdBy, sessionStaff);
}

// ---------------------------------------------------------------------------------------------------
// Teams and staff identity
// ---------------------------------------------------------------------------------------------------

/** Sign-in cards, in display order. `value` is what the data stores. */
export const TEAMS = [
  { value: 'GC/HX - Special Operations/Med Transpo', label: 'GCHX Med Transpo', icon: 'transpo' },
  { value: 'GC/HX - Dispatch', label: 'Dispatch', icon: 'dispatch' },
  { value: 'GC/HX - Base', label: 'GCHX Base', icon: 'base' },
  { value: 'Medical', label: 'Medical', icon: 'medical' },
] as const;

export type TeamValue = (typeof TEAMS)[number]['value'];
export const TEAM_VALUES = TEAMS.map((t) => t.value) as unknown as readonly [TeamValue, ...TeamValue[]];
export const OTHER_TEAM = 'Other' as const;

export const STAFF_NAME_MIN = 2;
export const STAFF_NAME_MAX = 60;
export const OTHER_TEAM_MIN = 2;
export const OTHER_TEAM_MAX = 80;

/**
 * Legacy team aliases (v2.1 A4), lowercased alias → lowercased canonical team.
 * MUST equal the TEAM_ALIASES block in lp_canon_staff (unit-tested by parsing the SQL).
 */
export const TEAM_ALIASES: Readonly<Record<string, string>> = {
  dispatch: 'gc/hx - dispatch',
  'gchx dispatch': 'gc/hx - dispatch',
  base: 'gc/hx - base',
  'gchx base': 'gc/hx - base',
  'med transpo': 'gc/hx - special operations/med transpo',
  'gchx med transpo': 'gc/hx - special operations/med transpo',
  transport: 'gc/hx - special operations/med transpo',
  'special operations': 'gc/hx - special operations/med transpo',
  medical: 'medical',
  prevent: 'prevent',
};

// The JavaScript \s set, spelled out so SQL can use the identical class.
const WHITESPACE_RUN = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
// "•" and "·" separator variants with an optional space either side.
const SEPARATOR = / ?[\u2022\u00b7\u2219\u22c5\u30fb\uff65\u0387] ?/g;
/** The attribution separator: space, U+00B7 MIDDLE DOT, space. */
export const STAFF_SEPARATOR = ' · ';

function normalizeStaffSpacing(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').replace(SEPARATOR, STAFF_SEPARATOR).replace(/^ +| +$/g, '');
}

/**
 * Canonical form of an attribution string, for creator checks. Identical semantics to SQL
 * lp_canon_staff: collapse whitespace, normalise "•"/"·" separators to " · ", trim, lowercase, then map
 * the team part (after the LAST " · ") through TEAM_ALIASES. Null in → null out (SQL is STRICT).
 */
export function canonStaff(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = normalizeStaffSpacing(value).toLowerCase();
  const at = v.lastIndexOf(STAFF_SEPARATOR);
  if (at < 0) return v;
  const team = v.slice(at + STAFF_SEPARATOR.length);
  return `${v.slice(0, at)}${STAFF_SEPARATOR}${TEAM_ALIASES[team] ?? team}`;
}

/** True when both attribution strings are present and canonically equal. */
export function sameStaff(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonStaff(a);
  const cb = canonStaff(b);
  return !!ca && !!cb && ca === cb;
}

/** The attribution string written to created_by / updated_by / audit staff_name (Jeffrey's format). */
export function staffString(staffName: string, team: string): string {
  return `${normalizeStaffSpacing(staffName)}${STAFF_SEPARATOR}${normalizeStaffSpacing(team)}`;
}

/** The canonical team for a team string (alias or canonical, any case); unknown teams are returned trimmed. */
export function canonicalTeam(team: string): string {
  const t = normalizeStaffSpacing(team);
  const key = TEAM_ALIASES[t.toLowerCase()] ?? t.toLowerCase();
  const known = TEAMS.find((x) => x.value.toLowerCase() === key);
  if (known) return known.value;
  if (key === 'prevent') return 'Prevent';
  return t;
}

/** Short team label for display: the card label for known teams, else the team itself. */
export function teamShort(team: string): string {
  const canonical = canonicalTeam(team);
  return TEAMS.find((x) => x.value === canonical)?.label ?? canonical;
}

export interface ParsedStaff {
  name: string;
  team: string;
  teamShort: string;
}

/** "Rae Chen · GC/HX - Special Operations/Med Transpo" → {name: "Rae Chen", team: …, teamShort: "GCHX Med Transpo"}. */
export function parseStaff(value: string | null | undefined): ParsedStaff {
  const v = normalizeStaffSpacing(value ?? '');
  const at = v.lastIndexOf(STAFF_SEPARATOR);
  if (at < 0) return { name: v, team: '', teamShort: '' };
  const team = v.slice(at + STAFF_SEPARATOR.length);
  return { name: v.slice(0, at), team, teamShort: teamShort(team) };
}

/** Characters a staff name or custom team may not contain (they would break the attribution format). */
export const STAFF_FORBIDDEN_CHARS = /[\u2022\u00b7\u2219\u22c5\u30fb\uff65\u0387\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------------------------------------------
// Posts (reporting location)
// ---------------------------------------------------------------------------------------------------

export const POSTS = [
  { value: 'FA 3 – Kinetic', short: 'FA 3' },
  { value: 'FA 4 – Oasis', short: 'FA 4' },
  { value: 'Command', short: 'Command' },
  { value: 'Base', short: 'Base' },
  { value: 'Other', short: 'Other' },
] as const;

export type PostValue = (typeof POSTS)[number]['value'];
export const POST_VALUES = POSTS.map((p) => p.value) as unknown as readonly [PostValue, ...PostValue[]];
export const OTHER_POST = 'Other' as const;
export const OTHER_LOCATION_MIN = 1;
export const OTHER_LOCATION_MAX = 80;

export function isPostValue(value: unknown): value is PostValue {
  return typeof value === 'string' && (POST_VALUES as readonly string[]).includes(value);
}

/**
 * Short form: "FA 3", "FA 4", "Command", "Base", or the other_location text for Other ("Other" if blank).
 * Must match the CASE in lp_stats. Unknown legacy values are returned as they are.
 */
export function postShort(reportingLocation: string | null | undefined, otherLocation?: string | null): string {
  if (!reportingLocation) return '';
  if (reportingLocation === OTHER_POST) return otherLocation?.trim() || OTHER_POST;
  return POSTS.find((p) => p.value === reportingLocation)?.short ?? reportingLocation;
}

/** Full form for the "Reporting from" row and the audit trail: "FA 3 – Kinetic", or the other_location text. */
export function postFull(reportingLocation: string | null | undefined, otherLocation?: string | null): string {
  if (!reportingLocation) return '';
  if (reportingLocation === OTHER_POST) return otherLocation?.trim() || OTHER_POST;
  return reportingLocation;
}

// ---------------------------------------------------------------------------------------------------
// Post filter (?post=, A22) — one key per dashboard "Open by post" bar (A31)
// ---------------------------------------------------------------------------------------------------
// postShort can't be the key: an Other location typed as "Base" and the fixed Base post share it, and so
// do a legacy 'FA 3' row and FA 3 – Kinetic. The key is the post value itself, or "Other:<where>" for
// Other, and matches rows exactly the way lp_stats groups them: the value as stored (legacy values too),
// and Other by other_location, trimmed and case-insensitive.

const OTHER_KEY_PREFIX = `${OTHER_POST}:`;

/** "FA 3 – Kinetic", "Base", a legacy value as stored, or "Other:Gate 9". */
export function postFilterKey(reportingLocation: string | null | undefined, otherLocation?: string | null): string {
  if (!reportingLocation) return '';
  if (reportingLocation === OTHER_POST) return `${OTHER_KEY_PREFIX}${otherLocation?.trim() ?? ''}`;
  return reportingLocation;
}

/** The post a filter key stands for. */
export function parsePostFilterKey(key: string): { reportingLocation: string; otherLocation: string | null } {
  if (key.startsWith(OTHER_KEY_PREFIX)) return { reportingLocation: OTHER_POST, otherLocation: key.slice(OTHER_KEY_PREFIX.length).trim() };
  return { reportingLocation: key, otherLocation: null };
}

/**
 * What a post bar and its filter chip say: the fixed and legacy posts by name ("FA 3 – Kinetic", "FA 3"),
 * and Other locations as "Other · Gate 9", so an Other location can never read like a fixed post.
 */
export function postFilterLabel(reportingLocation: string | null | undefined, otherLocation?: string | null): string {
  if (!reportingLocation) return '';
  if (reportingLocation === OTHER_POST) {
    const where = otherLocation?.trim();
    return where ? `${OTHER_POST} · ${where}` : OTHER_POST;
  }
  return reportingLocation;
}

/** True when the row is at the post the key stands for (see postFilterKey). */
export function matchesPostFilter(
  row: { reportingLocation: string | null | undefined; otherLocation?: string | null },
  key: string,
): boolean {
  const want = parsePostFilterKey(key);
  if (want.reportingLocation === OTHER_POST) {
    return row.reportingLocation === OTHER_POST && (row.otherLocation ?? '').trim().toLowerCase() === (want.otherLocation ?? '').toLowerCase();
  }
  return row.reportingLocation === want.reportingLocation;
}

// ---------------------------------------------------------------------------------------------------
// Fields and limits (validated in zod and in SQL lp_clean_fields)
// ---------------------------------------------------------------------------------------------------

export const LIMITS = {
  name: 120,
  clothing: 300,
  hair: 300,
  heightBuild: 300,
  identifyingFeatures: 300,
  lastSeen: 1000,
  physicalDescription: 2000,
  additionalNotes: 2000,
  contactNotes: 2000,
  contactName: 120,
  contactRelationship: 120,
  contactPhone: 40,
  otherLocation: OTHER_LOCATION_MAX,
  /** Free text since 2026-11-06 (Jeffrey): "24", "mid-20s". */
  age: 40,
  /** Free text since 2026-11-06 (Jeffrey); GENDERS are quick-fill options. */
  gender: 40,
  /** Where medical has the patient ("Chair 14"), free text (Dani + Brian, 2026-11-06 afternoon). */
  medicalLocation: 60,
} as const;

/** The old numeric age range. The server no longer enforces it: age is free text (LIMITS.age). */
export const AGE_MIN = 0;
export const AGE_MAX = 120;

/** Quick-fill options for the free-text gender field (any text up to LIMITS.gender is accepted). */
export const GENDERS = ['Male', 'Female', 'Other'] as const;
export type Gender = (typeof GENDERS)[number];

/** Male → "M", Female → "F" (also typed as male / m / man, female / f / woman, any case), anything else → "". */
export function genderShort(gender: string | null | undefined): '' | 'M' | 'F' {
  const g = gender?.trim().toLowerCase();
  if (g === 'male' || g === 'm' || g === 'man') return 'M';
  if (g === 'female' || g === 'f' || g === 'woman') return 'F';
  return '';
}

/** "19 F" / "24 M" / "mid-20s F" / "19" / "F" / "" for the list rows and cards. Age is free text. */
export function ageGender(age: string | number | null | undefined, gender: string | null | undefined): string {
  const parts: string[] = [];
  const a = age === null || age === undefined ? '' : String(age).trim();
  if (a) parts.push(a);
  const g = genderShort(gender);
  if (g) parts.push(g);
  return parts.join(' ');
}

/**
 * The editable request fields (camelCase) and their database columns. lp_update_fields accepts exactly
 * these columns (plus first_name / last_name, which the server derives from `name`).
 */
export const FIELD_COLUMNS = {
  age: 'age',
  gender: 'gender',
  heightBuild: 'height_build',
  hair: 'hair',
  identifyingFeatures: 'identifying_features',
  physicalDescription: 'physical_description',
  lastSeen: 'last_seen',
  clothing: 'clothing',
  additionalNotes: 'additional_notes',
  reportingLocation: 'reporting_location',
  otherLocation: 'other_location',
  contactName: 'contact_name',
  contactPhone: 'contact_phone',
  contactRelationship: 'contact_relationship',
  contactNotes: 'contact_notes',
  firstName: 'first_name',
  lastName: 'last_name',
  /** Set from Pending and the request once medical has the patient; never part of the request form. */
  medicalLocation: 'medical_location',
} as const;

export type EditableField = keyof typeof FIELD_COLUMNS;

/** Text fields of the request form (everything except age, gender and the post). */
export const TEXT_FIELDS = [
  'clothing',
  'lastSeen',
  'hair',
  'heightBuild',
  'identifyingFeatures',
  'physicalDescription',
  'additionalNotes',
  'contactName',
  'contactPhone',
  'contactRelationship',
  'contactNotes',
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

/** Edit sections (v2.1 A24: ?r=<id>&edit=person|friend|all). */
export const EDIT_SECTIONS = ['person', 'friend', 'all'] as const;
export type EditSection = (typeof EDIT_SECTIONS)[number];

/** Which form fields each edit section shows ("name" stands for first + last name). */
export const SECTION_FIELDS: Readonly<Record<Exclude<EditSection, 'all'>, readonly string[]>> = {
  person: ['name', 'age', 'gender', 'clothing', 'lastSeen', 'hair', 'heightBuild', 'identifyingFeatures', 'physicalDescription', 'additionalNotes'],
  friend: ['contactName', 'contactPhone', 'contactRelationship', 'contactNotes'],
};

/** Display labels (form rows, profile rows, audit "Edited <label>"). Name and Post are merged fields. */
export const FIELD_LABELS = {
  name: 'Name',
  age: 'Age',
  gender: 'Gender',
  post: 'Post',
  clothing: 'Wearing',
  lastSeen: 'Last seen',
  hair: 'Hair',
  heightBuild: 'Build',
  identifyingFeatures: 'Features',
  physicalDescription: 'Description',
  additionalNotes: 'Other notes',
  contactName: "Friend's name",
  contactPhone: 'Phone',
  contactRelationship: 'Relation',
  contactNotes: 'Contact notes',
  medicalLocation: 'Location',
} as const;
export type DisplayField = keyof typeof FIELD_LABELS;

export interface DisplayChange {
  field: DisplayField;
  label: string;
  from: string | null;
  to: string | null;
}

/**
 * Turns an edit's previous / next values (camelCase EditableField keys) into display rows. First and last
 * name merge into "Name"; reporting location and other location merge into "Post" (full form).
 * Unchanged merged values are dropped.
 */
export function displayChanges(
  previous: Partial<Record<EditableField, string | number | null>>,
  next: Partial<Record<EditableField, string | number | null>>,
): DisplayChange[] {
  const out: DisplayChange[] = [];
  const str = (v: string | number | null | undefined): string | null =>
    v === null || v === undefined || v === '' ? null : String(v);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)] as EditableField[]);

  // The database records both halves of a merged field whenever either changes; fall back to the other
  // side for events that carry only one half.
  const either = <K extends EditableField>(src: typeof previous, other: typeof previous, key: K) =>
    key in src ? src[key] : other[key];

  if (keys.has('firstName') || keys.has('lastName')) {
    const from = joinName(str(either(previous, next, 'firstName')), str(either(previous, next, 'lastName'))) || null;
    const to = joinName(str(either(next, previous, 'firstName')), str(either(next, previous, 'lastName'))) || null;
    if (from !== to) out.push({ field: 'name', label: FIELD_LABELS.name, from, to });
  }
  if (keys.has('reportingLocation') || keys.has('otherLocation')) {
    const fromLoc = str(either(previous, next, 'reportingLocation'));
    const toLoc = str(either(next, previous, 'reportingLocation'));
    const from = fromLoc ? postFull(fromLoc, str(either(previous, next, 'otherLocation'))) : null;
    const to = toLoc ? postFull(toLoc, str(either(next, previous, 'otherLocation'))) : null;
    if (from !== to) out.push({ field: 'post', label: FIELD_LABELS.post, from, to });
  }
  for (const key of keys) {
    if (key === 'firstName' || key === 'lastName' || key === 'reportingLocation' || key === 'otherLocation') continue;
    const from = str(previous[key]);
    const to = str(next[key]);
    if (from !== to) out.push({ field: key, label: FIELD_LABELS[key], from, to });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------

/**
 * Splits the single Name field into first_name / last_name at the LAST space, like Jeffrey's app
 * (trim, collapse whitespace). Empty → both null; a single word → last null.
 */
export function splitName(name: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const v = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!v) return { firstName: null, lastName: null };
  const at = v.lastIndexOf(' ');
  if (at < 0) return { firstName: v, lastName: null };
  return { firstName: v.slice(0, at), lastName: v.slice(at + 1) };
}

/** first + last joined with a space, skipping empty parts (same as SQL concat_ws over nullif(…, '')). */
export function joinName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  return [firstName, lastName].filter(Boolean).join(' ');
}

/**
 * Initials for alerts and toasts (v2.1 A4): the first letters of the first and last word, uppercased,
 * with periods. Periods count as word breaks, so "T.R." stays "T.R.". A single word keeps its first two
 * letters, uppercased ("Dana" → "DA"). Empty → "".
 */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').split(/[\s.]+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = (w: string) => (Array.from(w)[0] ?? '').toUpperCase();
  if (words.length === 1) {
    const only = Array.from(words[0] ?? '');
    return only.length === 1 ? `${first(words[0] ?? '')}.` : only.slice(0, 2).join('').toUpperCase();
  }
  return `${first(words[0] ?? '')}.${first(words[words.length - 1] ?? '')}.`;
}

/** Avatar letters for a staff member: "Dana Kim" → "DK", "Rae" → "RA" (no periods). */
export function avatarInitials(staffName: string | null | undefined): string {
  const words = (staffName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const letters = (w: string) => Array.from(w);
  if (words.length === 1) return letters(words[0] ?? '').slice(0, 2).join('').toUpperCase();
  return `${letters(words[0] ?? '')[0] ?? ''}${letters(words[words.length - 1] ?? '')[0] ?? ''}`.toUpperCase();
}

// ---------------------------------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------------------------------

export const PHONE_MIN_DIGITS = 10;
export const PHONE_MAX_DIGITS = 15;

export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/** The ✓ in the form: 10–15 digits (the field itself accepts any text up to 40 characters). */
export function isValidPhone(phone: string | null | undefined): boolean {
  const n = phoneDigits(phone).length;
  return n >= PHONE_MIN_DIGITS && n <= PHONE_MAX_DIGITS;
}

/** tel: link for the Call button, or null when the number has no digits. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = phoneDigits(phone);
  if (!digits) return null;
  return `tel:${(phone ?? '').trim().startsWith('+') ? '+' : ''}${digits}`;
}

// ---------------------------------------------------------------------------------------------------
// Waiting time
// ---------------------------------------------------------------------------------------------------

export const WAIT_AMBER_MINUTES = 10;
export const WAIT_RED_MINUTES = 20;
export type WaitTone = 'gray' | 'amber' | 'red';

/** Wait badge colour: grey under 10 min, amber 10–19, red 20 or more. */
export function waitTone(minutes: number): WaitTone {
  if (minutes >= WAIT_RED_MINUTES) return 'red';
  if (minutes >= WAIT_AMBER_MINUTES) return 'amber';
  return 'gray';
}

// ---------------------------------------------------------------------------------------------------
// New-request form helpers
// ---------------------------------------------------------------------------------------------------

/** "Last seen" shortcuts (stage names from the site plan). */
export const STAGE_CHIPS = ['kineticFIELD', 'circuitGROUNDS', 'neonGARDEN', 'stereoBLOOM', 'Taken to medical'] as const;

/** Appends a chip to the Last seen text, with ", " when the field isn't empty. */
export function appendChip(current: string, chip: string): string {
  const base = current.replace(/[\s,]+$/, '');
  return base.trim() ? `${base}, ${chip}` : chip;
}

// ---------------------------------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------------------------------

export const MAX_PHOTOS = 3;
/** Timings this app writes. */
export const PHOTO_TIMINGS = ['today', 'older'] as const;
export type PhotoTiming = (typeof PHOTO_TIMINGS)[number];
/** Timings that can be read back ('unsure' is Jeffrey's legacy value). */
export type PhotoTimingAny = PhotoTiming | 'unsure';
export const PHOTO_TIMING_LABEL: Readonly<Record<PhotoTimingAny, string>> = {
  today: 'Today',
  older: 'Not today',
  unsure: 'Timing unknown',
};

/** Client-side compression targets (spec §7 Photos). */
export const PHOTO_FULL_MAX_EDGE = 1600;
export const PHOTO_FULL_QUALITY = 0.82;
export const PHOTO_MIN_QUALITY = 0.6;
export const PHOTO_FULL_MAX_BYTES = 2_500_000;
export const PHOTO_THUMB_MAX_EDGE = 320;
export const PHOTO_THUMB_QUALITY = 0.7;
/** The whole multipart upload must stay under Vercel's 4.5 MB body cap. */
export const PHOTO_UPLOAD_MAX_BYTES = 3_900_000;
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

// ---------------------------------------------------------------------------------------------------
// The "Not found yet" hold (F5, Brian 2026-11-06 evening; design/screens/updates.html #recheck)
// ---------------------------------------------------------------------------------------------------
// The first Not found on a request Waiting for check keeps it open (status 'Added') with recheckAt = answer +
// RECHECK_MINUTES and notFoundChecks = 1 (rework SQL step 1d, lp_set_status); it is due once recheckAt has passed
// and stays open until someone answers; the next Not found is final. The stage system that shows it (Needs info,
// Not found yet, Friend en route, …: displayStage, STAGE_META) is lib/stages.ts, a module of its own so the
// first load (A25) does not carry it. Only what the store and the alerts need on the first load is here.

/** How long a "Not found yet" hold lasts. MUST equal lp_stages_recheck_minutes() in the rework SQL (unit-tested). */
export const RECHECK_MINUTES = 20;

/** The held stage's label (lib/stages.ts STAGE_META.notFoundYet; here for the alerts on the first load). */
export const NOT_FOUND_YET_LABEL = 'Not found yet';

const holdEpoch = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** True while a request Waiting for check is on a "Not found yet" hold (due or not). */
export function isHeld(row: { status: string; recheckAt?: string | null }): boolean {
  return row.status === STATUS.waiting && Number.isFinite(holdEpoch(row.recheckAt));
}

/**
 * (F5, contract B) The first Not found's words, nouns only: "Not found yet · recheck 4:40 PM". Line 2 of the
 * Activity row, the push body, and the in-app alert's subtitle / system notification body.
 */
export function holdDetail(recheckAt: string | null | undefined, timeZone?: string): string {
  return Number.isFinite(holdEpoch(recheckAt)) ? `${NOT_FOUND_YET_LABEL} · recheck ${formatClockAmPm(recheckAt as string, timeZone)}` : NOT_FOUND_YET_LABEL;
}

/** A held request whose recheck time has come (it never closes by itself). */
export function isRecheckDue(row: { status: string; recheckAt?: string | null }, now: number): boolean {
  return isHeld(row) && holdEpoch(row.recheckAt) <= now;
}

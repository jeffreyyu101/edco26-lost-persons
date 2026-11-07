// The Activity inbox and Web Push words (F4, spec §18 A53–A59; the shared contract A/B with F3 and F5).
// Pure and isomorphic: no React, no fetch, no server-only code, so the routes, lib/server/notify.ts, the
// service worker's payloads and the client all use the same words, glyphs and times.
//
// Contract B: `detail` is line 2 of an Activity row AND the push body: nouns only, built by whoever raises
// the event. Never a phone number, contact details or a request id (LP-####); scrubDetail() enforces that
// once more where the text leaves the server. The push title is the request's initials (never a full name on
// a lock screen), except a new request: "New request". Status words always come from STATUS_META, so a
// later rename of a label flows through.
import { NOT_FOUND_YET_LABEL, STATUS, STATUS_META, ageGender, initials, joinName } from './domain';
import { agoPhrase, formatClockAmPm, eventDate, minutesSince } from './format';
import { threadPath } from './thread-link';

// ---------------------------------------------------------------------------------------------------
// Kinds (contract A)
// ---------------------------------------------------------------------------------------------------

export const ACTIVITY_KINDS = [
  'message',
  'enroute',
  'enroute_changed',
  'enroute_cancelled',
  'arrived',
  'new_request',
  'in_medical',
  'not_in_medical',
  'back_to_waiting',
  'moved',
  'reunited',
  'discharged',
  'cancelled',
  'edited',
  /** (F6) The server closed it after an hour In medical with no activity (lib/server/inactive-notify.ts). */
  'closed_inactive',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One event about a request (contract A). `actor` is the attribution string of whoever caused it. */
export interface ActivityEvent {
  requestId: string;
  kind: ActivityKind;
  actor: string;
  detail: string;
}

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** The app's name, exactly (Jeffrey): the iPhone Settings path shows it. */
export const APP_NAME = 'Is my friend in medical?';

// ---------------------------------------------------------------------------------------------------
// Wire types (GET /api/activity, POST /api/activity/read | unread, POST /api/push/*)
// ---------------------------------------------------------------------------------------------------

/** One Activity row: ONE per request, the latest event about it. */
export interface ActivityRow {
  requestId: string;
  kind: ActivityKind;
  /** Line 1: the request's initials ("J.D."), or NO_NAME. Never the full name. */
  title: string;
  /** Line 2 (contract B). */
  detail: string;
  at: string;
  read: boolean;
}

/**
 * (2026-11-07, Located / Not located; Pending) lp_activity keeps each row's detail as it was written, so a row from
 * before the rename can still start with an old status word: "In medical · Chair 9", "Not found yet · recheck
 * 4:40 PM", "Not located yet · recheck 4:40 PM", "Not found in medical". Read back, a status row (in_medical /
 * not_in_medical) whose detail is exactly such a word, or starts with it and " · ", reads with today's label;
 * every other row and detail is left as written.
 */
const LEGACY_STATUS_WORDS: ReadonlyArray<readonly [ActivityKind, string, string]> = [
  ['in_medical', 'In medical', STATUS_META[STATUS.inMedical].shortLabel],
  ['not_in_medical', 'Not found yet', NOT_FOUND_YET_LABEL],
  ['not_in_medical', 'Not located yet', NOT_FOUND_YET_LABEL],
  ['not_in_medical', 'Not found in medical', STATUS_META[STATUS.notInMedical].label],
  ['not_in_medical', 'Not in medical', STATUS_META[STATUS.notInMedical].label],
];

export function currentDetail(kind: ActivityKind, detail: string): string {
  for (const [k, old, now] of LEGACY_STATUS_WORDS) {
    if (kind === k && (detail === old || detail.startsWith(`${old} · `))) return `${now}${detail.slice(old.length)}`;
  }
  return detail;
}

/** lp_activity_list's snake_case row → ActivityRow (null when it is not one). */
export function mapActivityRow(raw: unknown): ActivityRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const requestId = s(r.request_id);
  const at = s(r.at);
  if (!requestId || !at || !isActivityKind(r.kind)) return null;
  return {
    requestId,
    kind: r.kind,
    title: requestTitle(s(r.first_name), s(r.last_name)),
    detail: currentDetail(r.kind, scrubDetail(s(r.detail) ?? '')),
    at,
    read: r.read_at !== null && r.read_at !== undefined,
  };
}

export interface ActivityListResponse {
  serverTime: string;
  rows: ActivityRow[];
}

/** POST /api/activity/read: the rows that turned read (Undo sends `ids` back to /api/activity/unread). */
export interface ActivityReadResponse {
  count: number;
  ids: string[];
}

export interface ActivityUnreadResponse {
  count: number;
}

/** GET /api/activity/unread: the requests the bell counts (newest first, ≤ 100) and the Activity fingerprint. */
export interface ActivityUnreadIdsResponse {
  count: number;
  ids: string[];
  key: string | null;
}

/** POST /api/push/prefs and /api/push/subscribe. */
export interface PushConfigResponse {
  /** The server has VAPID keys: Web Push works. Without them, no banner and no push anywhere. */
  enabled: boolean;
  /** The VAPID public key subscriptions must use (null when push is off). */
  publicKey: string | null;
  newRequests: boolean;
  myUpdates: boolean;
}

export interface PushTestResponse {
  sent: boolean;
}

/** What the service worker receives (encrypted) and shows. Under 4 KB, no ids but the request's uuid. */
export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  /** "lp-<id>": one notification per request on the lock screen (the OS replaces, never stacks). */
  tag: string;
  /** "/?r=<id>", "/?r=<id>&to=thread" for a message (R2: it opens at the thread), or "/" for a test alert. */
  url: string;
  kind: ActivityKind | 'test';
  requestId: string | null;
  /**
   * Sound and show again when it replaces an earlier one: every request event (one tag per request, so a
   * later answer must never silently replace "Located" or medical's question), as the page's own
   * notification did (system-notify noticeOptions).
   */
  renotify: boolean;
  /** Stays on screen until dismissed (Located: front of house walks the friend over), like its toast. */
  requireInteraction?: boolean;
  /** The recipient's unread Activity count (the app icon badge), when known. */
  badge: number | null;
}

// ---------------------------------------------------------------------------------------------------
// Copy (contract B, exact)
// ---------------------------------------------------------------------------------------------------

/** A message excerpt is cut to this many characters. */
export const MESSAGE_EXCERPT_MAX = 120;
/** The longest detail stored or pushed. */
export const DETAIL_MAX = 200;
/** Line 1 / the push title when a request has no name (photo only). */
export const NO_NAME = 'No name';
/** The push title of a new request. */
export const NEW_REQUEST_TITLE = 'New request';

const REQUEST_ID = /\bLP[\s-]?\d{1,9}\b/gi;
// A run of 7 or more digits with phone punctuation between them ("(407) 555-0142", "+1 407 555 0142").
const PHONE_LIKE = /\+?\(?\d(?:[\s().-]{0,3}\d){6,}/g;

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/**
 * Contract E, enforced again where the text leaves the server: a request id (LP-1013) is dropped and a phone
 * number becomes "•••". Short numbers ("Chair 9", "24 M", "~4 min", "4:40 PM") stay. Whitespace collapses
 * and the result is at most DETAIL_MAX characters.
 */
export function scrubDetail(text: string): string {
  const clean = text
    .replace(REQUEST_ID, '')
    .replace(PHONE_LIKE, '•••')
    .replace(/\s+/g, ' ')
    .replace(/^[\s·:,]+|[\s·:,]+$/g, '')
    .trim();
  return cut(clean, DETAIL_MAX);
}

/** "Rae Chen" → "Rae C." (first name and last initial); one word stays as it is. */
export function shortStaffName(staffName: string): string {
  const words = staffName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0] ?? '';
  const last = Array.from(words[words.length - 1] ?? '')[0] ?? '';
  return `${words[0]} ${last.toUpperCase()}.`;
}

/** message: "Rae C.: Bring 1 person only" (the text cut to 120 characters). */
export function messageDetail(senderStaffName: string, text: string): string {
  const excerpt = cut(text.replace(/\s+/g, ' ').trim(), MESSAGE_EXCERPT_MAX);
  const who = shortStaffName(senderStaffName);
  return who ? `${who}: ${excerpt}` : excerpt;
}

/** enroute / enroute_changed: "Friend en route · ~4 min", or "Friend en route" without an ETA. */
export function enrouteDetail(etaMinutes?: number | null): string {
  return typeof etaMinutes === 'number' && Number.isFinite(etaMinutes) && etaMinutes >= 0
    ? `Friend en route · ~${Math.round(etaMinutes)} min`
    : 'Friend en route';
}

/** new_request: "T.R. · 24 M · FA 4". */
export function newRequestDetail(row: { name: string | null; age: string | null; gender: string | null; postShort: string }): string {
  return [initials(row.name), ageGender(row.age, row.gender), row.postShort].filter(Boolean).join(' · ');
}

/** in_medical: "Located · Chair 9", or "Located" (the label is STATUS_META's). */
export function inMedicalDetail(location: string | null | undefined): string {
  const label = STATUS_META[STATUS.inMedical].shortLabel;
  const where = location?.trim();
  return where ? `${label} · ${where}` : label;
}

/** back_to_waiting: "Back to Waiting for check". */
export function backToWaitingDetail(): string {
  return `Back to ${STATUS_META[STATUS.waiting].label}`;
}

/** moved: "Chair 9 → Bed 3", or "Bed 3" when there was no location before. */
export function movedDetail(from: string | null | undefined, to: string): string {
  const a = from?.trim();
  return a ? `${a} → ${to.trim()}` : to.trim();
}

/** reunited / discharged / cancelled: the status label ("Reunited", "Discharged", "Cancelled"). */
export function closedDetail(kind: 'reunited' | 'discharged' | 'cancelled'): string {
  const status = kind === 'reunited' ? STATUS.reunited : kind === 'discharged' ? STATUS.discharged : STATUS.cancelled;
  return STATUS_META[status].label;
}

/** edited: any other change to the request's details. */
export const EDITED_DETAIL = 'Details changed';

/** (F6) closed_inactive: the status label, "Closed · inactive". */
export function inactiveDetail(): string {
  return STATUS_META[STATUS.inactive].label;
}

/**
 * The event of a status change made through POST /api/requests/:id/status (contract D, F4's kinds), or null.
 * Not in medical is never raised here: the Not found yet hold (F5) owns both its answers.
 */
export function statusChangeEvent(status: string, medicalLocation: string | null | undefined): { kind: ActivityKind; detail: string } | null {
  if (status === STATUS.inMedical || status === STATUS.legacyBringFriend) return { kind: 'in_medical', detail: inMedicalDetail(medicalLocation) };
  if (status === STATUS.waiting) return { kind: 'back_to_waiting', detail: backToWaitingDetail() };
  if (status === STATUS.reunited) return { kind: 'reunited', detail: closedDetail('reunited') };
  if (status === STATUS.discharged) return { kind: 'discharged', detail: closedDetail('discharged') };
  if (status === STATUS.cancelled) return { kind: 'cancelled', detail: closedDetail('cancelled') };
  return null;
}

/**
 * The event of an edit (PATCH /api/requests/:id), from the audit pair of what changed. Where medical has
 * them, set for the first time while In medical, completes the answer ("In medical · Chair 9"); a new place
 * is "Chair 9 → Bed 3"; anything else (a cleared location included) is "Details changed".
 */
export function editEvent(
  changedKeys: readonly string[],
  previousLocation: string | null | undefined,
  nextLocation: string | null | undefined,
  status: string,
): { kind: ActivityKind; detail: string } {
  const next = nextLocation?.trim() ?? '';
  const prev = previousLocation?.trim() ?? '';
  if (changedKeys.includes('medical_location') && next) {
    if (!prev && (status === STATUS.inMedical || status === STATUS.legacyBringFriend)) return { kind: 'in_medical', detail: inMedicalDetail(next) };
    return { kind: 'moved', detail: movedDetail(prev, next) };
  }
  return { kind: 'edited', detail: EDITED_DETAIL };
}

/** Line 1 and the push title: the initials of the request's name, else NO_NAME. */
export function requestTitle(firstName: string | null | undefined, lastName: string | null | undefined): string {
  return initials(joinName(firstName, lastName)) || NO_NAME;
}

// ---------------------------------------------------------------------------------------------------
// Push (payload, urgency, TTL)
// ---------------------------------------------------------------------------------------------------

/** Answers, new requests and messages are time-critical; the rest can wait a little. */
const HIGH: ReadonlySet<ActivityKind> = new Set(['new_request', 'in_medical', 'not_in_medical', 'back_to_waiting', 'message']);

export type PushUrgency = 'high' | 'normal';

export function pushUrgency(kind: ActivityKind): PushUrgency {
  return HIGH.has(kind) ? 'high' : 'normal';
}

/** Seconds a push service keeps an undelivered push: an hour for urgent ones, 15 minutes otherwise. */
export function pushTtl(kind: ActivityKind): number {
  return HIGH.has(kind) ? 3_600 : 900;
}

export const PUSH_PAYLOAD_MAX_BYTES = 3_000;

/** The push for one event, for one recipient (`badge` = their unread count). */
export function pushPayload(event: Pick<ActivityEvent, 'requestId' | 'kind' | 'detail'>, title: string, badge: number | null): PushPayload {
  return {
    v: 1,
    title: event.kind === 'new_request' ? NEW_REQUEST_TITLE : title || NO_NAME,
    body: scrubDetail(event.detail),
    tag: `lp-${event.requestId}`,
    url: event.kind === 'message' ? threadPath(event.requestId) : `/?r=${event.requestId}`,
    kind: event.kind,
    requestId: event.requestId,
    renotify: true,
    requireInteraction: event.kind === 'in_medical',
    badge: typeof badge === 'number' && Number.isFinite(badge) && badge >= 0 ? Math.floor(badge) : null,
  };
}

/** "Send a test alert". */
export function testPayload(): PushPayload {
  return { v: 1, title: APP_NAME, body: 'Test alert', tag: 'lp-test', url: '/', kind: 'test', requestId: null, renotify: true, badge: null };
}

// ---------------------------------------------------------------------------------------------------
// The inbox UI (pure parts)
// ---------------------------------------------------------------------------------------------------

/** lucide icon names the Activity row maps to components (components/activity/glyphs.tsx). */
export type ActivityIcon = 'message-square' | 'cross' | 'walk' | 'check' | 'map-pin' | 'hourglass' | 'x' | 'undo-2' | 'plus' | 'pencil' | 'timer-off';
/** Radix colour scale; the glyph is step 11 of it. */
export type ActivityTone = 'gray' | 'green' | 'teal' | 'violet' | 'blue';

export interface ActivityGlyph {
  icon: ActivityIcon;
  tone: ActivityTone;
}

/** One glyph and colour per kind (Brian's map; en route is teal, Not found yet violet). */
export const ACTIVITY_GLYPH: Readonly<Record<ActivityKind, ActivityGlyph>> = {
  message: { icon: 'message-square', tone: 'gray' },
  in_medical: { icon: 'cross', tone: 'green' },
  enroute: { icon: 'walk', tone: 'teal' },
  enroute_changed: { icon: 'walk', tone: 'teal' },
  enroute_cancelled: { icon: 'walk', tone: 'gray' },
  arrived: { icon: 'check', tone: 'green' },
  moved: { icon: 'map-pin', tone: 'gray' },
  not_in_medical: { icon: 'x', tone: 'gray' },
  back_to_waiting: { icon: 'undo-2', tone: 'blue' },
  new_request: { icon: 'plus', tone: 'blue' },
  reunited: { icon: 'check', tone: 'gray' },
  discharged: { icon: 'check', tone: 'gray' },
  cancelled: { icon: 'x', tone: 'gray' },
  edited: { icon: 'pencil', tone: 'gray' },
  // (F6) The status glyph of Closed · inactive (StatusGlyph 'inactive'), grey: closed.
  closed_inactive: { icon: 'timer-off', tone: 'gray' },
};

/** The Pending hold (F5's "Not found yet"): its detail starts with these words (lib/domain's label, so a rename flows through). */
export const NOT_FOUND_YET = NOT_FOUND_YET_LABEL;

export function activityGlyph(kind: ActivityKind, detail: string): ActivityGlyph {
  if (kind === 'not_in_medical' && detail.startsWith(NOT_FOUND_YET)) return { icon: 'hourglass', tone: 'violet' };
  return ACTIVITY_GLYPH[kind];
}

/** The bell's count: hidden at 0, then 1–9, then "9+". */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count < 1) return '';
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** The row's time: "now", "2m", "1h", then the clock "4:12 PM" (event timezone). */
export function activityTime(at: string, now: number, timeZone: string): string {
  const minutes = minutesSince(at, now);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 120) return '1h';
  return formatClockAmPm(at, timeZone);
}

/** Day labels, only when the list spans more than one event day. */
export interface ActivitySection<T> {
  /** "Today", "Yesterday", "Thu" — null when the whole list is one day (no label). */
  label: string | null;
  rows: T[];
}

export function groupByDay<T extends { at: string }>(rows: readonly T[], now: number, timeZone: string): ActivitySection<T>[] {
  if (rows.length === 0) return [];
  const today = eventDate(now, timeZone);
  const yesterday = eventDate(now - 86_400_000, timeZone);
  const sections: Array<{ day: string; rows: T[] }> = [];
  for (const row of rows) {
    const day = eventDate(row.at, timeZone);
    const last = sections[sections.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else sections.push({ day, rows: [row] });
  }
  if (sections.length === 1) return [{ label: null, rows: sections[0]?.rows ?? [] }];
  const weekday = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(iso));
  return sections.map((s) => ({
    label: s.day === today ? 'Today' : s.day === yesterday ? 'Yesterday' : weekday(s.rows[0]?.at ?? ''),
    rows: s.rows,
  }));
}

/**
 * A new request's detail after its initials: "T.R. · 24 M · FA 4" → "24 M · FA 4" (contract B starts it with the
 * initials because the push's title is "New request"). Other kinds: the detail as it is.
 */
function detailAfterTitle(row: Pick<ActivityRow, 'kind' | 'title' | 'detail'>): string {
  if (row.kind !== 'new_request') return row.detail;
  if (row.detail === row.title) return '';
  const prefix = `${row.title} · `;
  return row.detail.startsWith(prefix) ? row.detail.slice(prefix.length) : row.detail;
}

/**
 * Line 2 as the row shows it: the detail (contract B), except a new request, whose line 1 already is its
 * initials: "New request · 24 M · FA 4" (f34-v2-2), not "T.R. · 24 M · FA 4" again. The stored detail and the
 * push body are unchanged.
 */
export function activityLine2(row: Pick<ActivityRow, 'kind' | 'title' | 'detail'>): string {
  if (row.kind !== 'new_request') return row.detail;
  const rest = detailAfterTitle(row);
  return rest ? `${NEW_REQUEST_TITLE} · ${rest}` : NEW_REQUEST_TITLE;
}

/** What a screen reader hears for the kind, before the detail. */
const SPOKEN_KIND: Readonly<Record<ActivityKind, string>> = {
  message: 'new message',
  enroute: 'friend en route',
  enroute_changed: 'en route time changed',
  enroute_cancelled: 'en route cancelled',
  arrived: 'friend arrived',
  new_request: 'new request',
  in_medical: 'answer',
  not_in_medical: 'answer',
  back_to_waiting: 'answer changed',
  moved: 'location changed',
  reunited: 'closed',
  discharged: 'closed',
  cancelled: 'closed',
  edited: 'details changed',
  closed_inactive: 'closed',
};

/** Spoken form of the initials: "J.D." → "J D"; NO_NAME stays. */
function spokenTitle(title: string): string {
  return title === NO_NAME ? 'A request with no name' : `Request ${title.replace(/\./g, ' ').trim()}`;
}

/** The row's full sentence: "Request J D, answer: Located, Chair 9. 5 minutes ago. Unread." */
export function activityAriaLabel(row: Pick<ActivityRow, 'kind' | 'title' | 'detail' | 'at' | 'read'>, now: number): string {
  const detail = detailAfterTitle(row).replace(/ · /g, ', ').replace(/ → /g, ' to ');
  const ago = agoPhrase(minutesSince(row.at, now));
  const what = detail ? `${SPOKEN_KIND[row.kind]}: ${detail}` : SPOKEN_KIND[row.kind];
  return `${spokenTitle(row.title)}, ${what}. ${ago.charAt(0).toUpperCase()}${ago.slice(1)}.${row.read ? '' : ' Unread.'}`;
}

// Wire types between the server (app/api/**) and the client (spec §6, v2.1 A1). Types only.
// FROZEN after Phase 1a: later phases may ADD types or optional fields, never change existing ones.
//
// Shape rule (A1): the database RPCs return snake_case JSON. The server maps it to these camelCase
// types through an EXPLICIT allowlist (legacy columns never leak through) and adds the derived fields.
import type { EditableField, FriendInMedical, PhotoTiming, PhotoTimingAny, StatusKind, StatusValue, SwapPlace } from './domain';
import type { CreateRequestBody, RequestPatch } from './validation';

/**
 * An ISO 8601 timestamp from the database clock, e.g. "2026-11-06T23:10:04.123456+00:00" (microsecond
 * precision). Cursors (`serverTime`, `next.at`) must be sent back VERBATIM and URL-ENCODED — never
 * round-trip them through `Date`, which drops the microseconds, and never interpolate them raw into a URL:
 * a raw '+' decodes as a space. Build sync URLs with syncPath() (lib/client/api-paths.ts).
 */
export type IsoDateTime = string;

// ---------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------

/** Every known `patients` column, camelCased (A1), plus rowVersion / photo fields and derived fields. */
export interface RequestSummary {
  // Identity
  id: string;
  clientMutationId: string | null;
  caseNumber: number;
  firstName: string | null;
  lastName: string | null;
  // Person
  /** Free text as typed ("24", "mid-20s"), or null. Ages saved as numbers before 2026-11-06 read back as text ("24"). */
  age: string | null;
  /** Free text (Male / Female / Other are the form's quick-fill options), or null. */
  gender: string | null;
  heightBuild: string | null;
  hair: string | null;
  identifyingFeatures: string | null;
  physicalDescription: string | null;
  lastSeen: string | null;
  clothing: string | null;
  additionalNotes: string | null;
  // Post
  /** A PostValue, or a legacy value. */
  reportingLocation: string;
  otherLocation: string | null;
  // Contact
  contactName: string | null;
  contactPhone: string | null;
  contactRelationship: string | null;
  contactNotes: string | null;
  // Status and audit
  /** A Status, or a legacy value: always render through domain.statusMeta(). */
  status: StatusValue;
  /** Attribution string "Name · Team" (Jeffrey's format). */
  createdBy: string;
  updatedBy: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  foundAt: IsoDateTime | null;
  reunionStartedAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
  // Added fields
  rowVersion: number;
  firstPhotoId: string | null;
  photoCount: number;
  // Derived (server mapper)
  /** domain.joinName(firstName, lastName); "" when neither is set. */
  name: string;
  /** domain.postShort(reportingLocation, otherLocation). */
  postShort: string;
  // Added 2026-11-06 afternoon (Pending v8, Dani + Brian)
  /**
   * Where medical has the patient ("Chair 14"), free text ≤ 60, or null. Set with PATCH {medicalLocation}
   * once they are in medical; kept until someone edits it. Optional because rows cached on a phone before
   * this field existed (and a server from before it) do not carry it: read it as `row.medicalLocation ?? null`.
   */
  medicalLocation?: string | null;
  // Added 2026-11-06 evening (F5, the "Not found yet" hold; spec A59). Optional: rows cached before this build
  // (and a server from before it) do not carry them; read as `row.recheckAt ?? null`, `row.notFoundChecks ?? 0`.
  /**
   * While Waiting for check after a first Not found: when medical looks again (database clock), else null.
   * Due once it has passed; it never closes by itself. Clients flip held → due on their own clock.
   */
  recheckAt?: IsoDateTime | null;
  /** Not found answers in this round: 0, 1 while held, 2 after the final Not found (shown as "2 checks"). */
  notFoundChecks?: number;
  // Added 2026-11-07 (F6). Optional: rows cached before this build (and a database before F6) do not carry it.
  /**
   * Closed · inactive as a backlog (idle well past the hour when the job closed it: the first run after the
   * migration, or after the job was paused). Nobody is told: no Activity row, no push, and no in-app alert.
   */
  quietClose?: boolean;
  // Added 2026-11-08 (Companion). Optional: rows cached before this build (and a server from before it) do not
  // carry them; read as `row.friendInMedical ?? 'unsure'`, the rest `?? null`. Sync, detail and every mutation
  // response send them.
  /** Intake: "Is a friend already with them in medical?" ('unsure' by default). */
  friendInMedical?: FriendInMedical;
  /** The friend's name when friendInMedical is 'yes' (≤ 60), else null. */
  friendInMedicalName?: string | null;
  /** An open friend swap request (Accompanied only): when, and by whom (attribution string). */
  swapRequestedAt?: IsoDateTime | null;
  swapRequestedBy?: string | null;
  /** An approved swap: at the request's own tent / post ('fa') or Main Med ('mm'). */
  swapPlace?: SwapPlace | null;
  /** (Post-event) How the latest swap request ended while the request stayed Accompanied, or null. */
  swapClosed?: 'declined' | 'withdrawn' | 'cancelled' | null;
  // Added 2026-11-06 evening (F3 Messages + en route, spec §18 A55). All optional: rows cached on a phone
  // before them, and mutation responses (built by lp_row alone), do not carry them; the client keeps the
  // previous values then (sync-merge carryActivity). Sync and the detail always send them.
  /** Messages on the request (unsent ones never count). */
  messageCount?: number;
  /** When the latest message was written, or null. */
  lastMessageAt?: IsoDateTime | null;
  /** Other people's messages after the caller's read cursor (never the caller's own). */
  unread?: number;
  /**
   * Waiting for check, the latest message is from the Medical team, and nobody wrote or changed the status
   * since: front of house has a question to answer. Cleared by a front-of-house reply or any status change.
   */
  needsInfo?: boolean;
  /** The latest message, for the one-line preview on cards (text ≤ 120 characters). No other bodies in sync. */
  lastMessage?: LastMessage | null;
  /** Who is bringing the friend (In medical only), or null when nobody is. */
  enroute?: EnrouteSummary | null;
  /** The caller is involved in the request (lp_involved_staff): a new message from someone else alerts. */
  involved?: boolean;
}

/** RequestSummary.lastMessage (F3). */
export interface LastMessage {
  /** The sender's short name, "Rae C." (never the full name). */
  by: string;
  /** Written by the caller (any of their phones). Previews then say "You". */
  mine: boolean;
  /** The first 120 characters. */
  text: string;
}

/** RequestSummary.enroute (F3): one row for every staff member bringing the friend. */
export interface EnrouteSummary {
  /** How many are en route now (arrived rows not counted). */
  count: number;
  /** The earliest ETA among them, or null when none gave one. */
  earliestEta: IsoDateTime | null;
  /** 'arrived' as soon as anyone arrived (the friend is there). */
  state: 'enroute' | 'arrived';
  /** The caller's own en route, or null. `etaMinutes` is the pill chosen (0 = Now); `state` its own state. */
  mine: { etaAt: IsoDateTime | null; etaMinutes?: number | null; state?: 'enroute' | 'arrived' } | null;
}

/** One message of a thread (GET /api/requests/:id/messages). Plain text: never rendered as HTML. */
export interface ThreadMessage {
  id: string;
  /** Attribution "Name · Team" of the sender. */
  staff: string;
  /** "Rae C." */
  by: string;
  /** The sender's short team ("Medical", "GCHX Med Transpo"). */
  team: string;
  body: string;
  createdAt: IsoDateTime;
  /** Sent by the caller (any of their phones). */
  mine: boolean;
  /** The id the sending phone chose (matches its queued bubble). */
  clientMutationId: string;
}

/** Under my latest message: "Delivered", or "Read 4:14 PM" once someone else opened the thread after it. */
export interface ThreadReceipt {
  messageId: string;
  readAt: IsoDateTime | null;
}

/** RequestSummary's activity fields, all present (mutation responses of the messages routes). */
export type RequestActivityDto = Required<Pick<RequestSummary, 'messageCount' | 'lastMessageAt' | 'unread' | 'needsInfo' | 'lastMessage' | 'enroute' | 'involved'>>;

/** GET /api/requests/:id/messages[?beforeAt&beforeId]: oldest first. */
export interface ThreadPage {
  messages: ThreadMessage[];
  /** There are older messages ("Earlier messages"). */
  hasEarlier: boolean;
  /** Only on the first (latest) page, and only when the caller has written. */
  receipt: ThreadReceipt | null;
  activity: RequestActivityDto;
}

/** POST /api/requests/:id/messages → 201 when created, 200 for a retry of the same clientMutationId. */
export interface PostMessageResponse {
  created: boolean;
  message: ThreadMessage;
  activity: RequestActivityDto;
}

/** POST /api/requests/:id/messages/read, POST …/messages/:messageId/unsend, POST /api/requests/:id/enroute. */
export interface ActivityResponse {
  changed: boolean;
  activity: RequestActivityDto;
  /** En route only: the call was accepted but the request is not In medical, so nothing changed. */
  ignored?: boolean;
}

export interface PhotoInfo {
  id: string;
  timing: PhotoTimingAny;
  createdAt: IsoDateTime;
  /** Attribution string of who added it. */
  uploadedBy: string;
  /** False for legacy photos; GET /api/photos/:id?size=thumb then serves the full image. */
  hasThumb: boolean;
}

/**
 * Values in an `edit` audit entry: camelCase field → value (the changed fields). A35: a merged display
 * field comes whole, so a change to either half of the name carries firstName AND lastName, and a change to
 * either half of the post carries reportingLocation AND otherLocation (the unchanged half is equal in
 * previous and next). Render with domain.displayChanges(), which merges them and drops unchanged rows.
 */
export type AuditFieldValues = Partial<Record<EditableField, string | number | null>>;

interface AuditBase {
  id: string;
  at: IsoDateTime;
  /** Attribution string "Name · Team"; display with domain.parseStaff(). */
  staff: string;
  notes: string | null;
}

/**
 * One audit-trail entry with the action normalised (A1). Mapping rules for the server
 * (audit_events.action_type → action):
 *   patient_created                    → created  (next: post; Jeffrey's full-row new_value works too)
 *   status_changed                     → status   (previous.status from previous_value.status — present in
 *                                         both the new format and Jeffrey's full-row blobs; next.kind is
 *                                         null for legacy events)
 *   patient_updated                    → edit     (new format: the changed keys. Jeffrey's format: new_value
 *                                         is the patch and previous_value the full old row — keep only
 *                                         editable keys present in new_value whose value differs)
 *   photo_uploaded                     → photo
 *   cancelled                          → cancelled
 *   medical_search, outcome not_found  → legacy_search_not_found   ("Not in medical")
 *   medical_search_found               → legacy_search_found       ("In medical")
 *   check_completed                    → legacy_check              ("Not in medical (rechecked)")
 *   anything else                      → other (shown generically; never dropped from the trail)
 * snake_case keys are converted with domain.FIELD_COLUMNS; unknown keys are dropped.
 */
export type AuditEvent =
  | (AuditBase & {
      action: 'created';
      previous: null;
      next: { reportingLocation: string | null; otherLocation: string | null };
    })
  | (AuditBase & {
      action: 'status';
      /** (F5) `hold`: the request was on a "Not found yet" hold before this change. */
      previous: { status: StatusValue | null; hold?: AuditHold };
      /**
       * (F5) `held: true`: the first Not found that put the request on hold (status stays Waiting for check).
       * `hold`: the hold after this change (an Undo can put one back).
       */
      next: { status: StatusValue; kind: StatusKind | null; held?: boolean; hold?: AuditHold };
    })
  | (AuditBase & { action: 'edit'; previous: AuditFieldValues; next: AuditFieldValues })
  | (AuditBase & { action: 'photo'; previous: null; next: { photoId: string | null; timing: PhotoTimingAny | null } })
  | (AuditBase & { action: 'cancelled'; previous: { status: StatusValue | null }; next: { status: 'Cancelled' } })
  | (AuditBase & { action: 'legacy_search_not_found'; previous: null; next: { status: 'Checked – Not Found' } })
  | (AuditBase & { action: 'legacy_search_found'; previous: null; next: { status: 'Found – Awaiting Reunion' } })
  | (AuditBase & { action: 'legacy_check'; previous: { status: StatusValue | null }; next: { status: 'Checked – Not Found' } })
  | (AuditBase & { action: 'other'; previous: null; next: { actionType: string } });

export type AuditAction = AuditEvent['action'];

/** (F5) A "Not found yet" hold as an audit event records it: when the recheck is due, and the Not found count. */
export interface AuditHold {
  recheckAt: IsoDateTime;
  checks: number;
}

/** GET /api/requests/:id. Photos and audit are both oldest first (the profile shows the audit newest first). */
export interface RequestDetail extends RequestSummary {
  photos: PhotoInfo[];
  audit: AuditEvent[];
  /** (F3) The thread's latest page, with the receipt. Absent when it could not be read. */
  thread?: ThreadPage;
}

// ---------------------------------------------------------------------------------------------------
// Mutation envelopes (A1): `request` is always the full RequestSummary built by SQL lp_row.
// ---------------------------------------------------------------------------------------------------

/** POST /api/requests → 201 when created, 200 when it already existed (same clientMutationId). */
export interface CreateResponse {
  created: boolean;
  request: RequestSummary;
}

/** POST /api/requests/:id/status, PATCH /api/requests/:id, POST /api/requests/:id/cancel. */
export interface ChangeResponse {
  /** False for an idempotent repeat (already in that state / nothing changed). No Undo then (A11). */
  changed: boolean;
  request: RequestSummary;
}

/** POST /api/requests/:id/photos → 201 when created, 200 for a retry with the same photoId. */
export interface PhotoResponse {
  created: boolean;
  photo: PhotoInfo;
  request: RequestSummary;
}

// ---------------------------------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------------------------------

/**
 * GET /api/sync?since=<iso>&reconcile=0|1&afterAt=<iso>&afterId=<uuid>&limit=<n>, or ?ids=<uuid,…> (≤200).
 * Keyset-paged on (updatedAt, id) (A7). The client loops while `hasMore`, passing `next.at` / `next.id`
 * as afterAt / afterId with the SAME `since`, and keeps the FIRST page's `serverTime` as its new cursor,
 * advancing it only after every page is applied.
 *
 * Pass cursors verbatim, URL-encoded: build the query with URLSearchParams, i.e. syncPath() in
 * lib/client/api-paths.ts (a raw '+' in the offset decodes as a space). The server restores that one case
 * (syncQuerySchema), but clients must not depend on it.
 */
export interface SyncResponse {
  serverTime: IsoDateTime;
  rows: RequestSummary[];
  hasMore: boolean;
  next: { at: IsoDateTime; id: string } | null;
  /** With reconcile=1: [id, rowVersion] for every row. */
  versions?: Array<[string, number]>;
  /**
   * (F4, additive.) On the first page of a poll: how many requests have an unread Activity row for the
   * signed-in staff member (never their own actions), and a short fingerprint of their Activity (16 hex
   * characters) that moves whenever a row is added, changed or read, left out when nothing is unread (the
   * empty delta stays about 100 bytes). The client fetches the unread ids (GET /api/activity/unread) and,
   * with the inbox open, the list only when it moves, so a poll stays small. Absent when it could not be read
   * (the rows still sync) and from a server before F4.
   */
  activityUnread?: number;
  activityKey?: string;
  /**
   * (Events, additive.) The session's event: its stage and a version that moves on every settings or stage change.
   * Sent only when the request carries `ev` (the version the client holds, '' for none) and the version differs: the
   * client then re-reads GET /api/session; `stage` 'archived' means the event ended (writes answer 410 event_ended).
   */
  event?: { id: string; stage: EventStage; version: IsoDateTime };
}

// ---------------------------------------------------------------------------------------------------
// Stats (GET /api/stats → lp_stats(), spec §8 + A21)
// ---------------------------------------------------------------------------------------------------

export interface Stats {
  open: { waiting: number; inMedical: number };
  notInMedical: number;
  reunited: number;
  discharged: number;
  cancelled: number;
  total: number;
  longestWait: {
    id: string;
    caseNumber: number;
    reportingLocation: string;
    otherLocation: string | null;
    postShort: string;
    minutes: number;
  } | null;
  /** Mean minutes from logged to first answer, over answers in the last 2 hours; null if none. */
  avgAnswerMinutes: number | null;
  /**
   * v2.2 (dashboard Performance, Jeffrey 2026-11-06). Mean minutes from the In medical answer to Reunited, over
   * reunions in the last 2 hours; null if none.
   */
  avgReuniteMinutes: number | null;
  /** v2.2. Requests logged in the last 60 minutes (any status). */
  loggedLastHour: number;
  /**
   * The 4 fixed posts always (count may be 0), then one entry per other location with open rows: Other
   * grouped by otherLocation (case-insensitive), and a legacy post value (e.g. 'FA 3') as itself. The counts
   * add up to open.waiting + open.inMedical.
   */
  byPost: Array<{ reportingLocation: string; otherLocation: string | null; postShort: string; count: number }>;
  /** The 5 most recently updated requests. */
  recent: Array<{ id: string; caseNumber: number; name: string | null; status: StatusValue; postShort: string; updatedAt: IsoDateTime }>;
  serverTime: IsoDateTime;
  /** (F3, lp_enroute_stats) Requests In medical with someone bringing the friend now. Absent: show "—". */
  friendsEnRoute?: number;
  /** (F3) Mean minutes from en route to Arrived, over arrivals in the last 2 hours; null if none. */
  avgArriveMinutes?: number | null;
  /**
   * (F6, additive) Requests 'Closed – Inactive' now: closed by the server after an hour In medical with no activity.
   * Never a reunion (not in `reunited`, not in avgReuniteMinutes). Absent from a database before F6.
   */
  inactive?: number;
  /** (Companion, additive) Requests 'Closed – Friend Informed' now. Absent on a database before the companion migration. */
  friendInformed?: number;
}

// ---- (Events) GET /api/stats?range=… → lp_stats(p_event, p_range): the base snapshot above plus the dashboard's fields,
// in the event's time zone and show day. Post breakdowns are arrays ordered by count (the four busiest posts of the range
// by short name, then 'Other'), never fixed post keys.
/** '1h' | '2h' | '6h' | 'today' (since the current show day began) | 'event' | 'day:N' (show day N, from 1). */
export type EventStatsRange = '1h' | '2h' | '6h' | 'today' | 'event' | `day:${number}`;
/** One post of a breakdown: its short label, or 'Other' (everything past the four busiest, Other locations, legacy values). */
export interface PostCount {
  post: string;
  n: number;
}
export interface AttentionItem {
  id: string;
  caseNumber: number;
  /** The request's post (short), or 'Other'. */
  post: string;
  kind: 'wait' | 'recheck' | 'located' | 'swap';
  /**
   * Logged (wait), the re-check due time (recheck), the Located answer (located) or (Companion) when the friend
   * swap was requested (swap: red 10 min after).
   */
  since: IsoDateTime;
  enroute: boolean;
  etaAt: IsoDateTime | null;
}
export interface SpeedStat {
  key: 'firstCheck' | 'located' | 'reunited';
  target: number;
  n: number;
  median: number | null;
  p90: number | null;
  prevMedian: number | null;
  /** The range's posts, in EventStats.range.posts order. */
  byPost: Array<{ post: string; n: number; median: number | null }>;
  /** `day`: the show day (YYYY-MM-DD) of an 'event' bucket, else null. */
  spark: Array<{ at: IsoDateTime; day: string | null; n: number; median: number | null; p90: number | null }>;
}
export interface CallsBucket {
  at: IsoDateTime;
  /** 'event' only: the show day (YYYY-MM-DD). */
  day: string | null;
  n: number;
  posts: PostCount[];
  /** The same clock bucket the show day before (null when not compared). */
  prev: number | null;
}
export interface HeatCol {
  /** A bucket start; for 'event' a local clock hour (0–23) summed over every show day instead. */
  at?: IsoDateTime;
  hour?: number;
  n: number;
  posts: PostCount[];
}
export interface EventStats extends Stats {
  range?: {
    key: EventStatsRange;
    from: IsoDateTime;
    /** The end of a 'day:N' range; null for the others (they run to now). */
    to: IsoDateTime | null;
    step: number;
    compare: boolean;
    /** N for 'day:N', else null. */
    day: number | null;
    /** The posts of this range, by count (the four busiest by name, then 'Other' when it has rows). Every breakdown below follows this order. */
    posts: PostCount[];
  };
  /** Open, split: no first check yet / on a re-check hold / Located, friend not here yet. */
  live?: { waiting: number; pending: number; located: number };
  attention?: { total: number; items: AttentionItem[] };
  speed?: SpeedStat[];
  calls?: { total: number; prevTotal: number | null; buckets: CallsBucket[] };
  heat?: { step: number; cols: HeatCol[] };
  recap?: {
    reunited: number;
    notLocated: number;
    fastest: number | null;
    prevReunited: number | null;
    prevNotLocated: number | null;
    prevFastest: number | null;
    lastReunionAt: IsoDateTime | null;
  };
  /** People with activity in the last 10 minutes, per team: the event's team ids in setup order, plus 'other'. */
  team?: Array<{ team: string; on: number }>;
}

// ---------------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------------

/**
 * GET /api/session (200) and POST /api/session (200): both return exactly this, expiresAt included. POST
 * computes expiresAt from the claims of the cookie it just issued (exp, in seconds → ISO).
 */
export interface SessionInfo {
  /** (Events) 'staff' works one event; 'lead' sees every event and sets them up. */
  role: SessionRole;
  /** (Events) The event this session works, or null for a lead who has not opened one. */
  eventId: string | null;
  /** (Events) That event's config, or null. */
  event: EventConfig | null;
  staffName: string;
  /** Canonical team value (a card value, a canonicalised alias, or the custom "Other team" text). */
  team: string;
  /** Attribution string "staffName · team". */
  staff: string;
  /** When the current cookie expires (12 h idle, never past the 36 h absolute cap). */
  expiresAt: IsoDateTime;
}

/** The POST /api/session response: the same SessionInfo as GET (expiresAt is required). */
export type SignInResponse = SessionInfo;

// ---------------------------------------------------------------------------------------------------
// Events (multi-event foundation, phase 1)
// ---------------------------------------------------------------------------------------------------

export type SessionRole = 'staff' | 'lead';
export type EventStage = 'practice' | 'live' | 'archived';

/** A reporting post: `label` is what a request stores as its reporting location. */
export interface EventPost {
  id: string;
  label: string;
  short: string;
}

/** A sign-in team: `label` is the team the session (and every attribution string) stores. */
export interface EventTeam {
  id: string;
  label: string;
  short: string;
  /** Exactly one team may be the medical team (needs-info, push defaults, isMedicalTeam). */
  medical: boolean;
  /**
   * (Phase 2, additive) Labels this team had before it was renamed under the same id: what was stored, and sessions
   * signed in, under them still belong to it. Kept by the server; never sent by a lead.
   */
  aliases?: string[];
}

/**
 * The event config the client renders from (GET /api/session `event`, refreshed when sync's `event.version`
 * moves). No secret, hash or join code is ever in it.
 */
export interface EventConfig {
  id: string;
  slug: string;
  name: string;
  /** YYYY-MM-DD, the first and last show day. */
  startsOn: string;
  endsOn: string;
  /** IANA time zone of every displayed time and the show-day boundary. */
  timezone: string;
  /** A show day runs from this local hour to the same hour next day (default 6). */
  dayStartHour: number;
  stage: EventStage;
  /** GET URL of the event logo, or null. */
  logoUrl: string | null;
  posts: EventPost[];
  /** What a swap place 'mm' is called ("Main Med"). */
  mainMedical: string;
  teams: EventTeam[];
  /** The "Last seen" chips, in order. */
  lastSeen: string[];
  wentLiveAt: IsoDateTime | null;
  endedAt: IsoDateTime | null;
  /** Bumped by every settings or stage change (compare with sync's `event.version`). */
  updatedAt: IsoDateTime;
}

/** A lead's view of an event (GET /api/events, the setup routes): the config plus setup state and counts. */
export interface EventAdmin extends EventConfig {
  hasStaffPassword: boolean;
  /** When the current join link stops working, or null when there is none. */
  joinLinkExpiresAt: IsoDateTime | null;
  /** The last LP number handed out (0 = none yet). */
  caseSeq: number;
  recordsDeleteAt: IsoDateTime | null;
  recordsDeletedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  /** GET /api/events only. */
  requests?: number;
  open?: number;
}

/** What a staff member sees when their event has ended (410 event_ended from sign-in or any write). */
export interface EndedEvent {
  /** (Phase 2, additive) The event's id: the client drops that event's local data (cache, outbox). */
  id?: string;
  name: string;
  logoUrl: string | null;
  stage: 'archived';
}

// ---------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------

/**
 * Every failure is `{error: {code, message, id?}}` (spec §6). HTTP status by code:
 *   bad_request 400 · unauthorized 401 · forbidden 403 (creator-only) · bad_origin 403 · not_found 404 ·
 *   too_large 413 · unsupported_media 415 · conflict 409 · invalid 422 · photo_limit 422 ·
 *   rate_limited 429 · unavailable 503 (generic message + error id)
 */
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'bad_origin'
  | 'not_found'
  | 'too_large'
  | 'unsupported_media'
  | 'conflict'
  | 'invalid'
  | 'photo_limit'
  | 'rate_limited'
  | 'unavailable'
  /** (Events) 410: the event is archived. Staff are refused on every route (reads too); a lead only on writes. */
  | 'event_ended'
  /** (Events) 409: a lead session with no event open called an event route. */
  | 'no_event';

export interface ApiError {
  error: {
    code: ApiErrorCode;
    /** Safe to show; never contains request data. */
    message: string;
    /** Correlates with the server log line (503s always carry one). */
    id?: string;
    /** For `invalid`: the offending field (camelCase), when known. */
    field?: string;
    /** For `conflict`: the row's current status (from the P0409 HINT). */
    currentStatus?: string;
    /** For `rate_limited`: seconds until a retry is allowed (also sent as Retry-After). */
    retryAfterSeconds?: number;
    /** (Events) For `event_ended`: the ended event, for the Ended screen. */
    event?: EndedEvent;
  };
}

// ---------------------------------------------------------------------------------------------------
// Outbox (A13: every create is an outbox job, persisted in IndexedDB before it is sent)
// ---------------------------------------------------------------------------------------------------

export interface OutboxPhoto {
  /** Client UUID; the upload is idempotent on it. */
  photoId: string;
  /** Compressed full image (JPEG, ≤ 2.5 MB). */
  blob: Blob;
  /** Compressed thumbnail (JPEG, ≤ 320 px). */
  thumbBlob: Blob;
  timing: PhotoTiming;
  /** Checkpoint: the server confirmed this photo (or it was definitively rejected and reported). */
  acked: boolean;
  /** Set when the server definitively rejected this photo (the job still completes, with a toast). */
  rejected?: boolean;
}

export type OutboxState =
  /** Waiting for its turn / its next retry. */
  | 'pending'
  /** The single worker is sending it now. */
  | 'sending'
  /** The create got a definitive 4xx: the user can open it, fix it and resend (same mutationId), or discard. */
  | 'needs_attention';

export interface OutboxItem {
  /** = payload.clientMutationId. Stable for the life of the job, including resends after edits. */
  mutationId: string;
  payload: CreateRequestBody;
  photos: OutboxPhoto[];
  /** Checkpoint: the server id once the create succeeded (photos may still be uploading). */
  serverId: string | null;
  caseNumber: number | null;
  state: OutboxState;
  attempts: number;
  /** Epoch ms on this device (scheduling only). Backoff 5 s, 15 s, 60 s, then every 2 min. */
  nextAttemptAt: number | null;
  lastError: {
    code: ApiErrorCode | 'network' | 'timeout';
    message: string;
    status: number | null;
    /**
     * For a definitive `invalid` (422): the field the server rejected, copied from ApiError.error.field
     * (camelCase, e.g. 'otherLocation', 'name'). The needs-attention editor passes it to RequestForm `errors`.
     */
    field?: string;
  } | null;
  /** Who saved it on this phone. The server attributes it to whoever is signed in when it sends. */
  operator: { staffName: string; team: string; staff: string };
  /** Epoch ms on this device (display only: "Waiting to send" rows sort on it). */
  createdAt: number;
  /** 'legacy' = imported from Jeffrey's localStorage['edc_pending_queue']. */
  source: 'app' | 'legacy';
  /**
   * (Events, additive) The event it was saved in: it only ever goes to that event (absent: before events). A job saved
   * while that event was in practice (`wentLiveAt` then) is dropped once the event goes live: its request was a
   * practice one.
   */
  eventId?: string;
  /** (Events) The event's wentLiveAt when the job was saved (null: in practice). */
  wentLiveAt?: string | null;
}

export type { CreateRequestBody, RequestPatch };

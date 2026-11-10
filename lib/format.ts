// Display formatting. Every time is shown in the EVENT's time zone (EventConfig.timezone), never the phone's. Pure and
// isomorphic. Callers pass the zone; the default (UTC) is only for a caller with no event at all.

/** (Events) Only when no event's zone is known: every screen passes its event's (EventConfig.timezone). */
export const FALLBACK_TIMEZONE = 'UTC';

type Instant = string | number | Date;

const toDate = (value: Instant): Date => (value instanceof Date ? value : new Date(value));

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    formatters.set(key, f);
  }
  return f;
}

function parts(value: Instant, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatter(timeZone, options).formatToParts(toDate(value))) out[p.type] = p.value;
  return out;
}

/** "LP-1004" (at least 4 digits, like Jeffrey's app). */
export function formatCaseNumber(caseNumber: number): string {
  return `LP-${String(caseNumber).padStart(4, '0')}`;
}

/** Search helper: "1012", "lp1012", "LP-1012", "lp 1012" → 1012; anything else → null. */
export function parseCaseNumberQuery(query: string): number | null {
  const m = /^\s*(?:lp[\s-]?)?(\d{1,9})\s*$/i.exec(query);
  return m ? Number(m[1]) : null;
}

/** Calendar date in the event timezone, "2026-11-06". */
export function eventDate(value: Instant, timeZone = FALLBACK_TIMEZONE): string {
  const p = parts(value, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

export function isSameEventDay(a: Instant, b: Instant, timeZone = FALLBACK_TIMEZONE): boolean {
  return eventDate(a, timeZone) === eventDate(b, timeZone);
}

/** "11:10", "9:58" — 12-hour clock without AM/PM, as in the mockups. */
export function formatClock(value: Instant, timeZone = FALLBACK_TIMEZONE): string {
  const p = parts(value, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute}`;
}

/** List time: "h:mm" for today; weekday-prefixed for an earlier day, e.g. "Fri 9:58". */
export function formatListTime(value: Instant, now: Instant = Date.now(), timeZone = FALLBACK_TIMEZONE): string {
  const clock = formatClock(value, timeZone);
  if (isSameEventDay(value, now, timeZone)) return clock;
  const { weekday } = parts(value, timeZone, { weekday: 'short' });
  return `${weekday} ${clock}`;
}

/** Audit trail / photo viewer time: "Nov 6, 11:10 PM". */
export function formatAuditTime(value: Instant, timeZone = FALLBACK_TIMEZONE): string {
  const p = parts(value, timeZone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** Whole minutes from `from` to `now`, never negative (clock skew). */
export function minutesSince(from: Instant, now: Instant = Date.now()): number {
  const ms = toDate(now).getTime() - toDate(from).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60_000)) : 0;
}

/** Compact duration, as in the mockups: under 1 min "now", then "12m", then whole hours "1h". */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'now';
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** "Too many attempts. Try again in N min" — minutes rounded up, at least 1. */
export function retryMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

// ---------------------------------------------------------------------------------------------------
// All requests log (log option B, 2026-11-06): "Created" with AM/PM and a compact "Updated".
// ---------------------------------------------------------------------------------------------------

/** "11:02 PM", "12:05 AM", "12:30 PM": 12-hour clock with AM/PM, in the event timezone. */
export function formatClockAmPm(value: Instant, timeZone = FALLBACK_TIMEZONE): string {
  const p = parts(value, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toUpperCase()}`;
}

const DAY_MS = 86_400_000;

/** Whole calendar days between two event-timezone dates ("2026-11-06" → "2026-11-08" is 2). */
function eventDayGap(earlier: Instant, later: Instant, timeZone: string): number {
  const a = Date.parse(`${eventDate(earlier, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${eventDate(later, timeZone)}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

/**
 * The log's "Created" column: "11:02 PM" on the event day it is now; "Thu 11:02 PM" for an earlier day in
 * the last week (a request logged before midnight and seen after it gets its weekday); "Oct 30 9:41 PM"
 * before that.
 */
export function formatCreatedTime(value: Instant, now: Instant = Date.now(), timeZone = FALLBACK_TIMEZONE): string {
  const clock = formatClockAmPm(value, timeZone);
  if (isSameEventDay(value, now, timeZone)) return clock;
  const gap = eventDayGap(value, now, timeZone);
  if (gap > 0 && gap < 7) {
    const { weekday } = parts(value, timeZone, { weekday: 'short' });
    return `${weekday} ${clock}`;
  }
  const { month, day } = parts(value, timeZone, { month: 'short', day: 'numeric' });
  return `${month} ${day} ${clock}`;
}

/** Compact age, as GitHub lists show it (no "ago"): under a minute "now", then "2m", "1h", "3d". */
export function formatAgoShort(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'now';
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1_440)}d`;
}

/** The same age as a screen reader says it: "just now", "2 minutes ago", "1 hour ago", "3 days ago". */
export function agoPhrase(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  const [n, unit] =
    minutes < 60
      ? [Math.floor(minutes), 'minute']
      : minutes < 1_440
        ? [Math.floor(minutes / 60), 'hour']
        : [Math.floor(minutes / 1_440), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/** Shown under "Updated" when nothing changed since the request was logged. */
export const NOT_UPDATED = '—';

/**
 * True once the row changed after it was logged. The database stamps created_at and updated_at with the
 * same now() on insert, and every later write (status, edit, photo) moves updated_at forward.
 */
export function wasUpdated(createdAt: Instant, updatedAt: Instant | null | undefined): boolean {
  if (updatedAt === null || updatedAt === undefined || updatedAt === '') return false;
  const c = toDate(createdAt).getTime();
  const u = toDate(updatedAt).getTime();
  return Number.isFinite(c) && Number.isFinite(u) && u > c;
}

/** The log's "Updated" column: "—" when unchanged since it was logged, else "now", "2m", "1h", "3d". */
export function formatUpdatedAgo(createdAt: Instant, updatedAt: Instant | null | undefined, now: Instant = Date.now()): string {
  return wasUpdated(createdAt, updatedAt) ? formatAgoShort(minutesSince(updatedAt as Instant, now)) : NOT_UPDATED;
}

/** The "Updated" column for a screen reader: "updated 2 minutes ago", or "not updated yet". */
export function updatedPhrase(createdAt: Instant, updatedAt: Instant | null | undefined, now: Instant = Date.now()): string {
  return wasUpdated(createdAt, updatedAt) ? `updated ${agoPhrase(minutesSince(updatedAt as Instant, now))}` : 'not updated yet';
}

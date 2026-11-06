// Display formatting. Every time is shown in the EVENT timezone (spec §3 EVENT_TIMEZONE, default
// America/New_York), never the phone's. Pure and isomorphic.
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones.

export const DEFAULT_EVENT_TIMEZONE = 'America/New_York';

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
export function eventDate(value: Instant, timeZone = DEFAULT_EVENT_TIMEZONE): string {
  const p = parts(value, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

export function isSameEventDay(a: Instant, b: Instant, timeZone = DEFAULT_EVENT_TIMEZONE): boolean {
  return eventDate(a, timeZone) === eventDate(b, timeZone);
}

/** "11:10", "9:58" — 12-hour clock without AM/PM, as in the mockups. */
export function formatClock(value: Instant, timeZone = DEFAULT_EVENT_TIMEZONE): string {
  const p = parts(value, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute}`;
}

/** List time: "h:mm" for today; weekday-prefixed for an earlier day, e.g. "Fri 9:58". */
export function formatListTime(value: Instant, now: Instant = Date.now(), timeZone = DEFAULT_EVENT_TIMEZONE): string {
  const clock = formatClock(value, timeZone);
  if (isSameEventDay(value, now, timeZone)) return clock;
  const { weekday } = parts(value, timeZone, { weekday: 'short' });
  return `${weekday} ${clock}`;
}

/** Audit trail / photo viewer time: "Nov 6, 11:10 PM". */
export function formatAuditTime(value: Instant, timeZone = DEFAULT_EVENT_TIMEZONE): string {
  const p = parts(value, timeZone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** CSV time: "2026-11-06 23:10" (24-hour) in the event timezone; "" for null. */
export function formatCsvTime(value: Instant | null | undefined, timeZone = DEFAULT_EVENT_TIMEZONE): string {
  if (value === null || value === undefined || value === '') return '';
  const p = parts(value, timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
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

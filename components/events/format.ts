// (Events, lead screens) Display helpers: an event's dates, its time zone, the show day's start hour, the logo's
// initials. Pure; unit-tested with the form logic.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
}

/**
 * "Nov 14–15" (same month), "Oct 31 – Nov 2" (two months), "Nov 14" (one day); `year` adds ", 2026"; two years
 * always show both ("Dec 31, 2026 – Jan 1, 2027").
 */
export function formatDates(startsOn: string, endsOn: string, year = false): string {
  const a = parts(startsOn);
  const b = parts(endsOn);
  if (!a || !b) return '';
  const md = (p: { m: number; d: number }) => `${MONTHS[p.m]} ${p.d}`;
  if (a.y !== b.y) return `${md(a)}, ${a.y} – ${md(b)}, ${b.y}`;
  const y = year ? `, ${a.y}` : '';
  if (a.m === b.m && a.d === b.d) return `${md(a)}${y}`;
  if (a.m === b.m) return `${md(a)}–${b.d}${y}`;
  return `${md(a)} – ${md(b)}${y}`;
}

/** The time zones offered first, with the names people use. Any other IANA zone still shows as itself. */
export const TIME_ZONES: ReadonlyArray<{ id: string; label: string; short: string }> = [
  { id: 'America/New_York', label: 'Eastern', short: 'ET' },
  { id: 'America/Chicago', label: 'Central', short: 'CT' },
  { id: 'America/Denver', label: 'Mountain', short: 'MT' },
  { id: 'America/Phoenix', label: 'Arizona', short: 'MST' },
  { id: 'America/Los_Angeles', label: 'Pacific', short: 'PT' },
  { id: 'America/Anchorage', label: 'Alaska', short: 'AKT' },
  { id: 'Pacific/Honolulu', label: 'Hawaii', short: 'HST' },
  { id: 'America/Puerto_Rico', label: 'Atlantic', short: 'AST' },
  { id: 'America/Toronto', label: 'Toronto', short: 'ET' },
  { id: 'America/Mexico_City', label: 'Mexico City', short: 'CST' },
  { id: 'Europe/London', label: 'London', short: 'UK' },
  { id: 'Europe/Paris', label: 'Central Europe', short: 'CET' },
  { id: 'Australia/Sydney', label: 'Sydney', short: 'AET' },
  { id: 'Asia/Tokyo', label: 'Tokyo', short: 'JST' },
  { id: 'UTC', label: 'UTC', short: '' },
];

/** The zone's name and short form ("Eastern", "ET"); an unlisted zone is its own id. */
export function zoneLabel(id: string): { label: string; short: string } {
  const z = TIME_ZONES.find((t) => t.id === id);
  return z ? { label: z.label, short: z.short } : { label: id.replace(/_/g, ' '), short: '' };
}

/** The zones to offer: the list, plus `current` when it is not in it. */
export function zoneOptions(current: string): ReadonlyArray<{ id: string; label: string; short: string }> {
  return TIME_ZONES.some((t) => t.id === current) || !current ? TIME_ZONES : [{ id: current, ...zoneLabel(current) }, ...TIME_ZONES];
}

/** The browser's zone when it is one of the list, else Eastern. */
export function defaultZone(): string {
  try {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (TIME_ZONES.some((t) => t.id === here)) return here;
  } catch {
    // no Intl zone: the default
  }
  return 'America/New_York';
}

/** 6 → "6:00 AM", 0 → "12:00 AM", 13 → "1:00 PM". */
export function hourLabel(h: number): string {
  return `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Warped Tour Orlando" → "WT"; "EDC" → "ED"; "" → "?" (a logo tile without a logo). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return '?';
  if (words.length === 1) return [...words[0]!.replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('').toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, '')][0] ?? '')
    .join('')
    .toUpperCase();
}

/** Today in the browser's zone (YYYY-MM-DD). */
export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "Nov 17" for a join link's expiry (in the event's zone). */
export function shortDate(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));
  }
}

/** (Grace period) Time left in a window: "23 h 12 m", "42 m", "<1 m"; "" once it is over. */
export function formatLeft(ms: number): string {
  if (!(ms > 0)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1 m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} m` : `${m} m`;
}

/** The same, spoken: "23 hours 12 minutes", "1 hour", "less than a minute". */
export function spokenLeft(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  return [h ? part(h, 'hour') : '', m ? part(m, 'minute') : ''].filter(Boolean).join(' ');
}

/**
 * (Grace period) What a Reopen of an archived event keeps at `nowMs`: its staff password and join link while inside
 * the 24 h after End (holdUntil), each only if it had one (a join link only while it has not expired).
 */
export function reopenKeeps(
  event: { holdUntil: string | null; hasStaffPassword: boolean; joinLinkExpiresAt: string | null },
  nowMs: number,
): { held: boolean; leftMs: number; password: boolean; joinLink: boolean } {
  const until = event.holdUntil ? Date.parse(event.holdUntil) : Number.NaN;
  const leftMs = Number.isFinite(until) ? Math.max(0, until - nowMs) : 0;
  const held = leftMs > 0;
  const linkUntil = event.joinLinkExpiresAt ? Date.parse(event.joinLinkExpiresAt) : Number.NaN;
  return { held, leftMs, password: held && event.hasStaffPassword, joinLink: held && Number.isFinite(linkUntil) && linkUntil > nowMs };
}

/** The 24 h an End keeps the staff password and join link for a Reopen (the server's hold). */
export const END_HOLD_MS = 24 * 3_600_000;

/**
 * (Grace period) What an End of a live event keeps for a Reopen, at `nowMs`: the staff password if it has one, and
 * the join link if it has one that still works, for the 24 h hold or until the link expires, whichever is first.
 */
export function endKeeps(
  event: { hasStaffPassword: boolean; joinLinkExpiresAt: string | null },
  nowMs: number,
): { password: boolean; joinLinkMs: number } {
  const linkUntil = event.joinLinkExpiresAt ? Date.parse(event.joinLinkExpiresAt) : Number.NaN;
  const joinLinkMs = Number.isFinite(linkUntil) ? Math.min(END_HOLD_MS, Math.max(0, linkUntil - nowMs)) : 0;
  return { password: event.hasStaffPassword, joinLinkMs };
}

/** The End sheet's sentence (its screen-reader description), true to what the event has. */
export function endFact(k: { password: boolean; joinLinkMs: number }): string {
  const kept = [k.password ? 'password' : '', k.joinLinkMs > 0 ? 'join link' : ''].filter(Boolean).join(' and ');
  return `Staff are signed out and nothing is deleted; within 24 hours it can be reopened${kept ? ` with the same ${kept}` : ''}.`;
}

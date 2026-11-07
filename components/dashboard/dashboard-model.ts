// Pure helpers for the dashboard (spec §8 Dashboard; design/screens/polish-v7.html Tiles / Posts / Recent /
// Perf). Unit-tested in tests/unit/dashboard/dashboard-model.test.ts.
import type { Stats } from '@/lib/api-types';
import { minutesSince } from '@/lib/format';

/** Shown for a value the server did not send or could not compute (null, missing, NaN, negative). */
export const NO_VALUE = '—';

/** One run of big digits and its small unit: "24" + "m", or "1" + "h", "35" + "m". */
export interface ValuePart {
  value: string;
  unit: string;
}

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A duration in minutes as digit/unit runs: "<1"m, "24"m, "1"h "35"m, "2"h; null when unknown. */
export function durationParts(minutes: number | null | undefined): ValuePart[] | null {
  if (!known(minutes)) return null;
  if (minutes < 1) return [{ value: '<1', unit: 'm' }];
  const m = Math.round(minutes);
  if (m < 60) return [{ value: String(m), unit: 'm' }];
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? [{ value: String(h), unit: 'h' }, { value: String(rest), unit: 'm' }] : [{ value: String(h), unit: 'h' }];
}

/** The same duration for screen readers: "under a minute", "24 minutes", "1 hour 35 minutes"; null when unknown. */
export function durationPhrase(minutes: number | null | undefined): string | null {
  if (!known(minutes)) return null;
  if (minutes < 1) return 'under a minute';
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [h ? unit(h, 'hour') : '', rest || !h ? unit(rest, 'minute') : ''].filter(Boolean).join(' ');
}

/** A count as digits; null when unknown. */
export function countParts(count: number | null | undefined): ValuePart[] | null {
  return known(count) ? [{ value: String(Math.round(count)), unit: '' }] : null;
}

/**
 * Closed = Not in medical + Reunited + Discharged + Cancelled (v2.2: Not in medical counts as closed) + (F6) Closed ·
 * inactive (0 when the server does not send it).
 */
export function closedTotal(stats: Pick<Stats, 'notInMedical' | 'reunited' | 'discharged' | 'cancelled' | 'inactive'>): number {
  return stats.notInMedical + stats.reunited + stats.discharged + stats.cancelled + inactiveCount(stats);
}

/** (F6) The Closed · inactive count, 0 when absent (a database before F6) or not a count. */
export function inactiveCount(stats: Pick<Stats, 'inactive'>): number {
  const n = stats.inactive;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/** The Reunited tile's small grey line: "+1 discharged · 1 cancelled", or null when both are 0. */
export function closedSubline(stats: Pick<Stats, 'discharged' | 'cancelled'>): string | null {
  const parts: string[] = [];
  if (stats.discharged > 0) parts.push(`${stats.discharged} discharged`);
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled`);
  return parts.length > 0 ? `+${parts.join(' · ')}` : null;
}

/** The same line for screen readers: "plus 1 discharged and 1 cancelled", or null. */
export function closedSublinePhrase(stats: Pick<Stats, 'discharged' | 'cancelled'>): string | null {
  const parts: string[] = [];
  if (stats.discharged > 0) parts.push(`${stats.discharged} discharged`);
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled`);
  return parts.length > 0 ? `plus ${parts.join(' and ')}` : null;
}

/** Last-updated times, as in the log: "now", "2m", "1h", "3d" (never "ago"). */
export function formatAgo(iso: string, now: number): string {
  const m = minutesSince(iso, now);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / (24 * 60))}d`;
}

/** The same time for screen readers: "just now", "2 minutes ago", "1 hour ago", "3 days ago". */
export function agoPhrase(iso: string, now: number): string {
  const m = minutesSince(iso, now);
  const ago = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (m < 1) return 'just now';
  if (m < 60) return ago(m, 'minute');
  if (m < 24 * 60) return ago(Math.floor(m / 60), 'hour');
  return ago(Math.floor(m / (24 * 60)), 'day');
}

/** Bar length as a share of the full-width track: the busiest post fills it (the count has its own column). */
export function barPercent(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.round((Math.min(value, max) / max) * 1000) / 10;
}

/** Open by post, busiest first; ties keep the server's order (the fixed posts, then other locations). */
export function postsBusiestFirst<T extends { count: number }>(posts: readonly T[]): T[] {
  return posts
    .map((p, i) => [p, i] as const)
    .sort((a, b) => b[0].count - a[0].count || a[1] - b[1])
    .map(([p]) => p);
}

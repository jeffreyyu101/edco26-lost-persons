// Pure helpers for the dashboard (spec §8 Dashboard, design/screens/dashboard.html). Unit-tested in
// tests/unit/dashboard/dashboard-model.test.ts.
import type { Stats } from '@/lib/api-types';
import { formatListTime, minutesSince } from '@/lib/format';

/** Tile values: "–" when unknown, "<1m", "24m", "1h 35m", "2h". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return '–';
  if (minutes < 1) return '<1m';
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** The Reunited tile's second line: "+1 discharged, 1 cancelled", or null when both are 0. */
export function closedSubline(stats: Pick<Stats, 'discharged' | 'cancelled'>): string | null {
  const parts: string[] = [];
  if (stats.discharged > 0) parts.push(`${stats.discharged} discharged`);
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled`);
  return parts.length > 0 ? `+${parts.join(', ')}` : null;
}

/** "Recently updated" times: "now", "2m", "3h", then the list format for older ones ("Fri 9:58"). */
export function formatAgo(iso: string, now: number, timeZone: string): string {
  const m = minutesSince(iso, now);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 12 * 60) return `${Math.floor(m / 60)}h`;
  return formatListTime(iso, now, timeZone);
}

/** Bar length as a share of the track (the longest bar fills 82%, leaving room for the value). */
export function barPercent(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.round((Math.min(value, max) / max) * 82 * 10) / 10;
}

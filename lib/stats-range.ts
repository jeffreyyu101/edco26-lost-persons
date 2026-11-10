// Dashboard time ranges (GET /api/stats?range=, lp_stats(p_event, p_range)). The live dashboard's control; an archived
// event's dashboard picks 'event' (All) or one show day ('day:N') instead.
import type { EventStatsRange } from './api-types';

export type LiveRange = '1h' | '2h' | '6h' | 'today' | 'event';
export const STATS_RANGES = ['1h', '2h', '6h', 'today', 'event'] as const satisfies readonly LiveRange[];
export const STATS_RANGE_LABEL: Readonly<Record<LiveRange, string>> = { '1h': '1h', '2h': '2h', '6h': '6h', today: 'Today', event: 'Event' };
export const DEFAULT_STATS_RANGE: LiveRange = 'today';

export const isStatsRange = (v: unknown): v is LiveRange => typeof v === 'string' && (STATS_RANGES as readonly string[]).includes(v);

/** Any range the server takes: the live ones and 'day:N' (show day N, from 1). */
export const isEventStatsRange = (v: unknown): v is EventStatsRange => isStatsRange(v) || (typeof v === 'string' && /^day:[1-9][0-9]{0,2}$/.test(v));

/** A range's words for a heading ("Today", "Sat"); a show day reads as its weekday when known. */
export function rangeLabel(range: EventStatsRange, dayNames: readonly string[] = []): string {
  if (isStatsRange(range)) return STATS_RANGE_LABEL[range];
  const n = Number(range.slice(4));
  return dayNames[n - 1] ?? `Day ${n}`;
}

// Dashboard v4 time ranges (GET /api/stats?range=, lp_stats(p_range)). Shared by the route and the dashboard.
import type { StatsRange } from './api-types';

export const STATS_RANGES = ['1h', '2h', '6h', 'tonight', 'event'] as const satisfies readonly StatsRange[];
export const STATS_RANGE_LABEL: Readonly<Record<StatsRange, string>> = { '1h': '1h', '2h': '2h', '6h': '6h', tonight: 'Tonight', event: 'Event' };
export const DEFAULT_STATS_RANGE: StatsRange = 'tonight';

export const isStatsRange = (v: unknown): v is StatsRange => typeof v === 'string' && (STATS_RANGES as readonly string[]).includes(v);

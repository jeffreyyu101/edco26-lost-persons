// PHASE2: the current dashboard against the events server. GET /api/stats now answers EventStats (lp_stats(p_event,
// p_range): 'today' instead of 'tonight', show days instead of nights, post breakdowns as arrays ordered by count);
// the dashboard still reads the old Stats shape with fixed FA 4 / FA 3 / Other buckets. This converts one into the
// other at the fetch, so the dashboard runs unchanged until phase 2 makes it read EventStats directly (any number of
// posts) and deletes this file. A post whose short label is 'FA 4' / 'FA 3' keeps its bucket; every other post
// counts as Other (exact for the counts; a combined Other median is not recomputable, see speedByTent).
import type { CallsBucket, EventStats, HeatCol, PostCount, SpeedStat, Stats, StatsRange, TentCounts } from '../api-types';

type Tent = 'FA 4' | 'FA 3' | 'Other';

/** PHASE2: the range the server takes for the dashboard's (the old 'tonight' is the show day: 'today'). */
export function serverRange(range: StatsRange): string {
  return range === 'tonight' ? 'today' : range;
}

function tentCounts(posts: readonly PostCount[] | undefined, total?: number): TentCounts {
  const list = posts ?? [];
  const fa4 = list.find((p) => p.post === 'FA 4')?.n ?? 0;
  const fa3 = list.find((p) => p.post === 'FA 3')?.n ?? 0;
  const sum = list.reduce((a, p) => a + p.n, 0);
  return { fa4, fa3, other: Math.max(0, (total ?? sum) - fa4 - fa3) };
}

function speedByTent(byPost: ReadonlyArray<{ post: string; n: number; median: number | null }> | undefined): Record<Tent, number | null> {
  const list = byPost ?? [];
  const median = (post: string) => list.find((p) => p.post === post)?.median ?? null;
  // Other: the one remaining post with answers when there is exactly one, else the 'Other' entry (null when absent).
  const rest = list.filter((p) => p.post !== 'FA 4' && p.post !== 'FA 3' && p.n > 0);
  return { 'FA 4': median('FA 4'), 'FA 3': median('FA 3'), Other: rest.length === 1 ? (rest[0]?.median ?? null) : median('Other') };
}

/** PHASE2: EventStats → the Stats the dashboard reads. */
export function legacyStats(raw: EventStats | Stats | null | undefined): Stats {
  const s = (raw ?? {}) as EventStats & Partial<Stats>;
  const out = { ...s } as unknown as Stats;
  if (s.range && 'posts' in s.range) {
    const k: string = s.range.key;
    const key = k === 'today' ? 'tonight' : k;
    out.range = { key: key as StatsRange, from: s.range.from, step: s.range.step, compare: s.range.compare };
  }
  if (s.attention) {
    out.attention = {
      total: s.attention.total,
      items: s.attention.items.map(({ post, ...item }) => ({ ...item, tent: post })),
    };
  }
  if (s.speed) {
    out.speed = s.speed.map(({ byPost, spark, ...k }): SpeedStat => ({
      ...k,
      byTent: speedByTent(byPost),
      spark: spark.map(({ day, ...b }) => ({ ...b, night: day })),
    }));
  }
  if (s.calls) {
    out.calls = {
      total: s.calls.total,
      prevTotal: s.calls.prevTotal,
      buckets: s.calls.buckets.map((b): CallsBucket => ({ at: b.at, night: b.day, prev: b.prev, ...tentCounts(b.posts, b.n) })),
    };
  }
  if (s.heat) {
    out.heat = {
      step: s.heat.step,
      cols: s.heat.cols.map((c): HeatCol => ({ ...(c.at !== undefined ? { at: c.at } : {}), ...(c.hour !== undefined ? { hour: c.hour } : {}), ...tentCounts(c.posts, c.n) })),
    };
  }
  return out;
}

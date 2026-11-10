// Pure helpers for Dashboard v4 (design/screens/dashboard-v4.html) on the events stats (lp_stats(event, range),
// lib/api-types EventStats): urgency, colours, buckets, axis labels and the clock in the event's time zone. Any number
// of posts: the server sends the four busiest of the range by name, then 'Other', and every breakdown in that order;
// each gets a colour from one fixed categorical order. Unit-tested in tests/unit/dashboard/dashboard-model.test.ts.
import type { EventConfig, EventStats, EventStatsRange, PostCount } from '@/lib/api-types';

/** Shown for a value the server did not send or could not compute. */
export const NO_VALUE = '—';

export type Sev = 'ok' | 'warn' | 'crit';
export type AttentionItem = NonNullable<EventStats['attention']>['items'][number];
export type SpeedStat = NonNullable<EventStats['speed']>[number];
export type CallsBucket = NonNullable<EventStats['calls']>['buckets'][number];
export type HeatCol = NonNullable<EventStats['heat']>['cols'][number];

// ---- posts ------------------------------------------------------------------------------------------------

/** The server's catch-all after the four busiest posts. */
export const OTHER_SERIES = 'Other';
/** Categorical colours in a fixed order (dashboard.module.css --dv-post-*): the busiest post first; Other its own. */
const POST_COLORS = ['var(--dv-post-1)', 'var(--dv-post-2)', 'var(--dv-post-3)', 'var(--dv-post-4)'] as const;
const OTHER_COLOR = 'var(--dv-post-other)';

export interface Series {
  post: string;
  color: string;
}

/** The range's posts (EventStats.range.posts, busiest first, then Other) with their colours. */
export function postSeries(posts: readonly PostCount[] | undefined): Series[] {
  let i = 0;
  return (posts ?? []).map((p) => ({ post: p.post, color: p.post === OTHER_SERIES ? OTHER_COLOR : (POST_COLORS[i++] ?? OTHER_COLOR) }));
}

/** One post's count in a breakdown (0 when it is not there). */
export const countOf = (posts: readonly PostCount[] | undefined, post: string): number => posts?.find((p) => p.post === post)?.n ?? 0;

/** Waiting and Located: fine under 10 minutes, late from 10, red from 30. */
export const ageSev = (min: number): Sev => (min < 10 ? 'ok' : min < 30 ? 'warn' : 'crit');
/** A re-check past due: late at once, red from 10 minutes over. */
export const overSev = (min: number): Sev => (min < 10 ? 'warn' : 'crit');
/** A median against its target: on target, up to 1.5 × over, further over. */
export const gaugeSev = (v: number | null | undefined, target: number): Sev | null =>
  typeof v !== 'number' ? null : v <= target ? 'ok' : v <= target * 1.5 ? 'warn' : 'crit';

/** Minutes as m:ss, or h:mm:ss from an hour; never negative. */
export function mmss(min: number): string {
  const s = Math.max(0, Math.floor(min * 60));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A median in minutes: one decimal under 100 ("10.5"), whole above. */
export const fmtM = (x: number | null | undefined): string => (typeof x !== 'number' ? NO_VALUE : x < 100 ? x.toFixed(1) : String(Math.round(x)));

// ---- live status ---------------------------------------------------------------------------------------

export interface StatusPart {
  k: 'waiting' | 'pending' | 'located';
  name: string;
  n: number;
}

/** Open, split: v4's live counts, or (a database before v4) Waiting and In medical. */
export function statusParts(stats: Pick<EventStats, 'open' | 'live'>): StatusPart[] {
  const live = stats.live ?? { waiting: stats.open.waiting, pending: 0, located: stats.open.inMedical };
  return [
    { k: 'waiting', name: 'Waiting', n: live.waiting },
    { k: 'pending', name: 'Pending', n: live.pending },
    { k: 'located', name: 'Located', n: live.located },
  ];
}

/** The bar's boundary values (Tremor CategoryBar): 0, each running total, the whole; one too close to the last is dropped. */
export function boundaries(parts: readonly StatusPart[]): number[] {
  const open = parts.reduce((a, p) => a + p.n, 0);
  const cuts = [0];
  let run = 0;
  for (const p of parts) {
    run += p.n;
    if (p.n > 0 && run - cuts[cuts.length - 1]! >= Math.max(1, open * 0.08)) cuts.push(run);
  }
  if (cuts[cuts.length - 1] !== open) cuts[cuts.length - 1] = open;
  return cuts;
}

// ---- needs attention --------------------------------------------------------------------------------------

/** (Companion) lp_stats adds kind 'swap' (Friend swap requested, since the request) to Needs attention. */
export type AttentionKind = AttentionItem['kind'] | 'swap';
export type AttentionInput = Omit<AttentionItem, 'kind'> & { kind: AttentionKind };

export interface AttentionRow extends AttentionInput {
  /** Minutes since `since`. */
  t: number;
  sev: Sev;
  /** Minutes past the point the row turns red: one order for the three kinds. */
  score: number;
  /** Minutes until the friend's ETA (0 when due), or null. */
  eta: number | null;
}

/**
 * Most urgent first; waiting and located turn red 30 minutes in, an overdue re-check 10 minutes past due, (post-event)
 * a swap request 10 minutes after it was asked (lp_stats(text) scores it the same way).
 */
export function attentionRows(items: readonly AttentionInput[], now: number): AttentionRow[] {
  return items
    .map((it) => {
      const t = (now - Date.parse(it.since)) / 60_000;
      const re = it.kind === 'recheck' || it.kind === 'swap';
      const eta = it.enroute && it.etaAt ? Math.max(0, Math.ceil((Date.parse(it.etaAt) - now) / 60_000)) : null;
      return { ...it, t, sev: re ? overSev(t) : ageSev(t), score: t - (re ? 10 : 30), eta };
    })
    .sort((a, b) => b.score - a.score || a.caseNumber - b.caseNumber);
}

/** The timer pill: "+6:00" past a re-check's due time, else the age. */
export const timerText = (row: Pick<AttentionRow, 'kind' | 't'>): string => (row.kind === 'recheck' ? `+${mmss(row.t)}` : mmss(row.t));

export function attentionPhrase(row: AttentionRow): string {
  const mins = Math.floor(row.t);
  const what =
    row.kind === 'wait'
      ? `waiting ${mins} minutes for a first check`
      : row.kind === 'swap'
        ? `friend swap requested ${mins} minutes ago`
      : row.kind === 'recheck'
        ? `re-check overdue by ${mins} minutes`
        : `located ${mins} minutes ago, friend not here yet${row.enroute ? `, on the way${row.eta !== null ? `, about ${row.eta} minutes out` : ''}` : ''}`;
  return `Request ${row.caseNumber} at ${row.post}, ${what}`;
}

// ---- speed ------------------------------------------------------------------------------------------------

export const SPEED_LABEL: Readonly<Record<SpeedStat['key'], string>> = { firstCheck: 'First check', located: 'Located', reunited: 'Reunited' };
export const SPEED_TARGET: Readonly<Record<SpeedStat['key'], number>> = { firstCheck: 10, located: 15, reunited: 30 };

/** The badge beside a median: its severity and the signed distance from the target ("+0.5", "−3.8"). */
export function speedBadge(s: Pick<SpeedStat, 'median' | 'target'>): { sev: Sev; delta: string } | null {
  const sev = gaugeSev(s.median, s.target);
  if (sev === null || typeof s.median !== 'number') return null;
  const d = s.median - s.target;
  return { sev, delta: `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}` };
}

// ---- calls and the heatmap -----------------------------------------------------------------------------------

export const bucketTotal = (c: Pick<CallsBucket, 'n'>): number => c.n;

/** The busiest bucket (first of equals), or -1 when all are empty. */
export function peakIndex(buckets: ReadonlyArray<Pick<CallsBucket, 'n'>>): number {
  let peak = -1;
  let max = 0;
  buckets.forEach((b, i) => {
    const t = bucketTotal(b);
    if (t > max) {
      max = t;
      peak = i;
    }
  });
  return peak;
}

/** At most two gridlines above the baseline. */
export function sparseStep(max: number): number {
  for (const s of [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 500]) if (Math.ceil(max / s) <= 2) return s;
  return 1000;
}

/** The heat ramp step (1–5) of a cell; 0 = empty. */
export const heatBin = (v: number, max: number): number => (v <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil((v / Math.max(1, max)) * 5))));

/** The bucket still filling (drawn dashed). */
export const isCurrent = (b: Pick<CallsBucket, 'at'>, stepMin: number, now: number): boolean => Date.parse(b.at) + stepMin * 60_000 > now;

// ---- clock (the event's time zone) -----------------------------------------------------------------------------

const clocks = new Map<string, { parts: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat }>();

/** Hour (0–23), minute and short weekday of a time, in the event's time zone (EventConfig.timezone). */
export function etClock(iso: string | number, tz: string): { h: number; m: number; wd: string } {
  let f = clocks.get(tz);
  if (!f) {
    f = {
      parts: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }),
      weekday: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }),
    };
    clocks.set(tz, f);
  }
  const d = new Date(iso);
  const p = f.parts.formatToParts(d);
  const n = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
  return { h: n('hour') % 24, m: n('minute'), wd: f.weekday.format(d) };
}

const h12 = (h: number) => (h % 12 === 0 ? 12 : h % 12);
/** "10p", "2a". */
export const hourShort = (h: number): string => `${h12(h)}${h < 12 ? 'a' : 'p'}`;
/** "10:15". */
export const clockHM = (h: number, m: number): string => `${h12(h)}:${String(m).padStart(2, '0')}`;
/** "10:15 PM". */
export const clockFull = (h: number, m: number): string => `${clockHM(h, m)} ${h < 12 ? 'AM' : 'PM'}`;

/** The weekday of a show day ("2026-11-07" → "Sat"): a calendar date, whatever the zone. */
export function dayName(day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${day}T12:00:00Z`));
}

/** The show day before the range's start, for the dashed line's key ("Sat"): the weekday a day earlier. */
export function prevDayName(fromIso: string, tz: string): string {
  return etClock(Date.parse(fromIso) - 24 * 3_600_000 + 60_000, tz).wd;
}

/** 'today' and a single show day draw a day of 15-minute buckets; 'event' draws hours over every show day. */
const isDayRange = (range: EventStatsRange) => range === 'today' || range.startsWith('day:');

/**
 * The calls chart's x labels: which buckets get one, and its text (design: half hours, hours, every 2nd / 3rd hour,
 * show days).
 */
export function axisLabel(range: EventStatsRange, b: CallsBucket, i: number, buckets: readonly CallsBucket[], phone: boolean, tz: string): string | null {
  if (range === 'event') return b.day && (i === 0 || buckets[i - 1]!.day !== b.day) ? dayName(b.day) : null;
  const { h, m } = etClock(b.at, tz);
  if (range === '1h') return m % 30 === 0 ? clockHM(h, m) : null;
  if (range === '2h') return m === 0 ? clockHM(h, m) : null;
  if (range === '6h') return m === 0 && h % 2 === 0 ? hourShort(h) : null;
  return isDayRange(range) && m === 0 && h % (phone ? 3 : 2) === 0 ? hourShort(h) : null;
}

/** A heat column's label: "10:15" (15-min columns), else "10p". */
export function heatLabel(col: Pick<HeatCol, 'at' | 'hour'>, step: number, tz: string): string {
  if (typeof col.hour === 'number') return hourShort(col.hour);
  const { h, m } = etClock(col.at!, tz);
  return step === 15 ? clockHM(h, m) : hourShort(h);
}

/** A calls tooltip's head: "10:15–10:30 PM", or "Sat 10 PM" for an event hour. */
export function bucketHead(range: EventStatsRange, b: CallsBucket, stepMin: number, tz: string): string {
  const s = etClock(b.at, tz);
  if (range === 'event') return `${b.day ? dayName(b.day) : s.wd} ${h12(s.h)} ${s.h < 12 ? 'AM' : 'PM'}`;
  const e = etClock(Date.parse(b.at) + stepMin * 60_000, tz);
  return `${clockHM(s.h, s.m)}–${clockFull(e.h, e.m)}`;
}

// ---- show days (an archived event's day tabs) -------------------------------------------------------------------

/** The event's show days, from startsOn to endsOn: [{n: 1, day: '2026-11-06', name: 'Fri'}, …] (at most 31). */
export function showDays(event: Pick<EventConfig, 'startsOn' | 'endsOn'> | null | undefined): Array<{ n: number; day: string; name: string }> {
  if (!event) return [];
  const start = Date.parse(`${event.startsOn}T12:00:00Z`);
  const end = Date.parse(`${event.endsOn}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: Array<{ n: number; day: string; name: string }> = [];
  for (let t = start, n = 1; t <= end && n <= 31; t += 86_400_000, n += 1) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ n, day, name: dayName(day) });
  }
  return out;
}

// ---- who's on ---------------------------------------------------------------------------------------------------

/** A who's-on team id's name: the event's short name for one of its teams, 'Other' for anyone else. */
export function teamName(id: string, event: Pick<EventConfig, 'teams'> | null | undefined): string {
  if (id === 'other') return 'Other';
  return event?.teams.find((t) => t.id === id)?.short ?? id;
}

/** The order who's on lists teams in: the event's setup order, then Other. */
export function teamOrder(event: Pick<EventConfig, 'teams'> | null | undefined): string[] {
  return [...(event?.teams.map((t) => t.id) ?? []), 'other'];
}

export const teamTotal = (team: ReadonlyArray<{ on: number }> | undefined): number => (team ?? []).reduce((a, t) => a + t.on, 0);

// ---- recap ---------------------------------------------------------------------------------------------------------

/** ↑ / ↓ against the night before ("↑11", "↑1.6"); null when level or unknown. */
export function delta(cur: number | null | undefined, prev: number | null | undefined, decimals = 0): { glyph: '↑' | '↓'; text: string; d: number } | null {
  if (typeof cur !== 'number' || typeof prev !== 'number') return null;
  const d = cur - prev;
  if (Math.abs(d) < (decimals ? 0.05 : 1)) return null;
  return { glyph: d > 0 ? '↑' : '↓', text: Math.abs(d).toFixed(decimals), d };
}

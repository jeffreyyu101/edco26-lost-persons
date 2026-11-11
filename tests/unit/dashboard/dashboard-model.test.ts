// Dashboard v4 pure helpers (components/dashboard/dashboard-model.ts): urgency order and colours, the status bar,
// buckets and axis labels in the event's time zone, speed badges, recap deltas, (events) post series for any number
// of posts, show days, team names.
import { describe, expect, it } from 'vitest';
import {
  ageSev,
  attentionPhrase,
  attentionRows,
  axisLabel,
  boundaries,
  bucketHead,
  delta,
  etClock,
  fmtM,
  gaugeSev,
  heatBin,
  heatLabel,
  isCurrent,
  mmss,
  dayName,
  overSev,
  peakIndex,
  postSeries,
  prevDayName,
  showDays,
  teamName,
  teamOrder,
  sparseStep,
  speedBadge,
  statusParts,
  teamTotal,
  timerText,
} from '@/components/dashboard/dashboard-model';
import type { AttentionItem, CallsBucket } from '@/lib/api-types';

const ET = 'America/New_York';

const NOW = Date.parse('2026-11-09T03:40:00Z'); // Sun 22:40 ET
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const item = (caseNumber: number, kind: AttentionItem['kind'], minutes: number, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id: `id-${caseNumber}`,
  caseNumber,
  post: 'FA 3',
  kind,
  since: ago(minutes),
  enroute: false,
  etaAt: null,
  ...extra,
});
const bucket = (at: string, fa4 = 0, fa3 = 0, other = 0, extra: Partial<CallsBucket> = {}): CallsBucket => ({
  at,
  day: null,
  n: fa4 + fa3 + other,
  posts: [
    { post: 'FA 4', n: fa4 },
    { post: 'FA 3', n: fa3 },
    { post: 'Other', n: other },
  ],
  prev: null,
  ...extra,
});

describe('severity: colour always comes with a glyph, and these decide which', () => {
  it('waiting / located age: ok < 10 ≤ warn < 30 ≤ crit; a re-check is late at once, red 10 min past due', () => {
    expect([0, 9.9, 10, 29.9, 30].map(ageSev)).toEqual(['ok', 'ok', 'warn', 'warn', 'crit']);
    expect([0, 9.9, 10].map(overSev)).toEqual(['warn', 'warn', 'crit']);
  });
  it('a median against its target: ok ≤ target, warn ≤ 1.5 ×, crit above; null without data', () => {
    expect(gaugeSev(10, 10)).toBe('ok');
    expect(gaugeSev(15, 10)).toBe('warn');
    expect(gaugeSev(15.1, 10)).toBe('crit');
    expect(gaugeSev(null, 10)).toBeNull();
    expect(speedBadge({ median: 10.5, target: 10 })).toEqual({ sev: 'warn', delta: '+0.5' });
    expect(speedBadge({ median: 11.2, target: 15 })).toEqual({ sev: 'ok', delta: '−3.8' });
    expect(speedBadge({ median: null, target: 30 })).toBeNull();
  });
});

describe('needs attention', () => {
  it('one urgency order for the three kinds: minutes past the point each turns red', () => {
    const rows = attentionRows(
      [
        item(1142, 'wait', 33.8 + 0.5 / 60), // 3.8 past red
        item(1136, 'recheck', 15), // 5 past red
        item(1137, 'located', 38, { enroute: true, etaAt: new Date(NOW + 90_000).toISOString() }), // 8 past red
        item(1138, 'recheck', 6), // 4 before red
        item(1139, 'located', 25.5), // 4.5 before red
      ],
      NOW,
    );
    expect(rows.map((r) => r.caseNumber)).toEqual([1137, 1136, 1142, 1138, 1139]);
    expect(rows.map((r) => r.sev)).toEqual(['crit', 'crit', 'crit', 'warn', 'warn']);
    expect(rows.map(timerText)).toEqual(['38:00', '+15:00', '33:48', '+6:00', '25:30']);
    expect(rows[0]!.eta).toBe(2);
    expect(rows[4]!.eta).toBeNull();
  });
  it('(post-event) a swap request turns red 10 minutes after it was asked, as lp_stats scores it', () => {
    const rows = attentionRows([item(1001, 'wait', 25), item(1002, 'swap', 12), item(1003, 'swap', 5)], NOW);
    expect(rows.map((r) => [r.caseNumber, r.sev])).toEqual([
      [1002, 'crit'],
      [1001, 'warn'],
      [1003, 'warn'],
    ]);
    expect(timerText(rows[0]!)).toBe('12:00');
  });
  it('ties keep the lower case number first; the spoken row says everything', () => {
    const rows = attentionRows([item(1002, 'wait', 12), item(1001, 'wait', 12)], NOW);
    expect(rows.map((r) => r.caseNumber)).toEqual([1001, 1002]);
    expect(attentionPhrase(rows[0]!)).toBe('Request 1001 at FA 3, waiting 12 minutes for a first check');
    const loc = attentionRows([item(1003, 'located', 4, { enroute: true, etaAt: new Date(NOW + 4 * 60_000).toISOString() })], NOW)[0]!;
    expect(attentionPhrase(loc)).toBe('Request 1003 at FA 3, located 4 minutes ago, friend not here yet, on the way, about 4 minutes out');
  });
  it('timers: m:ss, h:mm:ss from an hour, never negative', () => {
    expect(mmss(0)).toBe('0:00');
    expect(mmss(3 + 11 / 60)).toBe('3:11');
    expect(mmss(75.5)).toBe('1:15:30');
    expect(mmss(-2)).toBe('0:00');
  });
});

describe('status bar', () => {
  it('Waiting / Pending / Located from v4 live counts, or Waiting + In medical from an older server', () => {
    expect(statusParts({ open: { waiting: 10, inMedical: 5 }, live: { waiting: 6, pending: 4, located: 5 } }).map((p) => p.n)).toEqual([6, 4, 5]);
    expect(statusParts({ open: { waiting: 10, inMedical: 5 } }).map((p) => p.n)).toEqual([10, 0, 5]);
  });
  it('boundary values: 0, each running total, the whole; one too close to the last is dropped', () => {
    expect(boundaries(statusParts({ open: { waiting: 0, inMedical: 0 }, live: { waiting: 6, pending: 4, located: 5 } }))).toEqual([0, 6, 10, 15]);
    expect(boundaries(statusParts({ open: { waiting: 0, inMedical: 0 }, live: { waiting: 30, pending: 1, located: 0 } }))).toEqual([0, 31]);
    expect(boundaries(statusParts({ open: { waiting: 0, inMedical: 0 }, live: { waiting: 0, pending: 0, located: 0 } }))).toEqual([0]);
  });
});

describe('calls buckets and labels (ET)', () => {
  it('the peak is the first busiest bucket; empty ranges have none', () => {
    expect(peakIndex([bucket('a', 1), bucket('b', 2, 1), bucket('c', 3)])).toBe(1);
    expect(peakIndex([bucket('a'), bucket('b')])).toBe(-1);
  });
  it('at most two gridlines; heat bins 0–5 against the busiest cell', () => {
    expect([1, 2, 3, 4, 6, 8, 9, 40].map(sparseStep)).toEqual([1, 1, 2, 2, 4, 4, 5, 20]);
    expect([0, 1, 5, 6, 10].map((v) => heatBin(v, 10))).toEqual([0, 1, 3, 3, 5]);
  });
  it('the bucket still filling is the one that ends after now', () => {
    expect(isCurrent({ at: ago(10) }, 15, NOW)).toBe(true);
    expect(isCurrent({ at: ago(15) }, 15, NOW)).toBe(false);
  });
  it("clock and labels in the event's time zone, whatever the device zone", () => {
    expect(etClock('2026-11-09T03:15:00Z', ET)).toEqual({ h: 22, m: 15, wd: 'Sun' });
    const b = bucket('2026-11-09T03:00:00Z');
    expect(axisLabel('today', b, 0, [b], false, ET)).toBe('10p');
    expect(axisLabel('today', b, 0, [b], true, ET)).toBeNull(); // every 3rd hour on a phone
    expect(axisLabel('day:2', b, 0, [b], false, ET)).toBe('10p'); // a show day of an archived event, like today
    expect(axisLabel('2h', b, 0, [b], false, ET)).toBe('10:00');
    expect(axisLabel('1h', bucket('2026-11-09T03:30:00Z'), 0, [b], false, ET)).toBe('10:30');
    expect(axisLabel('6h', bucket('2026-11-09T02:00:00Z'), 0, [b], false, ET)).toBeNull();
    expect(bucketHead('today', bucket('2026-11-09T03:15:00Z'), 15, ET)).toBe('10:15–10:30 PM');
    expect(heatLabel({ hour: 0 }, 60, ET)).toBe('12a');
    expect(heatLabel({ at: '2026-11-09T03:15:00Z' }, 15, ET)).toBe('10:15');
  });
  it('(events) another time zone: the same instant reads in that zone (Los Angeles, Berlin)', () => {
    expect(etClock('2026-11-09T03:15:00Z', 'America/Los_Angeles')).toEqual({ h: 19, m: 15, wd: 'Sun' });
    expect(etClock('2026-11-09T03:15:00Z', 'Europe/Berlin')).toEqual({ h: 4, m: 15, wd: 'Mon' });
    expect(bucketHead('today', bucket('2026-11-09T03:15:00Z'), 15, 'Europe/Berlin')).toBe('4:15–4:30 AM');
    expect(axisLabel('today', bucket('2026-11-09T05:00:00Z'), 0, [], false, 'Europe/Berlin')).toBe('6a');
  });
  it('event: a label at the first bucket of each show day, named by its weekday; the day before a range', () => {
    const bs = [bucket('2026-11-07T18:00:00Z', 0, 0, 0, { day: '2026-11-07' }), bucket('2026-11-07T19:00:00Z', 0, 0, 0, { day: '2026-11-07' }), bucket('2026-11-08T18:00:00Z', 0, 0, 0, { day: '2026-11-08' })];
    expect(bs.map((b, i) => axisLabel('event', b, i, bs, false, ET))).toEqual(['Sat', null, 'Sun']);
    expect(dayName('2026-11-06')).toBe('Fri');
    // A show day from 6 AM local: the range of Sunday's day starts Sun 06:00 ET; the day before is Saturday.
    expect(prevDayName('2026-11-08T11:00:00Z', ET)).toBe('Sat');
    // From noon (the local test event's day start), the same.
    expect(prevDayName('2026-11-08T17:00:00Z', ET)).toBe('Sat');
  });
});

describe('(events) posts, show days and teams come from the event', () => {
  it("any number of posts: the range's order (busiest first), one fixed colour per place, Other its own", () => {
    expect(postSeries([{ post: 'Gate A', n: 9 }])).toEqual([{ post: 'Gate A', color: 'var(--dv-post-1)' }]);
    const six = postSeries([
      { post: 'P2', n: 12 },
      { post: 'P5', n: 9 },
      { post: 'P1', n: 7 },
      { post: 'P6', n: 3 },
      { post: 'Other', n: 4 },
    ]);
    expect(six.map((x) => x.post)).toEqual(['P2', 'P5', 'P1', 'P6', 'Other']);
    expect(six.map((x) => x.color)).toEqual(['var(--dv-post-1)', 'var(--dv-post-2)', 'var(--dv-post-3)', 'var(--dv-post-4)', 'var(--dv-post-other)']);
    expect(postSeries(undefined)).toEqual([]);
  });
  it("the show days of an event's dates, at most a month", () => {
    expect(showDays({ startsOn: '2026-11-06', endsOn: '2026-11-08' })).toEqual([
      { n: 1, day: '2026-11-06', name: 'Fri' },
      { n: 2, day: '2026-11-07', name: 'Sat' },
      { n: 3, day: '2026-11-08', name: 'Sun' },
    ]);
    expect(showDays({ startsOn: '2026-11-14', endsOn: '2026-11-14' })).toHaveLength(1);
    expect(showDays({ startsOn: '2026-11-14', endsOn: '2026-11-13' })).toEqual([]);
    expect(showDays(null)).toEqual([]);
  });
  it("who's on names the event's teams by id (setup order, then Other)", () => {
    const event = { teams: [{ id: 'medics', label: 'Medics Crew', short: 'Medics', medical: true }, { id: 'gate', label: 'Gate Team', short: 'Gate', medical: false }] };
    expect(teamOrder(event)).toEqual(['medics', 'gate', 'other']);
    expect(teamName('gate', event)).toBe('Gate');
    expect(teamName('other', event)).toBe('Other');
    expect(teamName('dispatch', event)).toBe('dispatch');
  });
});

describe('recap and team', () => {
  it('↑ / ↓ against the night before; nothing when level or unknown', () => {
    expect(delta(32, 21)).toEqual({ glyph: '↑', text: '11', d: 11 });
    expect(delta(6.5, 4.9, 1)?.text).toBe('1.6');
    expect(delta(4, 4)).toBeNull();
    expect(delta(4, null)).toBeNull();
    expect(fmtM(10.46)).toBe('10.5');
    expect(fmtM(123.4)).toBe('123');
    expect(fmtM(null)).toBe('—');
  });
  it('who is on: the sum over teams', () => {
    expect(teamTotal([{ on: 6 }, { on: 2 }, { on: 1 }, { on: 0 }])).toBe(9);
    expect(teamTotal(undefined)).toBe(0);
  });
});

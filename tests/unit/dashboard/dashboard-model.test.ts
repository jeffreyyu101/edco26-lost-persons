// Dashboard v4 pure helpers (components/dashboard/dashboard-model.ts): urgency order and colours, the status bar,
// buckets and axis labels in ET, speed badges, recap deltas.
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
  nightName,
  overSev,
  peakIndex,
  prevNightName,
  sparseStep,
  speedBadge,
  statusParts,
  teamTotal,
  timerText,
} from '@/components/dashboard/dashboard-model';
import type { AttentionItem, CallsBucket } from '@/lib/api-types';

const NOW = Date.parse('2026-11-09T03:40:00Z'); // Sun 22:40 ET
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const item = (caseNumber: number, kind: AttentionItem['kind'], minutes: number, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id: `id-${caseNumber}`,
  caseNumber,
  tent: 'FA 3',
  kind,
  since: ago(minutes),
  enroute: false,
  etaAt: null,
  ...extra,
});
const bucket = (at: string, fa4 = 0, fa3 = 0, other = 0, extra: Partial<CallsBucket> = {}): CallsBucket => ({ at, night: null, fa4, fa3, other, prev: null, ...extra });

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
  it('clock and labels in America/New_York, whatever the device zone', () => {
    expect(etClock('2026-11-09T03:15:00Z')).toEqual({ h: 22, m: 15, wd: 'Sun' });
    const b = bucket('2026-11-09T03:00:00Z');
    expect(axisLabel('tonight', b, 0, [b], false)).toBe('10p');
    expect(axisLabel('tonight', b, 0, [b], true)).toBeNull(); // every 3rd hour on a phone
    expect(axisLabel('2h', b, 0, [b], false)).toBe('10:00');
    expect(axisLabel('1h', bucket('2026-11-09T03:30:00Z'), 0, [b], false)).toBe('10:30');
    expect(axisLabel('6h', bucket('2026-11-09T02:00:00Z'), 0, [b], false)).toBeNull();
    expect(bucketHead('tonight', bucket('2026-11-09T03:15:00Z'), 15)).toBe('10:15–10:30 PM');
    expect(heatLabel({ fa4: 0, fa3: 0, other: 0, hour: 0 }, 60)).toBe('12a');
    expect(heatLabel({ fa4: 0, fa3: 0, other: 0, at: '2026-11-09T03:15:00Z' }, 15)).toBe('10:15');
  });
  it('event: a label at the first bucket of each night, named by its weekday; the night before a range', () => {
    const bs = [bucket('2026-11-07T18:00:00Z', 0, 0, 0, { night: '2026-11-07' }), bucket('2026-11-07T19:00:00Z', 0, 0, 0, { night: '2026-11-07' }), bucket('2026-11-08T18:00:00Z', 0, 0, 0, { night: '2026-11-08' })];
    expect(bs.map((b, i) => axisLabel('event', b, i, bs, false))).toEqual(['Sat', null, 'Sun']);
    expect(nightName('2026-11-06')).toBe('Fri');
    expect(prevNightName('2026-11-08T17:00:00Z')).toBe('Sat'); // Tonight (Sun from noon) → Saturday
    expect(prevNightName('2026-11-09T05:30:00Z')).toBe('Sat'); // 00:30 Mon is still Sunday night
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

import { describe, expect, it } from 'vitest';
import {
  NO_VALUE,
  agoPhrase,
  barPercent,
  closedSubline,
  closedSublinePhrase,
  closedTotal,
  countParts,
  durationParts,
  durationPhrase,
  formatAgo,
  postsBusiestFirst,
} from '@/components/dashboard/dashboard-model';

describe('dashboard model', () => {
  it('splits durations into big digits and a small unit, and null when unknown', () => {
    expect(durationParts(null)).toBeNull();
    expect(durationParts(undefined)).toBeNull();
    expect(durationParts(Number.NaN)).toBeNull();
    expect(durationParts(-3)).toBeNull();
    expect(durationParts(0)).toEqual([{ value: '<1', unit: 'm' }]);
    expect(durationParts(0.4)).toEqual([{ value: '<1', unit: 'm' }]);
    expect(durationParts(9.4)).toEqual([{ value: '9', unit: 'm' }]);
    expect(durationParts(24)).toEqual([{ value: '24', unit: 'm' }]);
    expect(durationParts(60)).toEqual([{ value: '1', unit: 'h' }]);
    expect(durationParts(95)).toEqual([
      { value: '1', unit: 'h' },
      { value: '35', unit: 'm' },
    ]);
    expect(NO_VALUE).toBe('—');
  });

  it('says durations in words for screen readers', () => {
    expect(durationPhrase(null)).toBeNull();
    expect(durationPhrase(0.2)).toBe('under a minute');
    expect(durationPhrase(1)).toBe('1 minute');
    expect(durationPhrase(24)).toBe('24 minutes');
    expect(durationPhrase(60)).toBe('1 hour');
    expect(durationPhrase(95)).toBe('1 hour 35 minutes');
    expect(durationPhrase(121)).toBe('2 hours 1 minute');
  });

  it('counts: digits only, null when missing (the v2.2 server half may not be deployed yet)', () => {
    expect(countParts(6)).toEqual([{ value: '6', unit: '' }]);
    expect(countParts(0)).toEqual([{ value: '0', unit: '' }]);
    expect(countParts(undefined)).toBeNull();
    expect(countParts(null)).toBeNull();
  });

  it('Closed = Not found in medical + Reunited + Discharged + Cancelled', () => {
    expect(closedTotal({ notInMedical: 2, reunited: 2, discharged: 1, cancelled: 1 })).toBe(6);
    expect(closedTotal({ notInMedical: 0, reunited: 0, discharged: 0, cancelled: 0 })).toBe(0);
  });

  it('builds the Reunited tile subline only when discharged or cancelled is non-zero', () => {
    expect(closedSubline({ discharged: 1, cancelled: 1 })).toBe('+1 discharged · 1 cancelled');
    expect(closedSubline({ discharged: 0, cancelled: 2 })).toBe('+2 cancelled');
    expect(closedSubline({ discharged: 3, cancelled: 0 })).toBe('+3 discharged');
    expect(closedSubline({ discharged: 0, cancelled: 0 })).toBeNull();
    expect(closedSublinePhrase({ discharged: 1, cancelled: 1 })).toBe('plus 1 discharged and 1 cancelled');
    expect(closedSublinePhrase({ discharged: 0, cancelled: 0 })).toBeNull();
  });

  it('formats last-updated times like the log: now, 2m, 1h, 3d', () => {
    const now = Date.parse('2026-11-07T04:10:00Z');
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    expect(formatAgo(ago(0), now)).toBe('now');
    expect(formatAgo(ago(0.9), now)).toBe('now');
    expect(formatAgo(ago(2), now)).toBe('2m');
    expect(formatAgo(ago(59), now)).toBe('59m');
    expect(formatAgo(ago(60), now)).toBe('1h');
    expect(formatAgo(ago(125), now)).toBe('2h');
    expect(formatAgo(ago(23 * 60 + 59), now)).toBe('23h');
    expect(formatAgo(ago(24 * 60), now)).toBe('1d');
    expect(formatAgo(ago(3 * 24 * 60 + 5), now)).toBe('3d');
    // A clock a little ahead of the server never shows a negative time.
    expect(formatAgo(new Date(now + 30_000).toISOString(), now)).toBe('now');
    expect(agoPhrase(ago(0), now)).toBe('just now');
    expect(agoPhrase(ago(1), now)).toBe('1 minute ago');
    expect(agoPhrase(ago(2), now)).toBe('2 minutes ago');
    expect(agoPhrase(ago(60), now)).toBe('1 hour ago');
    expect(agoPhrase(ago(3 * 24 * 60), now)).toBe('3 days ago');
  });

  it('sizes bars against the busiest post on a full-width track', () => {
    expect(barPercent(4, 4)).toBe(100);
    expect(barPercent(2, 4)).toBe(50);
    expect(barPercent(1, 3)).toBe(33.3);
    expect(barPercent(0, 4)).toBe(0);
    expect(barPercent(1, 0)).toBe(0);
    expect(barPercent(5, 4)).toBe(100);
  });

  it('sorts posts busiest first, keeping the server order for ties', () => {
    const posts = [
      { id: 'FA 3', count: 3 },
      { id: 'FA 4', count: 3 },
      { id: 'Command', count: 1 },
      { id: 'Base', count: 0 },
      { id: 'Other · Gate 9', count: 4 },
    ];
    expect(postsBusiestFirst(posts).map((p) => p.id)).toEqual(['Other · Gate 9', 'FA 3', 'FA 4', 'Command', 'Base']);
    // The input is left alone.
    expect(posts[0]?.id).toBe('FA 3');
  });
});

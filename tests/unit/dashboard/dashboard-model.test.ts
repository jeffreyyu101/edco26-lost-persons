import { describe, expect, it } from 'vitest';
import { barPercent, closedSubline, formatAgo, formatMinutes } from '@/components/dashboard/dashboard-model';

describe('dashboard model', () => {
  it('formats tile minutes', () => {
    expect(formatMinutes(null)).toBe('–');
    expect(formatMinutes(undefined)).toBe('–');
    expect(formatMinutes(Number.NaN)).toBe('–');
    expect(formatMinutes(0)).toBe('<1m');
    expect(formatMinutes(0.4)).toBe('<1m');
    expect(formatMinutes(9.4)).toBe('9m');
    expect(formatMinutes(24)).toBe('24m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(95)).toBe('1h 35m');
  });

  it('builds the Reunited tile subline', () => {
    expect(closedSubline({ discharged: 1, cancelled: 1 })).toBe('+1 discharged, 1 cancelled');
    expect(closedSubline({ discharged: 0, cancelled: 2 })).toBe('+2 cancelled');
    expect(closedSubline({ discharged: 3, cancelled: 0 })).toBe('+3 discharged');
    expect(closedSubline({ discharged: 0, cancelled: 0 })).toBeNull();
  });

  it('formats Recently updated times', () => {
    const now = Date.parse('2026-11-07T04:10:00Z');
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    expect(formatAgo(ago(0), now, 'America/New_York')).toBe('now');
    expect(formatAgo(ago(2), now, 'America/New_York')).toBe('2m');
    expect(formatAgo(ago(125), now, 'America/New_York')).toBe('2h');
    // Older than 12 h: the list format in the event timezone (a different day gets the weekday).
    expect(formatAgo('2026-11-06T13:58:00Z', now, 'America/New_York')).toBe('8:58');
    expect(formatAgo('2026-11-06T03:58:00Z', now, 'America/New_York')).toBe('Thu 10:58');
  });

  it('sizes bars relative to the longest (82% of the track)', () => {
    expect(barPercent(4, 4)).toBe(82);
    expect(barPercent(2, 4)).toBe(41);
    expect(barPercent(0, 4)).toBe(0);
    expect(barPercent(1, 0)).toBe(0);
    expect(barPercent(5, 4)).toBe(82);
  });
});
